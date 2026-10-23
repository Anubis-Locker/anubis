const { test } = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const load = () => import('../../client/components/terminal/mcp-pty-command.js')
const marker = '__ET_EXEC_test__'

test('PTY capture waits for the actual mounted terminal and open transport before sending', async () => {
  const { waitForPtyReady } = await load()
  const terminal = { term: {}, attachAddon: { _sendData () {}, _socket: { readyState: 0 } } }
  let current
  const timer = setTimeout(() => {
    current = terminal
    terminal.attachAddon._socket.readyState = 1
  }, 10)
  try {
    assert.equal(await waitForPtyReady(() => current, 500), terminal)
  } finally {
    clearTimeout(timer)
  }
})

test('missing or closed PTY transports are explicit errors, not success-shaped dropped commands', async () => {
  const { waitForPtyReady } = await load()
  for (const value of [null, { term: {} }, { term: {}, attachAddon: { _sendData () {}, _socket: { readyState: 3 } } }]) {
    await assert.rejects(waitForPtyReady(() => value, 10), /Terminal connection is not ready/)
  }
})

test('POSIX PTY capture retains its existing subshell and numeric exit sentinel', async () => {
  const { createPtyCommand } = await load()
  assert.equal(createPtyCommand('printf hello; exit 7', marker),
    `echo "${marker}S"; ( printf hello; exit 7 ); echo "${marker}E$?"`)
})

test('PowerShell wrapper encodes quotes, Unicode and multiline commands without parent-shell evaluation', async () => {
  const { createPtyCommand } = await load()
  const command = 'Write-Output "\u041f\u0440\u0438\u0432\u0435\u0442 \'quoted\'"\nexit 37'
  const value = createPtyCommand(command, marker, '"C:\\Program Files\\PowerShell\\7\\pwsh.exe"')
  assert.match(value, /Join-Path \$PSHOME 'pwsh.exe'/)
  const encoded = value.match(/-EncodedCommand ([A-Za-z0-9+/=]+)/)[1]
  assert.ok(Buffer.from(encoded, 'base64').toString('utf16le').startsWith(command + '\n'))
  assert.ok(!value.includes(command))
  assert.ok(!value.includes('E$?'))
})

test('real Windows PowerShell emits exact numeric statuses and contains exit without killing the terminal wrapper', {
  skip: process.platform !== 'win32',
  timeout: 30000
}, async () => {
  const { createPtyCommand } = await load()
  const executable = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  for (const [command, expected] of [
    ['Write-Output "hello \'quoted\'"', 0],
    ['cmd.exe /d /c exit 37', 37],
    ['exit 23', 23],
    ['exit -1', -1],
    ['Write-Host -NoNewline "tail"', 0],
    ['Write-Error "expected-error"', 1],
    ['throw "expected-error"', 1],
    ['cmd.exe /d /c exit 37; Write-Output "recovered"', 0]
  ]) {
    const wrapped = createPtyCommand(command, marker, executable)
    const output = execFileSync(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand',
      Buffer.from(wrapped, 'utf16le').toString('base64')
    ], { encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    assert.match(output, new RegExp(`^${marker}S\\r?$`, 'm'))
    assert.match(output, new RegExp(`^${marker}E${expected}\\r?$`, 'm'), command)
  }
})
