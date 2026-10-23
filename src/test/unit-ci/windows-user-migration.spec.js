const { it } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { configureInstallerQa, migrationQa, migrationGuid, migrationAppId } = require('../../build/bin/windows-machine-edition')

it('keeps migration opt-in and bypasses user-writable old uninstallers at compile time', () => {
  const include = fs.readFileSync(path.resolve(__dirname, '../../build/windows-installer.nsh'), 'utf8')
  const guard = fs.readFileSync(path.resolve(__dirname, '../../build/windows-machine-uninstall-guard.nsh'), 'utf8')
  assert.match(include, /GetOptions.*"\/MIGRATEPERUSER"/)
  assert.match(include, /AnubisMigratePerUser != "1"/)
  assert.match(include, /customCheckAppRunning[\s\S]*windows-machine-uninstall-guard\.nsh/)
  assert.match(guard, /!if "\$\{ROOT_KEY\}" == "HKEY_CURRENT_USER"\s+;[^\n]*\s+ClearErrors\s+StrCpy \$R0 0/)
  assert.match(guard, /AnubisMachineAction UninstallPrevious/)
  assert.doesNotMatch(guard, /Call uninstallOldVersion|UninstallString|ExecWait|CopyFiles/)
  const script = fs.readFileSync(path.resolve(__dirname, '../../build/windows-machine-install.ps1'), 'utf8')
  assert.match(script, /Join-Path \$InstallDir 'Uninstall anubis\.exe'/)
  assert.match(script, /IO\.File\]::Create\(\$file, 4096, \[IO\.FileOptions\]::None, \(New-PackageAcl \$false -Private\)\)/)
  assert.match(script, /\$start\.UseShellExecute = \$false/)
  assert.match(script, /\/allusers \/S --updated --keep-shortcuts _\?=/)
  assert.ok(script.indexOf("throw 'The actual SYSTEM machine engine") < script.lastIndexOf('Invoke-UserMigration ($MigrationRequested'))
  const source = fs.readFileSync(path.resolve(__dirname, '../../build/windows-user-migration.ps1'), 'utf8')
  assert.doesNotMatch(source, /Start-Process|Invoke-Expression|& \$|Process\]::Start|Copy-Item|Remove-Item/)
})

