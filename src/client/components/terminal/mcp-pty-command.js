import { isPowerShellExecutable } from './ssh-reload-state.js'

export async function waitForPtyReady (getTerminal, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const terminal = getTerminal()
    if (terminal?.term && typeof terminal.attachAddon?._sendData === 'function' &&
        terminal.attachAddon._socket?.readyState === 1) return terminal
    await new Promise(resolve => setTimeout(resolve, Math.min(50, Math.max(1, deadline - Date.now()))))
  }
  throw new Error('Terminal connection is not ready for command execution')
}

export function createPtyCommand (command, marker, shell = '') {
  if (!isPowerShellExecutable(shell)) {
    return `echo "${marker}S"; ( ${command} ); echo "${marker}E$?"`
  }
  // A child shell preserves numeric native exit codes and contains `exit`.
  // PowerShell's $? is boolean, not the POSIX exit status.
  const script = command + '\n' +
    '$anubisSucceeded = $?; $anubisExitCode = $LASTEXITCODE; ' +
    'if ($anubisSucceeded) { exit 0 }; ' +
    'if ($null -ne $anubisExitCode) { exit $anubisExitCode }; exit 1'
  let bytes = ''
  for (let i = 0; i < script.length; i++) {
    const unit = script.charCodeAt(i)
    bytes += String.fromCharCode(unit & 255, unit >>> 8)
  }
  const executable = /(?:^|[/\\])pwsh(?:\.exe)?$/i.test(shell.trim().replace(/^"|"$/g, ''))
    ? 'pwsh.exe'
    : 'powershell.exe'
  return `Write-Output '${marker}S'; $global:LASTEXITCODE = 1; ` +
    `& (Join-Path $PSHOME '${executable}') -NoLogo -NoProfile -EncodedCommand ${btoa(bytes)}; ` +
    `Write-Output ''; Write-Output ('${marker}E' + $LASTEXITCODE)`
}
