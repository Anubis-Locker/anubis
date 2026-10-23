const { it } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { copyWindowsMachineHost } = require('../../build/bin/windows-machine-host')

const script = path.resolve(__dirname, '../../build/windows-machine-install.ps1')
const include = fs.readFileSync(path.resolve(__dirname, '../../build/windows-installer.nsh'), 'utf8')

it('builds an amd64 helper from source alongside the runtime, without a machine marker', () => {
  const appOutDir = fs.mkdtempSync(path.join(os.tmpdir(), 'anubis-machine-build-'))
  try {
    fs.writeFileSync(path.join(appOutDir, 'anubis-machine-install.json'), 'stale')
    let called = false
    copyWindowsMachineHost({ appOutDir }, 'x64', (command, args, options) => {
      called = true
      assert.equal(command, process.env.ANUBIS_GO || 'go')
      assert.deepEqual(args.slice(0, 4), ['build', '-trimpath', '-buildvcs=false', '-o'])
      assert.equal(options.env.GOOS, 'windows')
      assert.equal(options.env.GOARCH, 'amd64')
      assert.equal(options.env.CGO_ENABLED, '0')
      assert.equal(options.cwd, path.resolve('native/windows-host'))
      const image = Buffer.alloc(128)
      image.write('MZ')
      image.writeUInt32LE(64, 0x3c)
      image.write('PE\0\0', 64)
      image.writeUInt16LE(0x8664, 68)
      fs.writeFileSync(args[4], image)
    })
    assert.ok(called)
    assert.ok(fs.existsSync(path.join(appOutDir, 'anubis-host.exe')))
    assert.ok(!fs.existsSync(path.join(appOutDir, 'anubis-machine-install.json')))
    assert.throws(() => copyWindowsMachineHost({ appOutDir }, 'x64', () => {
      fs.writeFileSync(path.join(appOutDir, 'anubis-host.exe'), Buffer.alloc(128))
    }), /amd64 PE/)
    copyWindowsMachineHost({ appOutDir }, 'arm64', () => assert.fail('unsupported native build'))
    assert.ok(!fs.existsSync(path.join(appOutDir, 'anubis-host.exe')))
  } finally {
    fs.rmSync(appOutDir, { recursive: true, force: true })
  }
})

it('normal preparation includes all machine client surfaces without a special staging path', () => {
  const prepare = fs.readFileSync(path.resolve(__dirname, '../../build/bin/prepare.js'), 'utf8')
  assert.match(prepare, /cp\('-r', 'src\/app', 'work\/'\)/)
  for (const file of ['machine-client.html', 'machine-client-ui.js', 'preload/machine-client.js']) {
    assert.ok(fs.existsSync(path.resolve(__dirname, '../../app', file)))
  }
})

it('stops the exact service before checking app processes and preserves service/config on update', () => {
  assert.ok(include.indexOf('!insertmacro AnubisMachineAction Stop') < include.indexOf('nsProcess::_FindProcess'))
  assert.match(include, /\$\{IfNot\} \$\{isUpdated\}\s+!insertmacro AnubisMachineAction Remove/)
  assert.match(include, /Call un.atomicRMDir/)
  assert.match(include, /!ifdef APP_ARM64\s+!error/)
  assert.match(include, /!ifdef APP_32\s+!error/)
  const deployment = fs.readFileSync(script, 'utf8')
  assert.doesNotMatch(deployment, /Stop-Process|New-Service|sc\.exe|schtasks|Remove-Item|Copy-Item/i)
  assert.match(deployment, /Get-NativeProgramFiles/)
  assert.match(deployment, /SetOwner/)
  assert.match(deployment, /SetAccessRuleProtection\(\$true, \$false\)/)
  assert.match(deployment, /Wait-ServiceState 4/)
  assert.match(deployment, /machine\.identity\.sid -ne 'S-1-5-18'/)
})

