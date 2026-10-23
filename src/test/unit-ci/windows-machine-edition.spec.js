const { it } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { getConfig } = require('app-builder-lib/out/util/config/config')
const {
  production, installerQa, migrationQa, qaAppId, qaGuid, validateEdition, configureInstallerQa
} = require('../../build/bin/windows-machine-edition')

it('permits only complete fixed compile-time production and isolated installer QA definitions', () => {
  assert.equal(validateEdition({ ...production }), production)
  assert.equal(validateEdition({ ...installerQa }), installerQa)
  assert.equal(validateEdition({ ...migrationQa }), migrationQa)
  for (const value of [
    null, [], {}, { ...production, extra: true }, { ...production, version: '1' },
    { ...installerQa, disableManaged: false }, { ...production, installLeaf: '..' },
    { ...installerQa, serviceName: 'AnubisHost' }, { ...production, serviceName: 'AnubisHost-QA-untrusted' },
    { ...migrationQa, installLeaf: installerQa.installLeaf }, { ...migrationQa, serviceName: installerQa.serviceName }
  ]) {
    assert.throws(() => validateEdition(value), /edition/i)
  }
})

it('generates an isolated NSIS edition with no shell registrations and the actual fixed marker service', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anubis-edition-'))
  try {
    const base = require('../../build/electron-builder.json')
    const before = JSON.stringify(base)
    const config = configureInstallerQa(base, dir)
    const configFile = path.join(dir, 'qa-builder.json')
    fs.writeFileSync(configFile, JSON.stringify(config))
    // Inline option objects merge arrays with production config. Load the QA file itself.
    const effective = await getConfig(process.cwd(), configFile)
    assert.deepEqual(effective.protocols, [])
    assert.deepEqual(effective.fileAssociations, [])
    assert.equal(effective.nsis.guid, qaGuid)
    assert.equal(JSON.stringify(base), before)
    assert.equal(base.appId, 'locker.anubis.securitytool')
    assert.equal(config.appId, qaAppId)
    assert.equal(config.nsis.guid, qaGuid)
    assert.deepEqual(config.protocols, [])
    assert.deepEqual(config.fileAssociations, [])
    for (const key of ['createDesktopShortcut', 'createStartMenuShortcut', 'runAfterFinish']) {
      assert.equal(config.nsis[key], false)
    }
    const wrapper = fs.readFileSync(config.nsis.include, 'utf8')
    assert.match(wrapper, /ANUBIS_MACHINE_LEAF "Anubis-Security-Tool-QA-installer-7e66c0f5"/)
    assert.match(wrapper, /redef isKeepShortcuts "1 == 1"/)
    assert.match(wrapper, /redef isForceRun "0 == 1"/)
    assert.match(wrapper, /anubis-qa-installer-7e66c0f5-updater\\installer.exe/)
    const script = path.join(dir, 'windows-machine-install.ps1')
    const deployment = fs.readFileSync(script, 'utf8')
    assert.ok(deployment.includes(`$CompiledEditionJson = '${JSON.stringify(installerQa)}'`))
    assert.match(deployment, /version = 1; serviceName = \$ServiceName/)
    assert.ok(deployment.indexOf('\n      Protect-QaMachinePolicy') < deployment.indexOf("Invoke-Host @('start'"))
    assert.match(deployment, /\{"managedEnabled":false\}/)
    if (process.platform === 'win32') {
      const source = `
. '${script.replaceAll("'", "''")}' -DefinitionsOnly
if ($ServiceName -cne '${installerQa.serviceName}' -or $InstallLeaf -cne '${installerQa.installLeaf}') { throw 'wrong compiled edition' }
if (-not $CompiledEdition.disableManaged) { throw 'QA must disable enrollment' }
function Get-NativeProgramFiles { return 'C:\\Program Files' }
function Assert-NotReparse { throw 'must not inspect the production package' }
$failed = $false
try { Assert-Destination 'C:\\Program Files\\Anubis-Security-Tool' } catch {
  $failed = $_.Exception.Message -match 'canonical machine installation'
}
if (-not $failed) { throw 'QA accepted a production package path' }
foreach ($json in @(
  '{"version":1,"edition":"production","serviceName":"AnubisHost-QA-bad","installLeaf":"Anubis-Security-Tool","disableManaged":false}',
  '{"version":"1","edition":"production","serviceName":"AnubisHost","installLeaf":"Anubis-Security-Tool","disableManaged":false}',
  '{"version":1,"edition":"production","serviceName":["AnubisHost"],"installLeaf":"Anubis-Security-Tool","disableManaged":false}',
  '{"version":1,"edition":"installer-qa-7e66c0f5","serviceName":"AnubisHost-QA-installer-7e66c0f5","installLeaf":"Anubis-Security-Tool","disableManaged":true}'
)) {
  $failed = $false
  try { Assert-InstallerEdition ($json | ConvertFrom-Json) } catch { $failed = $true }
  if (-not $failed) { throw 'invalid edition accepted' }
}
$private = New-PackageAcl $true -Private
if (-not $private.AreAccessRulesProtected) { throw 'private ACL inherits' }
foreach ($rule in $private.GetAccessRules($true, $false, [Security.Principal.SecurityIdentifier])) {
  if ($rule.IdentityReference.Value -notin @('S-1-5-18','S-1-5-32-544')) { throw 'broad private policy rights' }
}
Write-Output 'QA_EDITION_SCHEMA_AND_PRIVATE_POLICY_ACL_OK'
`
      const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', source], {
        encoding: 'utf8', timeout: 30000
      })

      assert.equal(result.status, 0, result.stdout + result.stderr)
      assert.match(result.stdout, /QA_EDITION_SCHEMA_AND_PRIVATE_POLICY_ACL_OK/)
      const override = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', script, '-DefinitionsOnly', '-ServiceName', 'AnubisHost'], {
        encoding: 'utf8', timeout: 30000
      })
      assert.notEqual(override.status, 0)
      assert.match(override.stderr, /Unexpected installer arguments|parameter/i)
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

