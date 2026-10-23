const { it } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawn, spawnSync } = require('node:child_process')

const compiler = process.env.ANUBIS_NSIS_COMPILER
const plugins = process.env.ANUBIS_NSIS_PLUGINS

it('executes native installer hooks without touching an installation or registry', {
  skip: process.platform !== 'win32' || !compiler || !plugins
}, () => {
  const dir = fs.mkdtempSync(path.resolve('installer-contract-'))
  let ownedProcess
  try {
    const includeDir = path.join(path.dirname(require.resolve('app-builder-lib/package.json')), 'templates/nsis/include')
    const include = path.resolve(__dirname, '../../build/windows-installer.nsh')
    const exe = path.join(dir, 'hooks.exe')
    const script = path.join(dir, 'hooks.nsi')
    const fixture = path.join(dir, 'fixture.txt')
    fs.writeFileSync(fixture, 'owned installer verification fixture')
    fs.writeFileSync(script, `
Unicode true
RequestExecutionLevel user
SilentInstall silent
OutFile "${exe}"
!addincludedir "${includeDir}"
!addplugindir /x86-unicode "${plugins}"
!include "StdUtils.nsh"
!include "nsProcess.nsh"
!define VERSION "5.6.10"
!define APP_EXECUTABLE_FILENAME "anubis-native-hook-fixture.exe"
!define isDeleteAppData "0 == 1"
; The hook harness never invokes the deployment/SCM script.
!macro AnubisMachineAction ACTION
!macroend
!include "${include}"
Var installMode
Var hasPerMachineInstallation
Function .onInit
  SetErrorLevel 1
  StrCpy $AnubisConsoleMode 1
  System::Call 'kernel32::GetStdHandle(i -11) p.s'
  Pop $AnubisConsole
  StrCpy $INSTDIR "${dir}\\destination"
  \${StdUtils.GetParameter} $R9 "scenario" "copy-ok"
FunctionEnd
Section
  \${If} $R9 == "uninstall-failed"
    ClearErrors
    StrCpy $R0 740
    !insertmacro AnubisCheckUninstallResult
  \${ElseIf} $R9 == "uninstall-launch-failed"
    SetErrors
    StrCpy $R0 0
    !insertmacro AnubisCheckUninstallResult
  \${ElseIf} $R9 == "app-idle"
    !insertmacro customCheckAppRunning
  \${Else}
    InitPluginsDir
    CreateDirectory "$PLUGINSDIR\\7z-out\\resources"
    CreateDirectory "$INSTDIR\\resources"
    File /oname=$PLUGINSDIR\\7z-out\\anubis-native-hook-fixture.exe "${fixture}"
    File /oname=$PLUGINSDIR\\7z-out\\resources\\app.asar "${fixture}"
    File /oname=$PLUGINSDIR\\7z-out\\anubis-host.exe "${fixture}"
    CopyFiles /SILENT "$PLUGINSDIR\\7z-out\\anubis-native-hook-fixture.exe" "$INSTDIR"
    CopyFiles /SILENT "$PLUGINSDIR\\7z-out\\resources\\app.asar" "$INSTDIR\\resources"
    CopyFiles /SILENT "$PLUGINSDIR\\7z-out\\anubis-host.exe" "$INSTDIR"
    \${If} $R9 == "copy-corrupt"
      FileOpen $0 "$INSTDIR\\resources\\app.asar" w
      FileWrite $0 "corrupted"
      FileClose $0
    \${ElseIf} $R9 == "copy-missing"
      Delete "$INSTDIR\\resources\\app.asar"
    \${EndIf}
    ClearErrors
    \${If} $R9 == "copy-error"
      SetErrors
    \${EndIf}
    !insertmacro AnubisCheckCopiedFiles
  \${EndIf}
SectionEnd
`)
    const env = { ...process.env, TEMP: dir, TMP: dir }
    const compiled = spawnSync(compiler, ['/V2', script], { env, encoding: 'utf8', timeout: 60000 })
    assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr)
    for (const [scenario, status, message] of [
      ['copy-ok', 0, /Application files verified/],
      ['copy-corrupt', 5, /Cannot verify installed resources\\app.asar/],
      ['copy-missing', 5, /Missing extracted resources\\app.asar/],
      ['copy-error', 5, /extraction\/copy failed/],
      ['uninstall-failed', 740, /Exit code: 740/],
      ['uninstall-launch-failed', 2, /Exit code: 2/],
      ['app-idle', 0, /no sessions will be terminated/]
    ]) {
      const result = spawnSync(exe, [`--scenario=${scenario}`], { env, encoding: 'utf8', timeout: 15000 })
      assert.equal(result.status, status, `${scenario}: ${result.error || ''}\n${result.stdout}\n${result.stderr}`)
      assert.match(result.stdout, message, scenario)
      assert.match(result.stdout, new RegExp(`Exit code: ${status}`), scenario)
    }
    const holdExe = path.join(dir, 'anubis-native-hook-fixture.exe')
    fs.copyFileSync(path.join(process.env.SystemRoot, 'System32', 'ping.exe'), holdExe)
    ownedProcess = spawn(holdExe, ['-n', '90', '127.0.0.1'], { env, stdio: 'ignore', windowsHide: true })
    assert.ok(ownedProcess.pid, 'owned process was created')
    const busy = spawnSync(exe, ['--scenario=app-idle'], { env, encoding: 'utf8', timeout: 75000 })
    assert.equal(busy.status, 1618, busy.stdout + busy.stderr)
    assert.match(busy.stdout, /No sessions were terminated/)
    assert.equal(ownedProcess.exitCode, null, 'installer did not terminate the owned session')
    process.kill(ownedProcess.pid, 0)
  } finally {
    if (ownedProcess) ownedProcess.kill()
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
})
