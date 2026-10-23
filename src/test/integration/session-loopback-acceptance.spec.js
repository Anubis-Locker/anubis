/**
 * Real backend sessions against private localhost fixtures.
 * Run: node --test src/test/integration/session-loopback-acceptance.spec.js
 * No Electron app, saved bookmarks, installed host, or shared profile is used.
 */
process.env.NODE_ENV = 'development'

const { test, after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createHash } = require('node:crypto')

const workspace = fs.mkdtempSync(path.join(__dirname, 'protocol-acceptance-'))
const savedEnv = {}
for (const name of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'sshKeysPath', 'SSH_AUTH_SOCK', 'SSH_AGENT_PID']) {
  savedEnv[name] = process.env[name]
  delete process.env[name]
}
for (const name of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) {
  process.env[name] = workspace
}
process.env.sshKeysPath = path.join(workspace, 'keys')
fs.mkdirSync(process.env.sshKeysPath)
assert.equal(os.homedir(), workspace)

const electronLog = require('electron-log')
electronLog.transports.file.resolvePath = () => path.join(workspace, 'backend.log')
require('../../app/server/ssh2-alg')
const { session: sshSession } = require('../../app/server/session-ssh')
const { Sftp } = require('../../app/server/session-sftp')
const { Ftp } = require('../../app/server/session-ftp')
const { Transfer: FtpTransfer } = require('../../app/server/ftp-transfer')
const { session: telnetSession } = require('../../app/server/session-telnet')
const globalState = require('../../app/server/global-state')
const { startTestSshServer, stopTestSshServer, TEST_USERNAME, TEST_PASSWORD } = require('./lib/ssh-test-server')
const { startTestFtpServer } = require('./lib/ftp-test-server')
const { startTestTelnetServer } = require('./lib/telnet-test-server')
const { createTrustingWs, waitFor } = require('./lib/ssh-session-harness')
electronLog.transports.file.level = false
electronLog.transports.console.level = false

after(() => {
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  fs.rmSync(workspace, { recursive: true, force: true })
})

const hash = data => createHash('sha256').update(data).digest('hex')

test('SSH executes a real command and SFTP round-trips a file through application sessions', { timeout: 20000 }, async () => {
  const rootDir = path.join(workspace, 'sftp-root')
  fs.mkdirSync(rootDir)
  const server = await startTestSshServer({ port: 0, rootDir })
  const ws = createTrustingWs()
  let term
  let sftp
  try {
    term = await sshSession({
      host: '127.0.0.1',
      port: server.address().port,
      username: TEST_USERNAME,
      password: TEST_PASSWORD,
      useSshAgent: false,
      enableSsh: true,
      readyTimeout: 5000,
      cols: 80,
      rows: 24
    }, ws)
    assert.equal(globalState.getSession(term.pid), term)
    assert.equal(ws.prompts.filter(prompt => prompt.mode === 'confirm').length, 1)
    assert.ok(fs.existsSync(path.join(workspace, '.ssh', 'known_hosts')))
    const command = `"${process.execPath}" -e "process.stdout.write('anubis-command-ok'.toUpperCase());process.stderr.write('fixture-stderr');process.exit(7)"`
    const result = await term.execCommand(command, { timeoutMs: 5000 })
    assert.deepEqual(result, {
      stdout: 'ANUBIS-COMMAND-OK',
      stderr: 'fixture-stderr',
      exitCode: 7,
      timedOut: false
    })
    const shellOutput = []
    term.on('data', data => shellOutput.push(data.toString()))
    term.write(`"${process.execPath}" -p "'anubis-shell-ok'.toUpperCase()"\n`)
    await waitFor(() => shellOutput.join('').includes('ANUBIS-SHELL-OK'))

    sftp = new Sftp({ type: 'sftp' })
    await sftp.connect({ terminalId: term.pid, enableSsh: true })
    assert.equal(sftp.isSshFsFallback, undefined, 'must exercise the real SFTP subsystem')
    const payload = 'Anubis SFTP roundtrip: \u03bb \u4e16\u754c\r\n' + 'payload\n'.repeat(16384)
    await sftp.writeFile('/roundtrip.txt', payload)
    const listing = await sftp.list('/')
    assert.ok(listing.some(entry => entry.name === 'roundtrip.txt'))
    const readback = await sftp.readFile('/roundtrip.txt')
    assert.equal(hash(Buffer.from(readback)), hash(Buffer.from(payload)))
    assert.deepEqual(fs.readFileSync(path.join(rootDir, 'roundtrip.txt')), Buffer.from(payload))
    assert.equal((await sftp.stat('/roundtrip.txt')).size, Buffer.byteLength(payload))
    await sftp.rm('/roundtrip.txt')
    assert.equal(fs.existsSync(path.join(rootDir, 'roundtrip.txt')), false)
  } finally {
    const sftpPid = sftp && sftp.pid
    const termPid = term && term.pid
    if (sftp) sftp.kill()
    if (term) term.kill()
    await waitFor(() => server._clients.size === 0)
    await stopTestSshServer(server)
    if (sftpPid) assert.equal(globalState.getSession(sftpPid), undefined)
    if (termPid) assert.equal(globalState.getSession(termPid), undefined)
  }
})

