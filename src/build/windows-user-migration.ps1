function Initialize-UserMigration {
  if (-not ('AnubisInstaller.UserMigration' -as [type])) {
    Add-Type -Path (Join-Path $PSScriptRoot 'windows-user-migration.cs')
  }
}

function Remove-MigratedUserBindings {
    if ($CompiledEdition.edition -ceq 'installer-qa-7e66c0f5') { return }
    $data = Join-Path (Join-Path (Join-Path (Get-NativeProgramData) 'Anubis') 'Host') $ServiceName
    $report = Join-Path $data 'user-migration.json'
    if (-not (Test-Path -LiteralPath $report)) { return }
    Assert-PrivatePath $data
    Assert-PrivatePath $report
    if ((Get-Item -LiteralPath $report).Length -gt 65536) { throw 'Migration report is too large' }
    $record = [IO.File]::ReadAllText($report) | ConvertFrom-Json
    if (@($record.PSObject.Properties).Count -ne 9 -or $record.version -isnot [int] -or
        $record.version -ne 1 -or $record.status -cne 'complete' -or
        $record.serviceName -cne $ServiceName) { throw 'Invalid or incomplete retained user-migration report; explicit repair is required' }
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    if ($record.sid -cne $sid) {
      Write-Output 'Migration belongs to another Windows user; its shell bindings were retained untouched.'
      return
    }
    Initialize-UserMigration
    $contract = Get-MigrationContract
    $folders = Get-MigrationFolders
    if ($record.retainedLegacyDirectory -ine (Join-Path $folders.LegacyRoot $contract.Leaf)) {
      throw 'Unexpected retained migration backup path'
    }
    $allowedShortcuts = @(
      (Join-Path $folders.Desktop ($contract.Shortcut + '.lnk')),
      (Join-Path $folders.Programs ($contract.Shortcut + '.lnk')),
      (Join-Path (Join-Path $folders.Programs $contract.Shortcut) ($contract.Shortcut + '.lnk'))
    )
    if (@($record.shortcuts).Count -gt 3 -or @($record.classes).Count -gt $contract.Classes.Count -or
        @($record.shortcuts | Where-Object { $_ -isnot [string] -or $_ -notin $allowedShortcuts }).Count -ne 0 -or
        @($record.classes | Where-Object { $_ -isnot [string] -or $_ -cnotin $contract.Classes }).Count -ne 0) {
      throw 'Migration report contains unknown shell bindings'
    }
    $newExe = Join-Path $InstallDir 'anubis.exe'
    foreach ($file in $record.shortcuts) {
      if (-not (Test-Path -LiteralPath $file)) { continue }
      $pin = New-Object AnubisInstaller.UserMigration+PinnedPath($file, $false, $true, $sid)
      try {
        if ([AnubisInstaller.UserMigration]::ShortcutTarget($pin.Bytes) -ine $newExe) {
          Write-Output "Shortcut changed after migration; retained untouched: $file"
          continue
        }
        $pin.Delete()
      } finally { $pin.Dispose() }
    }
    foreach ($class in $record.classes) {
      $key = [AnubisInstaller.UserMigration]::OpenUserKey("Software\Classes\$class\shell\open\command", $true)
      if ($null -eq $key) { continue }
      try {
        $values = Get-MigrationValues $key @('') $sid
        if ($values.ContainsKey('') -and $values[''] -ceq ('"' + $newExe + '" "%1"')) {
          [AnubisInstaller.UserMigration]::DeleteKey($key)
        } else { Write-Output "Shell command changed after migration; retained untouched: $class" }
      } finally { $key.Dispose() }
    }
}

function Get-MigrationContract {
  if ($CompiledEdition.edition -ceq 'production') {
    return @{
      Guid = '745095cd-43ab-5c64-ac68-8eb0da974d57'
      Leaf = 'anubis'
      Shortcut = 'anubis'
      FileClass = 'Virt Viewer connection file'
      Classes = @('ssh','telnet','rdp','vnc','serial','spice','ftp','anubis','Virt Viewer connection file')
    }
  }
  if ($CompiledEdition.edition -ceq 'migration-qa-7e66c0f5') {
    return @{
      Guid = 'f71e08f8-f8b5-4b34-ade6-7e66c0f5a002'
      Leaf = 'Anubis-Security-Tool-QA-migration-7e66c0f5'
      Shortcut = 'Anubis-Security-Tool-QA-migration-7e66c0f5'
      FileClass = 'anubis-qa-migration-7e66c0f5'
      Classes = @('anubis-qa-migration-7e66c0f5')
    }
  }
  throw 'This installer edition does not support per-user migration'
}

