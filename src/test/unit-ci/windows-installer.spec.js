const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const brand = require('../../common/brand.config')
const config = require('../../build/electron-builder.json')
const include = fs.readFileSync(path.resolve(__dirname, '../../build/windows-installer.nsh'), 'utf8')

describe('Windows installer contract', () => {
  it('registers exactly the branded OS protocols, without legacy parser aliases', () => {
    const schemes = config.protocols.flatMap(protocol => protocol.schemes).sort()
    assert.deepEqual(schemes, [brand.protocol.custom, ...brand.protocol.extra].sort())
    for (const legacy of brand.protocol.legacyCustom) {
      assert.ok(!schemes.includes(legacy))
    }
  })

  it('elevates only the installer, before process creation completes', () => {
    assert.equal(config.win.requestedExecutionLevel, 'asInvoker')
    assert.equal(config.nsis.include, 'src/build/windows-installer.nsh')
    assert.match(include, /!macro customHeader[\s\S]*?!ifndef BUILD_UNINSTALLER\s+RequestExecutionLevel admin\s+SilentInstall silent/)
    assert.match(include, /!ifdef BUILD_UNINSTALLER\s+RequestExecutionLevel admin/)
    assert.doesNotMatch(include, /UAC_RunElevated|ExecShell.*runas/i)
  })

  it('requires canonical per-machine installation and explicitly preserves app data', () => {
    assert.equal(config.nsis.oneClick, false)
    assert.equal(config.nsis.perMachine, true)
    assert.equal(config.nsis.allowToChangeInstallationDirectory, false)
    assert.equal(config.nsis.runAfterFinish, false)
    assert.equal(config.nsis.deleteAppDataOnUninstall, false)
    assert.match(include, /!define \/ifndef ANUBIS_MACHINE_LEAF "Anubis-Security-Tool"/)
    assert.match(include, /StrCpy \$INSTDIR "\$PROGRAMFILES64\\\$\{ANUBIS_MACHINE_LEAF\}"/)
    assert.match(include, /ReadRegStr \$0 HKCU/)
    assert.match(include, /Automatic migration is refused/)
    assert.match(include, /\$\{isDeleteAppData\}[\s\S]+SetErrorLevel 87/)
  })

  it('supports console output, explicit errors and only verified success', () => {
    assert.match(include, /\$\{GetOptions\} \$R0 "--console"/)
    assert.match(include, /WriteConsoleW/)
    assert.match(include, /WriteFile/)
    assert.match(include, /SetErrorLevel 1/)
    assert.match(include, /Function \.onInstSuccess\s+SetErrorLevel 0/)
    assert.match(include, /customUnInstallCheckCurrentUser/)
    assert.match(include, /SetErrorLevel \$R0/)
    for (const arch of ['x64', 'ia32', 'arm64']) {
      assert.match(include, new RegExp(`!macro customFiles_${arch}\\s+!insertmacro AnubisCheckCopiedFiles`))
    }
    assert.match(include, /AnubisVerifyCopiedFile "resources\\app.asar"/)
    assert.match(include, /AnubisVerifyCopiedFile "anubis-host.exe"/)
    assert.match(include, /AnubisMachineAction Finish/)
    for (const line of include.split(/\r?\n/).filter(line => /^\s*MessageBox\b/.test(line))) {
      assert.match(line, /\/SD IDOK$/, 'Silent errors must not block on a dialog: ' + line)
    }
  })

  it('invokes native x64 PowerShell from both 32-bit NSIS deployment paths', () => {
    const commands = include.split(/\r?\n/).filter(line => /nsExec::ExecToLog/.test(line))
    assert.equal(commands.length, 2)
    for (const command of commands) {
      assert.ok(command.includes('"$WINDIR\\Sysnative\\WindowsPowerShell\\v1.0\\powershell.exe"'))
    }
    const script = fs.readFileSync(path.resolve(__dirname, '../../build/windows-machine-install.ps1'), 'utf8')
    assert.match(script, /if \(-not \[Environment\]::Is64BitProcess\) \{ throw 'Machine installation requires native x64 PowerShell' \}/)
  })

  it('resolves the native KnownFolder through Sysnative from a real x86 process without deployment', {
    skip: process.platform !== 'win32',
    timeout: 30000
  }, () => {
    const systemRoot = process.env.SystemRoot
    const quote = value => "'" + value.replace(/'/g, "''") + "'"
    const encode = value => Buffer.from(value, 'utf16le').toString('base64')
    const script = path.resolve(__dirname, '../../build/windows-machine-install.ps1')
    const probe = `$ProgressPreference='SilentlyContinue'; . ${quote(script)} -DefinitionsOnly; [pscustomobject]@{process64=[Environment]::Is64BitProcess;programFiles=(Get-NativeProgramFiles)} | ConvertTo-Json -Compress`
    const nativePowerShell = path.join(systemRoot, 'Sysnative', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    const bridge = `$ProgressPreference='SilentlyContinue'; & ${quote(nativePowerShell)} -NoLogo -NoProfile -NonInteractive -EncodedCommand ${encode(probe)}; exit $LASTEXITCODE`
    const result = spawnSync(path.join(systemRoot, 'SysWOW64', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encode(bridge)
    ], { encoding: 'utf8', timeout: 25000, windowsHide: true })
    assert.equal(result.status, 0, `${result.error || ''}\n${result.stdout}\n${result.stderr}`)
    const value = JSON.parse(result.stdout.trim())
    assert.equal(value.process64, true)
    assert.ok(path.isAbsolute(value.programFiles))
    assert.ok(fs.statSync(value.programFiles).isDirectory())
  })

  it('waits for normal exit and never force-closes existing sessions', () => {
    assert.match(include, /!macro customCheckAppRunning/)
    assert.match(include, /StrCpy \$R2 120/)
    assert.match(include, /Sleep 500/)
    assert.match(include, /SetErrorLevel 1618/)
    assert.doesNotMatch(include, /_KillProcess|_CloseProcess|taskkill|Stop-Process|KILL_PROCESS/i)
  })
})
