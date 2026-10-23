param(
  [ValidateSet('Prepare', 'Stop', 'Finish', 'Remove', 'UninstallPrevious')]
  [string] $Action,
  [string] $InstallDir,
  [string] $SidListFile,
  [ValidateSet('0', '1')]
  [string] $MigrationRequested = '0',
  [switch] $DefinitionsOnly
)

# Inherited pwsh/user module paths must not select installer cmdlets.
$env:PSModulePath = [IO.Path]::Combine($PSHOME, 'Modules')
Import-Module ([IO.Path]::Combine($PSHOME, 'Modules', 'Microsoft.PowerShell.Security', 'Microsoft.PowerShell.Security.psd1')) -ErrorAction Stop

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ($args.Count -ne 0) { throw 'Unexpected installer arguments; service and package names are compiled, not runtime options' }
$CompiledEditionJson = '{"version":1,"edition":"production","serviceName":"AnubisHost","installLeaf":"Anubis-Security-Tool","disableManaged":false}'

function Assert-InstallerEdition($Value) {
  $keys = @('version', 'edition', 'serviceName', 'installLeaf', 'disableManaged')
  if ($null -eq $Value -or @($Value.PSObject.Properties).Count -ne $keys.Count -or
      @($Value.PSObject.Properties.Name | Where-Object { $_ -cnotin $keys }).Count -ne 0 -or
      $Value.version -isnot [int] -or $Value.version -ne 1 -or
      $Value.edition -isnot [string] -or $Value.serviceName -isnot [string] -or
      $Value.installLeaf -isnot [string] -or
      $Value.disableManaged -isnot [bool]) {
    throw 'Invalid compiled installer edition schema'
  }
  $production = $Value.edition -ceq 'production' -and $Value.serviceName -ceq 'AnubisHost' -and
    $Value.installLeaf -ceq 'Anubis-Security-Tool' -and $Value.disableManaged -eq $false
  $qa = $Value.edition -ceq 'installer-qa-7e66c0f5' -and
    $Value.serviceName -ceq 'AnubisHost-QA-installer-7e66c0f5' -and
    $Value.installLeaf -ceq 'Anubis-Security-Tool-QA-installer-7e66c0f5' -and $Value.disableManaged -eq $true
  $migrationQa = $Value.edition -ceq 'migration-qa-7e66c0f5' -and
    $Value.serviceName -ceq 'AnubisHost-QA-migration-7e66c0f5' -and
    $Value.installLeaf -ceq 'Anubis-Security-Tool-QA-migration-7e66c0f5' -and $Value.disableManaged -eq $true
  if (-not $production -and -not $qa -and -not $migrationQa) { throw 'Unknown compiled installer edition' }
}