async function transferFtp (ftpSession, type, remotePath, localPath) {
  const events = []
  const id = `${type}-loopback`
  const transfer = new FtpTransfer({
    ftpSession,
    type,
    remotePath,
    localPath,
    id,
    ws: { s: event => events.push(event), close () {} }
  })
  try {
    await transfer.start()
    assert.deepEqual(events.filter(event => event.error), [])
    assert.ok(events.some(event => event.id === `transfer:end:${id}`))
  } finally {
    transfer.destroy()
  }
}

test('FTP lists, uploads, and downloads binary bytes through application session and transfer classes', { timeout: 20000 }, async () => {
  const rootDir = path.join(workspace, 'ftp-root')
  fs.mkdirSync(rootDir)
  const username = 'fixture-only'
  const password = 'fixture-only-password'
  const server = await startTestFtpServer({ rootDir, username, password })
  const ftp = new Ftp({
    host: '127.0.0.1',
    port: server.port,
    user: username,
    password,
    readyTimeout: 5000
  })
  const payload = Buffer.alloc(196867)
  for (let i = 0; i < payload.length; i++) payload[i] = i % 256
  const localPath = path.join(workspace, 'ftp-upload.bin')
  const downloaded = path.join(workspace, 'ftp-download.bin')
  fs.writeFileSync(localPath, payload)
  try {
    await ftp.connect(ftp.initOptions)
    assert.equal(globalState.getSession(ftp.pid), ftp)
    await transferFtp(ftp, 'upload', '/binary.bin', localPath)
    assert.deepEqual(fs.readFileSync(path.join(rootDir, 'binary.bin')), payload)
    const listing = await ftp.list('/')
    assert.ok(listing.some(entry => entry.name === 'binary.bin' && entry.size === payload.length))
    await transferFtp(ftp, 'download', '/binary.bin', downloaded)
    assert.deepEqual(fs.readFileSync(downloaded), payload)
    assert.equal(hash(fs.readFileSync(downloaded)), hash(payload))
    await ftp.rm('/binary.bin')
    assert.equal(fs.existsSync(path.join(rootDir, 'binary.bin')), false)
  } finally {
    ftp.kill()
    await server.close()
    assert.equal(globalState.getSession(ftp.pid), undefined)
    assert.deepEqual(server.errors, [])
  }
})

test('Telnet exchanges a command with the existing no-login loopback fixture', { timeout: 10000 }, async () => {
  const server = await startTestTelnetServer()
  let term
  try {
    term = await telnetSession({
      host: '127.0.0.1',
      port: server.port,
      readyTimeout: 5000
    })
    const output = []
    term.on('data', data => output.push(data.toString()))
    term.channel.on('error', error => server.errors.push(error))
    assert.equal(globalState.getSession(term.pid), term)
    term.write('echo ANUBIS_TELNET_COMMAND_OK\r\n')
    await waitFor(() => output.join('').includes('fixture reply: ANUBIS_TELNET_COMMAND_OK'))
    assert.ok(server.commands.includes('echo ANUBIS_TELNET_COMMAND_OK'))
  } finally {
    if (term) term.kill()
    await server.close()
    if (term) assert.equal(globalState.getSession(term.pid), undefined)
    assert.deepEqual(server.errors, [])
  }
})