it('executes deployment safety and lifecycle logic with fake SCM/native boundaries only', {
  skip: process.platform !== 'win32'
}, () => {
  const source = `
. '${script.replaceAll("'", "''")}' -DefinitionsOnly
function Assert-Test($condition, $message) { if (-not $condition) { throw $message } }
$programFiles = Get-NativeProgramFiles
Assert-Test ([IO.Path]::IsPathRooted($programFiles)) 'native KnownFolder must be absolute'
Assert-TrustedAcl $programFiles
# Exercise real ACL construction/inspection without modifying any filesystem ACL.
$packageAcl = New-PackageAcl $true
Assert-Test ($packageAcl.AreAccessRulesProtected) 'package DACL must be protected'
Assert-Test ($packageAcl.GetOwner([Security.Principal.SecurityIdentifier]).Value -eq 'S-1-5-32-544') 'package owner must be Administrators'
$users = @($packageAcl.GetAccessRules($true, $false, [Security.Principal.SecurityIdentifier]) | Where-Object { $_.IdentityReference.Value -eq 'S-1-5-32-545' })
$readOnly = [int][Security.AccessControl.FileSystemRights]::ReadAndExecute -bor [int][Security.AccessControl.FileSystemRights]::Synchronize
Assert-Test ($users.Count -eq 1 -and [int]$users[0].FileSystemRights -eq $readOnly) 'Users must have read/execute only'
function Get-Acl { return $script:packageAcl }
Assert-TrustedAcl 'synthetic-package'
$packageAcl.SetOwner((New-Object Security.Principal.SecurityIdentifier('S-1-5-21-1-2-3-1001')))
$failed = $false
try { Assert-TrustedAcl 'synthetic-package' } catch { $failed = $_.Exception.Message -match 'Untrusted owner' }
Assert-Test $failed 'individual admin/user owner must be rejected'
$script:packageAcl = New-PackageAcl $false
$rule = New-Object Security.AccessControl.FileSystemAccessRule(
  (New-Object Security.Principal.SecurityIdentifier('S-1-5-32-545')),
  [Security.AccessControl.FileSystemRights]::Write, [Security.AccessControl.AccessControlType]::Allow)
$packageAcl.AddAccessRule($rule)
$failed = $false
try { Assert-TrustedAcl 'synthetic-package' } catch { $failed = $_.Exception.Message -match 'Untrusted writer' }
Assert-Test $failed 'broad writable package must be rejected'
$ownedServiceFunction = \${function:Get-OwnedService}
$script:InstallDir = 'C:\\Program Files\\Anubis-Security-Tool'
$script:nativeCalls = @()
$script:states = @(4, 3, 1)
$script:index = 0
function Assert-NativePackage {}
function Get-OwnedService {
  $state = $script:states[[Math]::Min($script:index, $script:states.Count - 1)]
  $script:index++
  return @{ scm = @{ State = $state; Win32ExitCode = 1 } }
}
function Invoke-Host($Arguments, [switch] $Json) {
  Assert-Test ($Arguments.Count -eq 3 -and $Arguments[1] -eq '--name' -and $Arguments[2] -eq 'AnubisHost') 'exact named service is required'
  $script:nativeCalls += $Arguments[0]
  if ($Json) { throw 'start/stop must not request JSON' }
}
function Start-Sleep {}
Stop-OwnedService
Assert-Test ($script:nativeCalls.Count -eq 1 -and $script:nativeCalls[0] -eq 'stop') 'wrong stop selector'
$script:states = @(1); $script:index = 0
$script:nativeCalls = @()
Stop-OwnedService
Assert-Test ($script:nativeCalls.Count -eq 0) 'stopped service must not receive stop'
$failed = $false
try { Wait-ServiceState 4 } catch { $failed = $_.Exception.Message -match 'before readiness' }
Assert-Test $failed 'engine startup failure must be fatal'
# Check displaced service protection using the real Get-OwnedService function.
function Get-Service { return @{ ServiceName = 'AnubisHost' } }
function Invoke-Host($Arguments, [switch] $Json) {
  return @{ imagePath = 'C:\\Unrelated\\host.exe'; account = 'LocalSystem'; automatic = $true }
}
$failed = $false
try { & $ownedServiceFunction } catch { $failed = $_.Exception.Message -match 'different image/account/start mode' }
Assert-Test $failed 'a displaced same-name service must not be modified'
# A bad destination must fail before filesystem traversal or any ACL/SCM writes.
function Get-NativeProgramFiles { return 'C:\\Program Files' }
function Assert-NotReparse { throw 'unexpected filesystem access' }
$failed = $false
try { Assert-Destination 'C:\\Users\\Someone\\Anubis-Security-Tool' } catch {
  $failed = $_.Exception.Message -match 'canonical machine installation'
}
Assert-Test $failed 'custom destination was not rejected before filesystem access'
Write-Output 'Deployment safety/lifecycle assertions passed without SCM mutations'
`
  const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', source], {
    encoding: 'utf8', timeout: 30000
  })
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.match(result.stdout, /assertions passed without SCM mutations/)
})