$CompiledEdition = $CompiledEditionJson | ConvertFrom-Json
Assert-InstallerEdition $CompiledEdition
$ServiceName = $CompiledEdition.serviceName
$InstallLeaf = $CompiledEdition.installLeaf
$TrustedSids = @('S-1-5-18', 'S-1-5-32-544', 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')
. (Join-Path $PSScriptRoot 'windows-user-migration.ps1')

function Read-AllowedUserSids([string] $File) {
  if (-not $File) { return '' }
  $value = [IO.File]::ReadAllText($File).Trim()
  if ($value -ne '' -and $value -notmatch '^S-1-5-21-[0-9]+-[0-9]+-[0-9]+-[0-9]+(,S-1-5-21-[0-9]+-[0-9]+-[0-9]+-[0-9]+)*$') {
    throw 'Allowed users must be an explicit comma-separated list of canonical account SIDs'
  }
  if ($value -ne '') {
    foreach ($sid in $value.Split(',')) {
      if ((New-Object Security.Principal.SecurityIdentifier($sid)).Value -cne $sid) {
        throw 'Allowed user SIDs must be canonical'
      }
    }
    if ($CompiledEdition.disableManaged -and $CompiledEdition.edition -cne 'migration-qa-7e66c0f5') {
      throw 'The isolated installer QA edition permits no user workers'
    }
  }
  return $value
}

function Get-NativeProgramFiles {
  if (-not ('AnubisInstaller.KnownFolders' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
namespace AnubisInstaller {
  public static class KnownFolders {
    [DllImport("shell32.dll")]
    static extern int SHGetKnownFolderPath(ref Guid id, uint flags, IntPtr token, out IntPtr path);
    public static string ProgramFiles() {
      var id = new Guid("6D809377-6AF0-444B-8957-A3773F02200E");
      IntPtr path;
      int result = SHGetKnownFolderPath(ref id, 0, IntPtr.Zero, out path);
      try {
        Marshal.ThrowExceptionForHR(result);
        return Marshal.PtrToStringUni(path);
      } finally {
        if (path != IntPtr.Zero) Marshal.FreeCoTaskMem(path);
      }
    }
    public static string ProgramData() {
      var id = new Guid("62AB5D82-FDC1-4DC3-A9DD-070D1D495D97");
      IntPtr path;
      int result = SHGetKnownFolderPath(ref id, 0, IntPtr.Zero, out path);
      try {
        Marshal.ThrowExceptionForHR(result);
        return Marshal.PtrToStringUni(path);
      } finally {
        if (path != IntPtr.Zero) Marshal.FreeCoTaskMem(path);
      }
    }
  }
}
'@
  }
  return [AnubisInstaller.KnownFolders]::ProgramFiles()
}

function Get-NativeProgramData {
  $null = Get-NativeProgramFiles
  return [AnubisInstaller.KnownFolders]::ProgramData()
}

function Assert-NotReparse([string] $Path) {
  $item = Get-Item -LiteralPath $Path -Force
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "Reparse points are forbidden: $Path"
  }
  return $item
}

function Assert-TrustedAcl([string] $Path, [switch] $AllowInstallerOwner) {
  $acl = Get-Acl -LiteralPath $Path
  $owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
  $installerSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  if ($TrustedSids -notcontains $owner -and -not ($AllowInstallerOwner -and $owner -eq $installerSid)) {
    throw "Untrusted owner: $Path"
  }
  $raw = New-Object Security.AccessControl.RawSecurityDescriptor($acl.Sddl)
  if ($null -eq $raw.DiscretionaryAcl) { throw "Missing DACL: $Path" }
  foreach ($ace in $raw.DiscretionaryAcl) {
    if ($ace.AceType -ne [Security.AccessControl.AceType]::AccessAllowed -and
        $ace.AceType -ne [Security.AccessControl.AceType]::AccessDenied) {
      throw "Unsupported ACE: $Path"
    }
    # Inherit-only entries do not grant access to this object.
    if (([int]$ace.AceFlags -band [int][Security.AccessControl.AceFlags]::InheritOnly) -ne 0) { continue }
    if ($ace.AceType -eq [Security.AccessControl.AceType]::AccessAllowed -and
        ($ace.AccessMask -band 0x500D0156) -ne 0 -and
        $TrustedSids -notcontains $ace.SecurityIdentifier.Value) {
      throw "Untrusted writer: $Path"
    }
  }
}

function Get-PackageTree([string] $Path) {
  $item = Assert-NotReparse $Path
  $item
  if ($item.PSIsContainer) {
    foreach ($child in Get-ChildItem -LiteralPath $Path -Force) {
      Get-PackageTree $child.FullName
    }
  }
}

function Assert-Destination([string] $Path, [switch] $AllowInstallerFiles) {
  $programFiles = Get-NativeProgramFiles
  $expected = Join-Path $programFiles $InstallLeaf
  if (-not [string]::Equals($Path, $expected, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Only the canonical machine installation is supported: $expected"
  }
  $null = Assert-NotReparse $programFiles
  Assert-TrustedAcl $programFiles
  # Inspect ancestors without granting/removing any rights there.
  $parent = [IO.Directory]::GetParent($programFiles)
  while ($null -ne $parent) {
    $null = Assert-NotReparse $parent.FullName
    $parent = $parent.Parent
  }
  if (Test-Path -LiteralPath $Path) {
    if (-not (Get-Item -LiteralPath $Path -Force).PSIsContainer) {
      throw 'The canonical package path must be a directory'
    }
    Assert-TrustedAcl $Path
    foreach ($item in Get-PackageTree $Path) {
      Assert-TrustedAcl $item.FullName -AllowInstallerOwner:$AllowInstallerFiles
    }
  }
}

function New-PackageAcl([bool] $Directory, [switch] $Private) {
  if ($Directory) {
    $acl = New-Object Security.AccessControl.DirectorySecurity
    $inherit = [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
  } else {
    $acl = New-Object Security.AccessControl.FileSecurity
    $inherit = [Security.AccessControl.InheritanceFlags]::None
  }
  $acl.SetOwner((New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')))
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($sid in @('S-1-5-18', 'S-1-5-32-544', 'S-1-5-32-545')) {
    if ($Private -and $sid -eq 'S-1-5-32-545') { continue }
    $rights = [Security.AccessControl.FileSystemRights]::FullControl
    if ($sid -eq 'S-1-5-32-545') { $rights = [Security.AccessControl.FileSystemRights]::ReadAndExecute }
    $rule = New-Object Security.AccessControl.FileSystemAccessRule(
      (New-Object Security.Principal.SecurityIdentifier($sid)), $rights, $inherit,
      [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)
    $null = $acl.AddAccessRule($rule)
  }
  return $acl
}

function Protect-Package([string] $Path) {
  # Called only for the canonical dedicated package, never Program Files itself.
  foreach ($item in Get-PackageTree $Path) {
    $acl = New-PackageAcl $item.PSIsContainer
    Set-Acl -LiteralPath $item.FullName -AclObject $acl
  }
}

function Invoke-Host([string[]] $Arguments, [switch] $Json) {
  $helper = Join-Path $InstallDir 'anubis-host.exe'
  # Never parse start/stop's empty stdout as JSON.
  $output = & $helper @Arguments
  if ($LASTEXITCODE -ne 0) { throw "Native host command failed: $($Arguments[0]) (exit $LASTEXITCODE)" }
  if ($Json) { return ($output | ConvertFrom-Json) }
}

function Assert-NativePackage {
  $valid = Invoke-Host @('validate-install', '--install-dir', $InstallDir, '--runtime-relative-path', 'anubis.exe') -Json
  if ($valid.valid -ne $true) { throw 'Native package validation failed' }
}

function Get-OwnedService {
  $services = @(Get-Service -Name $ServiceName -ErrorAction SilentlyContinue)
  if ($services.Count -eq 0) {
    # Get-Service hides permission/query errors as well as absence: confirm via SCM.
    $all = @(Get-Service -ErrorAction Stop | Where-Object { $_.ServiceName -eq $ServiceName })
    if ($all.Count -ne 0) { throw "Cannot inspect $ServiceName" }
    return $null
  }
  Assert-NativePackage
  $status = Invoke-Host @('status', '--name', $ServiceName) -Json
  $expected = '"' + (Join-Path $InstallDir 'anubis-host.exe') + '" service --name ' + $ServiceName
  if ($status.imagePath -cne $expected -or
      $status.account -notin @('LocalSystem', '') -or $status.automatic -ne $true) {
    throw 'Refusing to modify a service with a different image/account/start mode'
  }
  return $status
}

function Wait-ServiceState([int] $State) {
  $deadline = [DateTime]::UtcNow.AddSeconds(60)
  do {
    $status = Get-OwnedService
    if ($null -eq $status) { throw 'Owned service disappeared' }
    if ($status.scm.State -eq $State) { return }
    if ($State -eq 4 -and $status.scm.State -eq 1) {
      throw "Machine engine stopped before readiness (SCM exit $($status.scm.Win32ExitCode))"
    }
    Start-Sleep -Milliseconds 500
  } while ([DateTime]::UtcNow -lt $deadline)
  throw "Timed out waiting for service state $State"
}

function Stop-OwnedService {
  $status = Get-OwnedService
  if ($null -eq $status -or $status.scm.State -eq 1) { return }
  if ($status.scm.State -eq 2) { Wait-ServiceState 4; $status = Get-OwnedService }
  if ($status.scm.State -ne 3) { Invoke-Host @('stop', '--name', $ServiceName) }
  Wait-ServiceState 1
}

function Assert-PrivatePath([string] $Path) {
  $null = Assert-NotReparse $Path
  Assert-TrustedAcl $Path
  $raw = New-Object Security.AccessControl.RawSecurityDescriptor((Get-Acl -LiteralPath $Path).Sddl)
  foreach ($ace in $raw.DiscretionaryAcl) {
    if (([int]$ace.AceFlags -band 8) -eq 0 -and
        $ace.AceType -eq [Security.AccessControl.AceType]::AccessAllowed -and
        $ace.AccessMask -ne 0 -and $TrustedSids -notcontains $ace.SecurityIdentifier.Value) {
      throw "Unrelated principal can access private machine policy: $Path"
    }
  }
}

function Protect-QaMachinePolicy {
  if (-not $CompiledEdition.disableManaged) { return }
  # Native install creates/validates these private ancestors, without starting.
  $data = Get-NativeProgramData
  $null = Assert-NotReparse $data
  $root = $data
  foreach ($leaf in @('Anubis', 'Host', $ServiceName)) {
    $root = Join-Path $root $leaf
    Assert-PrivatePath $root
  }
  $configFile = Join-Path $root 'host.json'
  Assert-PrivatePath $configFile
  $hostConfig = [IO.File]::ReadAllText($configFile) | ConvertFrom-Json
  if ($hostConfig.serviceName -cne $ServiceName -or $hostConfig.installDir -ine $InstallDir -or
      $hostConfig.runtimeRelativePath -cne 'anubis.exe') {
    throw 'The isolated installer QA service must retain its exact package'
  }
  $retainedSids = @()
  if ($null -ne $hostConfig.allowedUserSids) {
    if ($hostConfig.allowedUserSids -isnot [array]) { throw 'Invalid retained QA user allow-list' }
    $retainedSids = @($hostConfig.allowedUserSids)
  }
  foreach ($sid in $retainedSids) {
    if ($sid -isnot [string] -or $sid -notmatch '^S-1-5-21-[0-9]+-[0-9]+-[0-9]+-[0-9]+$' -or
        (New-Object Security.Principal.SecurityIdentifier($sid)).Value -cne $sid) { throw 'Invalid retained QA user SID' }
  }
  if ($CompiledEdition.edition -cne 'migration-qa-7e66c0f5' -and $retainedSids.Count -ne 0) {
    throw 'The isolated installer QA service must retain an empty user allow-list'
  }
  if ($CompiledEdition.edition -ceq 'migration-qa-7e66c0f5' -and $AllowedUserSids -ne '') {
    $expectedSids = @($AllowedUserSids.Split(',') | Sort-Object -Unique)
    if (($expectedSids -join ',') -cne (@($retainedSids | Sort-Object -Unique) -join ',')) {
      throw 'The migration QA allow-list does not match explicit provisioning'
    }
  }
  $profile = Join-Path $root 'system-profile'
  if (-not (Test-Path -LiteralPath $profile)) {
    $null = [IO.Directory]::CreateDirectory($profile, (New-PackageAcl $true -Private))
  }
  Assert-PrivatePath $profile
  if (-not (Get-Item -LiteralPath $profile -Force).PSIsContainer) {
    throw 'The QA SYSTEM profile must be a private directory'
  }
  $policyFile = Join-Path $profile 'machine-policy.json'
  if (Test-Path -LiteralPath $policyFile) {
    Assert-PrivatePath $policyFile
    $policy = [IO.File]::ReadAllText($policyFile) | ConvertFrom-Json
    if (@($policy.PSObject.Properties).Count -ne 1 -or
        $policy.PSObject.Properties.Name -cne 'managedEnabled' -or
        $policy.managedEnabled -isnot [bool] -or $policy.managedEnabled -ne $false) {
      throw 'Retained QA policy must explicitly disable managed enrollment'
    }
  } else {
    [IO.File]::WriteAllText($policyFile, '{"managedEnabled":false}', (New-Object Text.UTF8Encoding($false)))
    Set-Acl -LiteralPath $policyFile -AclObject (New-PackageAcl $false -Private)
    Assert-PrivatePath $policyFile
  }
}

function Uninstall-PreviousMachinePackage {
  Assert-NativePackage
  $hostRoot = Get-NativeProgramData
  $null = Assert-NotReparse $hostRoot
  foreach ($leaf in @('Anubis', 'Host', $ServiceName)) {
    $hostRoot = Join-Path $hostRoot $leaf
    Assert-PrivatePath $hostRoot
  }
  $staging = Join-Path $hostRoot ('uninstall-' + [Guid]::NewGuid().ToString('N'))
  if (Test-Path -LiteralPath $staging) { throw 'Uninstaller staging namespace collision' }
  $null = [IO.Directory]::CreateDirectory($staging, (New-PackageAcl $true -Private))
  $file = Join-Path $staging 'old-machine-uninstaller.exe'
  try {
    Assert-PrivatePath $staging
    $original = Join-Path $InstallDir 'Uninstall anubis.exe'
    $source = [IO.File]::Open($original, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    try {
      $copy = [IO.File]::Create($file, 4096, [IO.FileOptions]::None, (New-PackageAcl $false -Private))
      try { $source.CopyTo($copy); $copy.Flush($true) } finally { $copy.Dispose() }
      Assert-PrivatePath $file
      $locked = [IO.File]::Open($file, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
      try {
        if ((Get-FileHash -LiteralPath $original -Algorithm SHA256).Hash -cne
            (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash) {
          throw 'The protected machine uninstaller copy differs'
        }
        # The old uninstaller must be able to delete its installed source.
        $source.Dispose()
        $start = New-Object Diagnostics.ProcessStartInfo
        $start.FileName = $file
        $start.Arguments = '/allusers /S --updated --keep-shortcuts _?=' + $InstallDir
        $start.UseShellExecute = $false
        $start.CreateNoWindow = $true
        $process = New-Object Diagnostics.Process
        try {
          $process.StartInfo = $start
          if (-not $process.Start()) { throw 'The protected machine uninstaller did not start' }
          $process.WaitForExit()
          if ($process.ExitCode -ne 0) { throw "The protected machine uninstaller failed: $($process.ExitCode)" }
        } finally { $process.Dispose() }
      } finally { $locked.Dispose() }
    } finally { $source.Dispose() }
  } finally {
    if (Test-Path -LiteralPath $file) { [IO.File]::Delete($file) }
    [IO.Directory]::Delete($staging)
  }
}

function Invoke-MachineInstall {
  if (-not [Environment]::Is64BitOperatingSystem) { throw 'Machine service requires Windows x64' }
  if (-not [Environment]::Is64BitProcess) { throw 'Machine installation requires native x64 PowerShell' }
  $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'An elevated administrator is required'
  }
  $AllowedUserSids = Read-AllowedUserSids $SidListFile
  Assert-Destination $InstallDir -AllowInstallerFiles:($Action -eq 'Finish')
  $marker = Join-Path $InstallDir 'anubis-machine-install.json'
  switch ($Action) {
    'Prepare' {
      Invoke-UserMigration ($MigrationRequested -eq '1') $false
      if ($AllowedUserSids -ne '' -and $null -ne (Get-OwnedService)) {
        throw 'The retained service allow-list cannot be changed by an update'
      }
      if (Test-Path -LiteralPath $InstallDir) {
        if (-not (Test-Path -LiteralPath $marker) -and
            @(Get-ChildItem -LiteralPath $InstallDir -Force).Count -gt 0) {
          throw 'Existing non-machine installation must not be migrated implicitly'
        }
        Stop-OwnedService
      } else {
        if (@(Get-Service -ErrorAction Stop | Where-Object { $_.ServiceName -eq $ServiceName }).Count -gt 0) {
          throw "$ServiceName exists outside this package; refusing to change it"
        }
        # Supply ownership/DACL at creation, not after a user-owned staging gap.
        $null = [IO.Directory]::CreateDirectory($InstallDir, (New-PackageAcl $true))
        Assert-Destination $InstallDir
        if (@(Get-ChildItem -LiteralPath $InstallDir -Force).Count -ne 0) {
          throw 'A fresh machine package directory must be empty'
        }
      }
    }
    'Stop' { Stop-OwnedService }
    'UninstallPrevious' { Uninstall-PreviousMachinePackage }
    'Finish' {
      Protect-Package $InstallDir
      Assert-NativePackage
      $status = Get-OwnedService
      if ($null -eq $status) {
        $arguments = @('install', '--name', $ServiceName, '--install-dir', $InstallDir)
        if ($AllowedUserSids -ne '') { $arguments += @('--allow-user-sids', $AllowedUserSids) }
        $installed = Invoke-Host $arguments -Json
        if ($installed.installed -ne $true) { throw 'Service installation was not confirmed' }
      } elseif ($AllowedUserSids -ne '') {
        throw 'The retained service allow-list cannot be changed by an update'
      }
      # This installer-only marker is never emitted into portable/AppX payloads.
      $markerJson = @{ version = 1; serviceName = $ServiceName } | ConvertTo-Json -Compress
      [IO.File]::WriteAllText($marker, $markerJson, (New-Object Text.UTF8Encoding($false)))
      Protect-Package $InstallDir
      Assert-NativePackage
      Protect-QaMachinePolicy
      $status = Get-OwnedService
      if ($status.scm.State -eq 1) { Invoke-Host @('start', '--name', $ServiceName) }
      Wait-ServiceState 4
      $identity = Invoke-Host @('broker-client', '--name', $ServiceName, '--operation', 'identity') -Json
      if ($identity.ok -ne $true -or $null -eq $identity.result.machine -or
          $identity.result.host.sid -ne 'S-1-5-18' -or $identity.result.host.sessionId -ne 0 -or
          $identity.result.machine.identity.sid -ne 'S-1-5-18' -or
          $identity.result.machine.identity.sessionId -ne 0) {
        throw 'The actual SYSTEM machine engine did not become ready'
      }
      Invoke-UserMigration ($MigrationRequested -eq '1') $true
    }
    'Remove' {
      Stop-OwnedService
      Remove-MigratedUserBindings
      if ($null -ne (Get-OwnedService)) { Invoke-Host @('uninstall', '--name', $ServiceName) }
      $deadline = [DateTime]::UtcNow.AddSeconds(30)
      while (@(Get-Service -ErrorAction Stop | Where-Object { $_.ServiceName -eq $ServiceName }).Count -ne 0) {
        if ([DateTime]::UtcNow -ge $deadline) { throw 'Service deletion did not complete' }
        Start-Sleep -Milliseconds 500
      }
    }
    default { throw 'An explicit installation action is required' }
  }
}

if (-not $DefinitionsOnly) {
  try {
    Invoke-MachineInstall
    Write-Output "Machine installer action $Action completed."
    exit 0
  } catch {
    [Console]::Error.WriteLine("Machine installer failed: $($_.Exception.Message). Profiles and host data were retained.")
    exit 5
  }
}