it('creates the real private disabled policy before start and refuses enabled retained policy', {
  skip: process.platform !== 'win32'
}, t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anubis-qa-policy-'))
  try {
    configureInstallerQa(require('../../build/electron-builder.json'), dir)
    const script = path.join(dir, 'windows-machine-install.ps1')
    const data = path.join(dir, 'data')
    fs.mkdirSync(data)
    const source = `
. '${script.replaceAll("'", "''")}' -DefinitionsOnly
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Output 'FIXTURE_REQUIRES_ADMIN'
  exit 0
}
function Get-NativeProgramData { return '${data.replaceAll("'", "''")}' }
$InstallDir = 'C:\\Program Files\\${installerQa.installLeaf}'
$root = Get-NativeProgramData
foreach ($leaf in @('Anubis', 'Host', $ServiceName)) {
  $root = Join-Path $root $leaf
  $null = [IO.Directory]::CreateDirectory($root, (New-PackageAcl $true -Private))
}
$hostFile = Join-Path $root 'host.json'
$hostJson = @{ version=1; serviceName=$ServiceName; installDir=$InstallDir; runtimeRelativePath='anubis.exe'; allowedUserSids=@() } | ConvertTo-Json
[IO.File]::WriteAllText($hostFile, $hostJson)
Set-Acl -LiteralPath $hostFile -AclObject (New-PackageAcl $false -Private)
Protect-QaMachinePolicy
$policyFile = Join-Path $root 'system-profile\\machine-policy.json'
Assert-PrivatePath $policyFile
if ([IO.File]::ReadAllText($policyFile) -cne '{"managedEnabled":false}') { throw 'wrong QA policy' }
Protect-QaMachinePolicy
[IO.File]::WriteAllText($policyFile, '{"managedEnabled":true}')
$failed = $false
try { Protect-QaMachinePolicy } catch { $failed = $_.Exception.Message -match 'Retained QA policy' }
if (-not $failed -or [IO.File]::ReadAllText($policyFile) -cne '{"managedEnabled":true}') { throw 'enabled policy must fail without overwrite' }
$profile = Split-Path -Parent $policyFile
Set-Acl -LiteralPath $profile -AclObject (New-PackageAcl $true)
$before = (Get-Acl -LiteralPath $profile).Sddl
$failed = $false
try { Protect-QaMachinePolicy } catch { $failed = $_.Exception.Message -match 'Unrelated principal' }
if (-not $failed -or (Get-Acl -LiteralPath $profile).Sddl -cne $before) { throw 'insecure retained profile must fail without ACL repair' }
Write-Output 'REAL_PRIVATE_POLICY_FIXTURE_OK_NO_SCM'
`
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', source], {
      encoding: 'utf8', timeout: 30000
    })
    assert.equal(result.status, 0, result.stdout + result.stderr)
    if (result.stdout.includes('FIXTURE_REQUIRES_ADMIN')) return t.skip('ACL filesystem fixture requires an elevated test account')
    assert.match(result.stdout, /REAL_PRIVATE_POLICY_FIXTURE_OK_NO_SCM/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
