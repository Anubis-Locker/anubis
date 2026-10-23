const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
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
    assert.match(include, /!macro customHeader\s+!ifndef BUILD_UNINSTALLER\s+RequestExecutionLevel admin\s+SilentInstall silent/)
    assert.doesNotMatch(include, /UAC_RunElevated|ExecShell.*runas/i)
  })

  it('retains upstream per-user detection and explicitly preserves app data', () => {
    assert.equal(config.nsis.oneClick, false)
    assert.equal(config.nsis.perMachine, false)
    assert.equal(config.nsis.deleteAppDataOnUninstall, false)
    assert.match(include, /\$installMode == "CurrentUser"\s+StrCpy \$hasPerMachineInstallation "0"/)
    assert.match(include, /EqualSid/)
    assert.match(include, /SetErrorLevel 1307/)
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
  })

  it('waits for normal exit and never force-closes existing sessions', () => {
    assert.match(include, /!macro customCheckAppRunning/)
    assert.match(include, /StrCpy \$R2 120/)
    assert.match(include, /Sleep 500/)
    assert.match(include, /SetErrorLevel 1618/)
    assert.doesNotMatch(include, /_KillProcess|_CloseProcess|taskkill|Stop-Process|KILL_PROCESS/i)
  })
})