it('migrates only disposable QA registrations and shortcuts, preserving payload and private profile bytes', {
  skip: process.platform !== 'win32', timeout: 60000
}, t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anubis-user-migration-'))
  try {
    const config = configureInstallerQa(require('../../build/electron-builder.json'), dir, migrationQa)
    assert.equal(config.nsis.guid, migrationGuid)
    assert.equal(config.appId, migrationAppId)
    assert.deepEqual(config.protocols, [])
    assert.deepEqual(config.fileAssociations, [])
    const quote = value => value.replaceAll("'", "''")
    const source = `
$ErrorActionPreference='Stop'
. '${quote(path.join(dir, 'windows-machine-install.ps1'))}' -DefinitionsOnly
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { Write-Output 'FIXTURE_REQUIRES_ADMIN'; exit 0 }
Initialize-UserMigration
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$root = '${quote(dir)}'
$contract = Get-MigrationContract
$sidFile = Join-Path $root 'explicit-sids.txt'
if ((Read-AllowedUserSids '') -cne '') { throw 'Default authorization is not empty' }
[IO.File]::WriteAllText($sidFile, $sid)
if ((Read-AllowedUserSids $sidFile) -cne $sid) { throw 'Explicit migration-QA SID was rejected' }
$savedEdition = $CompiledEdition
$CompiledEdition = [pscustomobject]@{edition='installer-qa-7e66c0f5';disableManaged=$true}
$rejected = $false
try { Read-AllowedUserSids $sidFile } catch { $rejected = $_.Exception.Message -match 'permits no user workers' }
if (-not $rejected) { throw 'Historical installer-QA accepted a nonempty allow-list' }
$CompiledEdition = $savedEdition
$registration = "Software\\$($contract.Guid)"
$unregistration = "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\$($contract.Guid)"
$classRoot = 'Software\\Classes\\anubis-qa-migration-7e66c0f5'
$foreignClass = $classRoot + '-foreign'
$registry = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser, [Microsoft.Win32.RegistryView]::Registry64)
$owned = @()
foreach ($key in @($registration,$unregistration,$classRoot,$foreignClass)) {
  $existing = $registry.OpenSubKey($key)
  if ($null -ne $existing) { $existing.Dispose(); throw 'QA registry namespace collision; refusing to touch it' }
}
function Own-File($file) {
  $acl = Get-Acl -LiteralPath $file
  $acl.SetOwner((New-Object Security.Principal.SecurityIdentifier($sid)))
  Set-Acl -LiteralPath $file -AclObject $acl
}
function Write-Registration($path, $values) {
  $key = $registry.CreateSubKey($path)
  try {
    $acl = $key.GetAccessControl()
    $acl.SetOwner((New-Object Security.Principal.SecurityIdentifier($sid)))
    $key.SetAccessControl($acl)
    foreach ($name in $values.Keys) { $key.SetValue($name, $values[$name], [Microsoft.Win32.RegistryValueKind]::String) }
  } finally { $key.Dispose() }
}
function Expect-Rejection($pattern, [scriptblock] $body) {
  $failed = $false
  try { & $body } catch { if ($_.Exception.ToString() -notmatch $pattern) { throw }; $failed = $true }
  if (-not $failed) { throw "Unsafe migration accepted: $pattern" }
}
try {
  $folders = @{ LegacyRoot=(Join-Path $root 'programs');Desktop=(Join-Path $root 'desktop');Programs=(Join-Path $root 'start-menu') }
  foreach ($folder in $folders.Values) { $null = New-Item -ItemType Directory -Path $folder }
  function Get-MigrationFolders { return $folders }
  function Get-MigrationInteractiveSid { return $sid }
  $legacy = Join-Path $folders.LegacyRoot $contract.Leaf
  $null = New-Item -ItemType Directory -Path $legacy
  Own-File $legacy
  $oldExe = Join-Path $legacy 'anubis.exe'
  $oldUninstaller = Join-Path $legacy 'Uninstall anubis.exe'
  foreach ($file in @($oldExe,$oldUninstaller)) { [IO.File]::WriteAllText($file, 'DUMMY NEVER EXECUTE'); Own-File $file }
  $InstallDir = Join-Path $root 'machine-package'
  $null = New-Item -ItemType Directory -Path $InstallDir
  $newExe = Join-Path $InstallDir 'anubis.exe'
  [IO.File]::WriteAllText($newExe, 'DUMMY NEVER EXECUTE')
  $private = Join-Path $root 'user-private.dpapi'
  [IO.File]::WriteAllText($private, 'fixture-private-state-never-copied')
  $beforePrivate = [IO.File]::ReadAllBytes($private)
  $beforeExe = [IO.File]::ReadAllBytes($oldExe)
  $link = Join-Path $folders.Desktop ($contract.Shortcut + '.lnk')
  $shell = New-Object -ComObject WScript.Shell
  $nativeLink = $shell.CreateShortcut($link)
  $nativeLink.TargetPath = $oldExe
  $nativeLink.WorkingDirectory = $legacy
  $nativeLink.Description = 'Disposable Anubis QA shortcut'
  $nativeLink.IconLocation = $oldExe + ',0'
  $nativeLink.Arguments = ''
  $nativeLink.Save()
  Own-File $link
  $validShortcut = [IO.File]::ReadAllBytes($link)
  if (([BitConverter]::ToUInt32($validShortcut,20) -band 0x4000) -eq 0) { throw 'Windows fixture did not exercise native icon-environment metadata' }
  $owned += @($registration,$unregistration,$classRoot)
  Write-Registration $registration @{InstallLocation=$legacy;KeepShortcuts='true';ShortcutName=$contract.Shortcut}
  Write-Registration $unregistration @{DisplayName='anubis 5.6.12';DisplayVersion='5.6.12';InstallLocation='';UninstallString=('"'+$oldUninstaller+'" /currentuser');QuietUninstallString=('"'+$oldUninstaller+'" /currentuser /S')}
  Write-Registration ($classRoot+'\\shell\\open\\command') @{''=('"'+$oldExe+'" "%1"')}
  $owned += $foreignClass
  Write-Registration $foreignClass @{''='foreign-marker-must-survive'}
  Add-Type -TypeDefinition @'
using System; using System.Text; using System.ComponentModel; using System.Runtime.InteropServices; using Microsoft.Win32.SafeHandles;
public static class MigrationLinkFixture {
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode)] static extern int RegCreateKeyEx(SafeRegistryHandle parent, string name, int reserved, string cls, uint options, int access, IntPtr security, out SafeRegistryHandle result, out int disposition);
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode)] static extern int RegSetValueEx(SafeRegistryHandle key, string name, int reserved, int kind, byte[] data, int length);
  public static SafeRegistryHandle Create(SafeRegistryHandle parent, string name, string target) {
    SafeRegistryHandle key; int disposition;
    int error = RegCreateKeyEx(parent, name, 0, null, 2, 0xf003f, IntPtr.Zero, out key, out disposition);
    if(error != 0) throw new Win32Exception(error);
    byte[] bytes = Encoding.Unicode.GetBytes(target);
    error = RegSetValueEx(key, "SymbolicLinkValue", 0, 6, bytes, bytes.Length);
    if(error != 0) { key.Dispose(); throw new Win32Exception(error); }
    return key;
  }
}
'@
  $registry.DeleteSubKeyTree($classRoot+'\\shell\\open\\command')
  $linkHandle = [MigrationLinkFixture]::Create($registry.Handle, ($classRoot+'\\shell\\open\\command'), ('\\Registry\\User\\'+$sid+'_Classes\\anubis-qa-migration-7e66c0f5-foreign'))
  $linkKey = [Microsoft.Win32.RegistryKey]::FromHandle($linkHandle)
  try { Expect-Rejection 'Registry links' { Invoke-UserMigration $true $false } }
  finally { [AnubisInstaller.UserMigration]::DeleteKey($linkKey); $linkKey.Dispose() }
  $foreign = $registry.OpenSubKey($foreignClass)
  try { if ($foreign.GetValue('') -cne 'foreign-marker-must-survive') { throw 'Registry link target changed' } } finally { $foreign.Dispose() }
  Write-Registration ($classRoot+'\\shell\\open\\command') @{''=('"'+$oldExe+'" "%1"')}
  Expect-Rejection 'MIGRATEPERUSER' { Invoke-UserMigration $false $false }
  function Get-MigrationInteractiveSid { return 'S-1-5-21-1-2-3-1001' }
  Expect-Rejection 'Different-account' { Invoke-UserMigration $true $false }
  function Get-MigrationInteractiveSid { return $sid }
  Write-Registration $unregistration @{UninstallString='"C:\\Windows\\System32\\cmd.exe" /c bad'}
  Expect-Rejection 'Foreign or noncanonical' { Invoke-UserMigration $true $false }
  Write-Registration $unregistration @{UninstallString=('"'+$oldUninstaller+'" /currentuser')}
  $nativeLink.Arguments = '--not-allowed'
  $nativeLink.Save()
  Expect-Rejection 'arguments' { Invoke-UserMigration $true $false }
  [IO.File]::WriteAllBytes($link, $validShortcut)
  Write-Registration ($classRoot+'\\shell\\open\\command') @{''=($oldExe+' "%1"')}
  if ($oldExe -notmatch '\\s') { Invoke-UserMigration $true $false }
  else { Expect-Rejection 'Malformed' { Invoke-UserMigration $true $false } }
  Write-Registration ($classRoot+'\\shell\\open\\command') @{''=('"'+$oldExe+'" "%1" --not-allowed')}
  Expect-Rejection 'Malformed' { Invoke-UserMigration $true $false }
  Write-Registration ($classRoot+'\\shell\\open\\command') @{''=('"'+$oldExe+'" "%1"')}
  $unrelated = Join-Path $root 'unrelated.exe'
  [IO.File]::WriteAllText($unrelated, 'DUMMY NEVER EXECUTE')
  [IO.File]::WriteAllBytes($link, [AnubisInstaller.UserMigration]::Shortcut($unrelated))
  Expect-Rejection 'Foreign shortcut' { Invoke-UserMigration $true $false }
  [IO.File]::WriteAllBytes($link, $validShortcut)
  $hardlink = Join-Path $root 'hard-linked-shortcut'
  $null = New-Item -ItemType HardLink -Path $hardlink -Target $link
  Expect-Rejection 'hard-linked' { Invoke-UserMigration $true $false }
  [IO.File]::Delete($hardlink)
  $junction = Join-Path $root 'junction'
  $null = New-Item -ItemType Junction -Path $junction -Target $folders.LegacyRoot
  $realRoot = $folders.LegacyRoot
  $folders.LegacyRoot = $junction
  $redirected = Join-Path $junction $contract.Leaf
  Write-Registration $registration @{InstallLocation=$redirected}
  Write-Registration $unregistration @{UninstallString=('"'+(Join-Path $redirected 'Uninstall anubis.exe')+'" /currentuser');QuietUninstallString=('"'+(Join-Path $redirected 'Uninstall anubis.exe')+'" /currentuser /S')}
  Expect-Rejection 'reparse' { Invoke-UserMigration $true $false }
  $folders.LegacyRoot = $realRoot
  Write-Registration $registration @{InstallLocation=$legacy}
  Write-Registration $unregistration @{UninstallString=('"'+$oldUninstaller+'" /currentuser');QuietUninstallString=('"'+$oldUninstaller+'" /currentuser /S')}
  Invoke-UserMigration $true $false
  $data = Join-Path $root 'machine-data'
  $null = [IO.Directory]::CreateDirectory($data, (New-PackageAcl $true -Private))
  function Get-NativeProgramData { return $data }
  $hostRoot = $data
  foreach ($leaf in @('Anubis','Host',$ServiceName)) {
    $hostRoot = Join-Path $hostRoot $leaf
    $null = [IO.Directory]::CreateDirectory($hostRoot, (New-PackageAcl $true -Private))
  }
  function Assert-NativePackage {}
  $machineUninstaller = Join-Path $InstallDir 'Uninstall anubis.exe'
  [IO.File]::WriteAllText($machineUninstaller, 'DUMMY MACHINE UNINSTALLER NEVER EXECUTE')
  $script:stageStarts = 0
  $script:stageExitCode = 0
  $newObjectCmdlet = Get-Command New-Object -CommandType Cmdlet
  function New-Object {
    param([Parameter(Position=0)][string] $TypeName, [Parameter(Position=1)][object[]] $ArgumentList)
    if ($TypeName -ceq 'Diagnostics.Process') {
      $fake = [pscustomobject]@{StartInfo=$null;ExitCode=$script:stageExitCode}
      $fake | Add-Member -MemberType ScriptMethod -Name Start -Value {
        $file = $this.StartInfo.FileName
        if ($file -notlike ($hostRoot+'\\uninstall-*\\old-machine-uninstaller.exe') -or $this.StartInfo.UseShellExecute) { throw 'Unsafe uninstaller launch boundary' }
        if ($this.StartInfo.Arguments -cne ('/allusers /S --updated --keep-shortcuts _?='+$InstallDir)) { throw 'Wrong protected update arguments' }
        Assert-PrivatePath $file
        $blocked = $false
        try { $writer = [IO.File]::Open($file,[IO.FileMode]::Open,[IO.FileAccess]::Write,[IO.FileShare]::Read); $writer.Dispose() }
        catch [IO.IOException] { $blocked = $true }
        if (-not $blocked) { throw 'Staged uninstaller was not locked against modification' }
        $sourceProbe = [IO.File]::Open($machineUninstaller,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
        $sourceProbe.Dispose()
        if ([IO.File]::ReadAllText($file) -cne 'DUMMY MACHINE UNINSTALLER NEVER EXECUTE') { throw 'Uninstaller payload differed' }
        $script:stageStarts++
        return $true
      }
      $fake | Add-Member -MemberType ScriptMethod -Name WaitForExit -Value {}
      $fake | Add-Member -MemberType ScriptMethod -Name Dispose -Value {}
      return $fake
    }
    return (& $newObjectCmdlet @PSBoundParameters)
  }
  try {
    Uninstall-PreviousMachinePackage
    $script:stageExitCode = 37
    Expect-Rejection 'failed: 37' { Uninstall-PreviousMachinePackage }
  } finally { Remove-Item Function:\\New-Object }
  if ($script:stageStarts -ne 2 -or @(Get-ChildItem -LiteralPath $hostRoot -Filter 'uninstall-*').Count -ne 0) { throw 'Protected staging was not cleaned after success/failure' }
  Invoke-UserMigration $true $true
  foreach ($key in @($registration,$unregistration)) {
    $left = $registry.OpenSubKey($key)
    if ($null -ne $left) { $left.Dispose(); throw 'Legacy install/uninstall registration remained' }
  }
  $commandKey = $registry.OpenSubKey($classRoot+'\\shell\\open\\command')
  try { if ($commandKey.GetValue('') -cne ('"'+$newExe+'" "%1"')) { throw 'Wrong migrated command' } } finally { $commandKey.Dispose() }
  if ([AnubisInstaller.UserMigration]::ShortcutTarget([IO.File]::ReadAllBytes($link)) -cne $newExe) { throw 'Wrong migrated shortcut' }
  $shell = New-Object -ComObject WScript.Shell
  $windowsTarget = $shell.CreateShortcut($link).TargetPath
  if ($windowsTarget -ine $newExe) { throw "Windows did not recognize generated shortcut: '$windowsTarget', expected '$newExe'" }
  if ([Convert]::ToBase64String([IO.File]::ReadAllBytes($private)) -cne [Convert]::ToBase64String($beforePrivate)) { throw 'Private state changed' }
  if ([Convert]::ToBase64String([IO.File]::ReadAllBytes($oldExe)) -cne [Convert]::ToBase64String($beforeExe)) { throw 'Legacy payload changed' }
  if (-not (Test-Path -LiteralPath $oldUninstaller)) { throw 'Legacy uninstaller deleted' }
  $report = Join-Path $hostRoot 'user-migration.json'
  Assert-PrivatePath $report
  $record = [IO.File]::ReadAllText($report) | ConvertFrom-Json
  if ($record.status -cne 'complete' -or $record.sid -cne $sid -or $record.retainedLegacyDirectory -cne $legacy) { throw 'Wrong retained-backup report' }
  Invoke-UserMigration $false $false
  $originalReport = [IO.File]::ReadAllText($report)
  $record.sid = 'S-1-5-21-1-2-3-1001'
  [IO.File]::WriteAllText($report, ($record | ConvertTo-Json -Depth 5))
  Remove-MigratedUserBindings
  if (-not (Test-Path -LiteralPath $link)) { throw 'Other-user binding was removed' }
  [IO.File]::WriteAllText($report, $originalReport)
  [IO.File]::WriteAllBytes($link, [AnubisInstaller.UserMigration]::Shortcut($unrelated))
  Write-Registration ($classRoot+'\\shell\\open\\command') @{''=('"'+$unrelated+'" "%1"')}
  Remove-MigratedUserBindings
  if (-not (Test-Path -LiteralPath $link)) { throw 'Changed shortcut was deleted' }
  [IO.File]::WriteAllBytes($link, [AnubisInstaller.UserMigration]::Shortcut($newExe))
  Write-Registration ($classRoot+'\\shell\\open\\command') @{''=('"'+$newExe+'" "%1"')}
  Remove-MigratedUserBindings
  if (Test-Path -LiteralPath $link) { throw 'Verified migrated shortcut was not removed' }
  $left = $registry.OpenSubKey($classRoot+'\\shell\\open\\command')
  if ($null -ne $left) { $left.Dispose(); throw 'Verified migrated shell command remained' }
  if (-not (Test-Path -LiteralPath $oldExe) -or -not (Test-Path -LiteralPath $private)) { throw 'Cleanup removed retained user state' }
  Write-Output 'REAL_QA_REGISTRY_FILES_SHORTCUTS_AND_PRIVATE_STATE_OK'
} finally {
  foreach ($key in $owned) { $registry.DeleteSubKeyTree($key, $false) }
  $registry.Dispose()
}
`
    const fixtureScript = path.join(dir, 'migration-fixture.ps1')
    fs.writeFileSync(fixtureScript, '\uFEFF' + source)
    const result = spawnSync(path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-File', fixtureScript
    ], { encoding: 'utf8', timeout: 55000, windowsHide: true })
    assert.ifError(result.error)
    assert.equal(result.status, 0, result.stdout + result.stderr)
    if (result.stdout.includes('FIXTURE_REQUIRES_ADMIN')) return t.skip('Real private ACL fixture requires an elevated administrator')
    assert.match(result.stdout, /REAL_QA_REGISTRY_FILES_SHORTCUTS_AND_PRIVATE_STATE_OK/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