function Get-MigrationFolders {
  return @{
    LegacyRoot = [AnubisInstaller.UserMigration]::UserPrograms()
    Desktop = [AnubisInstaller.UserMigration]::Desktop()
    Programs = [AnubisInstaller.UserMigration]::Programs()
  }
}

function Get-MigrationInteractiveSid { return [AnubisInstaller.UserMigration]::InteractiveSid() }

function Get-MigrationValues($Key, [string[]] $Allowed, [string] $Sid) {
  $owner = $Key.GetAccessControl([Security.AccessControl.AccessControlSections]::Owner).
      GetOwner([Security.Principal.SecurityIdentifier]).Value
  if ($owner -notin @($Sid, 'S-1-5-18', 'S-1-5-32-544')) {
    throw 'Foreign legacy registration owner'
  }
  if ($Key.SubKeyCount -ne 0) { throw 'Unknown legacy registration subkeys' }
  $values = @{}
  foreach ($name in $Key.GetValueNames()) {
    if ($name -cnotin $Allowed) { throw "Unknown legacy registration value: $name" }
    $kind = $Key.GetValueKind($name)
    if ($kind -notin @([Microsoft.Win32.RegistryValueKind]::String, [Microsoft.Win32.RegistryValueKind]::DWord)) {
      throw 'Unsupported legacy registry value type'
    }
    $value = $Key.GetValue($name, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    if ($value -is [string] -and $value.Length -gt 2048) { throw 'Legacy registration value too large' }
    $values[$name] = $value
  }
  return $values
}

function Invoke-UserMigration([bool] $Requested, [bool] $Apply) {
  $contract = $null
  if ($CompiledEdition.edition -ceq 'installer-qa-7e66c0f5') {
    if ($Requested) { throw 'Use the separate migration QA edition' }
    return
  }
  $contract = Get-MigrationContract
  Initialize-UserMigration
  $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  if ($Requested -and (Get-MigrationInteractiveSid) -ne $sid) {
    throw 'Different-account UAC migration is forbidden; run as the owning interactive account'
  }
  $resources = New-Object 'Collections.Generic.List[IDisposable]'
  try {
    $installKey = [AnubisInstaller.UserMigration]::OpenUserKey("Software\$($contract.Guid)", $Apply)
    $uninstallKey = [AnubisInstaller.UserMigration]::OpenUserKey("Software\Microsoft\Windows\CurrentVersion\Uninstall\$($contract.Guid)", $Apply)
    if ($null -ne $installKey) { $resources.Add($installKey) }
    if ($null -ne $uninstallKey) { $resources.Add($uninstallKey) }
    if ($null -eq $installKey -and $null -eq $uninstallKey) {
      if ($Requested) { throw 'No exact current-user legacy installation exists to migrate' }
      return
    }
    if (-not $Requested) { throw 'A per-user installation exists; explicit /MIGRATEPERUSER is required' }
    if ($null -eq $installKey -or $null -eq $uninstallKey) { throw 'Incomplete legacy registration; automatic migration refused' }
    $folders = Get-MigrationFolders
    $legacy = Join-Path $folders.LegacyRoot $contract.Leaf
    $oldExe = Join-Path $legacy 'anubis.exe'
    $oldUninstaller = Join-Path $legacy 'Uninstall anubis.exe'
    $install = Get-MigrationValues $installKey @('InstallLocation','KeepShortcuts','ShortcutName','MenuDirectory') $sid
    $uninstall = Get-MigrationValues $uninstallKey @(
      'DisplayName','DisplayVersion','DisplayIcon','UninstallString','QuietUninstallString','Publisher',
      'Comments','HelpLink','URLInfoAbout','URLUpdateInfo','Readme','NoModify','NoRepair','EstimatedSize','InstallLocation'
    ) $sid
    if ($install.InstallLocation -ine $legacy -or $install.ShortcutName -cne $contract.Shortcut -or
        ($install.ContainsKey('MenuDirectory') -and $install.MenuDirectory -cne $contract.Shortcut) -or
        $uninstall.DisplayVersion -notmatch '^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$' -or
        $uninstall.DisplayName -cne ('anubis ' + $uninstall.DisplayVersion) -or
        $uninstall.UninstallString -cne ('"' + $oldUninstaller + '" /currentuser') -or
        $uninstall.QuietUninstallString -cne ('"' + $oldUninstaller + '" /currentuser /S') -or
        ($uninstall.ContainsKey('InstallLocation') -and $uninstall.InstallLocation -ne '' -and $uninstall.InstallLocation -ine $legacy) -or
        ($uninstall.ContainsKey('DisplayIcon') -and $uninstall.DisplayIcon -inotmatch ('^' + [regex]::Escape($oldExe) + ',0$|^' + [regex]::Escape((Join-Path $legacy 'uninstallerIcon.ico')) + '$'))) {
      throw 'Foreign or noncanonical legacy installation registration'
    }
    foreach ($item in @(@($legacy, $true), @($oldExe, $false), @($oldUninstaller, $false))) {
      $resources.Add((New-Object AnubisInstaller.UserMigration+PinnedPath($item[0], $item[1], $false, $sid)))
    }
    $shortcuts = @()
    foreach ($file in @(
      (Join-Path $folders.Desktop ($contract.Shortcut + '.lnk')),
      (Join-Path $folders.Programs ($contract.Shortcut + '.lnk')),
      (Join-Path (Join-Path $folders.Programs $contract.Shortcut) ($contract.Shortcut + '.lnk'))
    )) {
      if (-not (Test-Path -LiteralPath $file)) { continue }
      $pin = New-Object AnubisInstaller.UserMigration+PinnedPath($file, $false, $Apply, $sid)
      $resources.Add($pin)
      if ([AnubisInstaller.UserMigration]::ShortcutTarget($pin.Bytes) -ine $oldExe) {
        throw 'Foreign shortcut at a legacy application shortcut path'
      }
      $shortcuts += @{ path = $file; pin = $pin }
    }
    $commands = @()
    foreach ($class in $contract.Classes) {
      $key = [AnubisInstaller.UserMigration]::OpenUserKey("Software\Classes\$class\shell\open\command", $Apply)
      if ($null -eq $key) { continue }
      $resources.Add($key)
      $values = Get-MigrationValues $key @('') $sid
      $oldCommand = '"' + $oldExe + '" "%1"'
      $knownFileCommand = $class -ceq $contract.FileClass -and $oldExe -notmatch '\s' -and
          $values.ContainsKey('') -and $values[''] -ceq ($oldExe + ' "%1"')
      if (-not $values.ContainsKey('') -or ($values[''] -cne $oldCommand -and -not $knownFileCommand)) {
        if ($values.ContainsKey('') -and $values[''].IndexOf($legacy, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
          throw 'Malformed legacy application shell command'
        }
        continue
      }
      $commands += @{ key = $key; class = $class; previous = $values[''] }
    }
    if (-not $Apply) { return }
    $newExe = Join-Path $InstallDir 'anubis.exe'
    Assert-NativePackage
    $data = Join-Path (Join-Path (Join-Path (Get-NativeProgramData) 'Anubis') 'Host') $ServiceName
    Assert-PrivatePath $data
    $report = Join-Path $data 'user-migration.json'
    if (Test-Path -LiteralPath $report) { throw 'A migration report already exists; explicit repair is required' }
    $record = @{
      version = 1; status = 'planned'; sid = $sid; serviceName = $ServiceName
      retainedLegacyDirectory = $legacy; installRegistration = $install; uninstallRegistration = $uninstall
      shortcuts = @($shortcuts | ForEach-Object { $_.path })
      classes = @($commands | ForEach-Object { $_.class })
    }
    $bytes = (New-Object Text.UTF8Encoding($false)).GetBytes(($record | ConvertTo-Json -Depth 5))
    if ($bytes.Length -gt 65536) { throw 'Migration report is too large' }
    $stream = [IO.File]::Open($report, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try {
      $stream.Write($bytes, 0, $bytes.Length)
      $stream.Flush($true)
    } finally { $stream.Dispose() }
    Set-Acl -LiteralPath $report -AclObject (New-PackageAcl $false -Private)
    Assert-PrivatePath $report
    foreach ($link in $shortcuts) { $link.pin.Write([AnubisInstaller.UserMigration]::Shortcut($newExe)) }
    foreach ($command in $commands) {
      if ($command.key.GetValue('') -cne $command.previous) { throw 'Legacy shell registration changed concurrently' }
      $command.key.SetValue('', ('"' + $newExe + '" "%1"'), [Microsoft.Win32.RegistryValueKind]::String)
    }
    [AnubisInstaller.UserMigration]::DeleteKey($uninstallKey)
    [AnubisInstaller.UserMigration]::DeleteKey($installKey)
    $record.status = 'complete'
    [IO.File]::WriteAllText($report, ($record | ConvertTo-Json -Depth 5), (New-Object Text.UTF8Encoding($false)))
    Write-Output "Migrated only $sid registrations/shortcuts. Legacy payload retained: $legacy. Report: $report"
  } finally {
    foreach ($resource in $resources) { $resource.Dispose() }
  }
}
