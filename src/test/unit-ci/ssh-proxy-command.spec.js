process.env.NODE_ENV = 'development'

const { describe, test, beforeEach, afterEach, after, mock } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { once } = require('node:events')
const childProcess = require('node:child_process')
const { Server, utils } = require('@ai-security-tool/ssh2')
const { makeFixtureDir } = require('./ssh-fixtures')
const spawn = childProcess.spawn
const executables = new Map()
const invocations = []
// A shebang is not executable on Windows. Model the netbird executable at
// spawn's boundary, but run the fixture in a real native Node child process.
mock.method(childProcess, 'spawn', (command, args, options) => {
  const script = executables.get(command)
  if (script) {
    invocations.push({ command, args })
    return spawn(process.execPath, [script, ...args], options)
  }
  return spawn(command, args, options)
})
after(() => mock.restoreAll())
const {
  session
} = require('../../../src/app/server/session-ssh')
const {
  expandProxyCommand,
  isNetbirdLikeHost
} = require('../../../src/app/server/ssh-proxy-command')

const USERNAME = 'tester'
const PASSWORD = 'electerm-test'

const HOST_KEY = utils.generateKeyPairSync('ed25519', {
  comment: 'electerm-test-host'
})

function makeTmpDir () {
  return makeFixtureDir('electerm proxy cmd test-')
}

// in-process ssh server the fake netbird proxy forwards to
async function startServer () {
  const clients = new Set()
  const server = new Server({
    hostKeys: [HOST_KEY.private]
  }, (client) => {
    clients.add(client)
    const cleanup = () => clients.delete(client)
    client.on('close', cleanup)
    client.on('end', cleanup)
    client.on('authentication', (ctx) => {
      if (ctx.method === 'password' && ctx.username === USERNAME && ctx.password === PASSWORD) {
        return ctx.accept()
      }
      return ctx.reject(['password'])
    })
    // killing the proxy command child (see session-ssh kill()) resets its
    // socket to this in-process server instead of closing it cleanly, and an
    // unhandled socket error here would crash the whole run
    client.on('error', () => {})
    client.on('ready', () => {
      client.on('session', (accept) => {
        const sshSession = accept()
        sshSession.on('env', (accept) => accept())
        sshSession.on('pty', (accept) => accept())
        sshSession.on('shell', (accept) => {
          const stream = accept()
          stream.write('electerm proxy-command ready\n')
        })
      })
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return {
    port: server.address().port,
    async close () {
      for (const client of clients) {
        client.end()
      }
      await new Promise((resolve, reject) => {
        server.close((err) => err ? reject(err) : resolve())
      })
    }
  }
}

/**
 * write a fake `netbird` executable:
 * - `netbird ssh detect host port` exits 0/2 per FAKE_DETECT_EXIT
 * - `netbird ssh proxy host port` bridges its stdio to the local test server
 */
function writeFakeNetbird (dir, targetPort, detectExit = 0) {
  const script = `#!/usr/bin/env node
const net = require('net')
const args = process.argv.slice(2)
if (args[0] === 'ssh' && args[1] === 'detect') {
  process.exit(${detectExit})
}
if (args[0] === 'ssh' && args[1] === 'proxy') {
  process.stderr.write('SSH authentication required.\\n')
  process.stderr.write('Please do the SSO login in your browser.\\n')
  process.stderr.write('https://example.netbird.io/device-auth/abc123\\n')
  const sock = net.connect(${targetPort}, '127.0.0.1')
  sock.on('connect', () => {
    process.stdin.pipe(sock)
    sock.pipe(process.stdout)
  })
  sock.on('error', (e) => {
    process.stderr.write('proxy error: ' + e.message + '\\n')
    process.exit(1)
  })
  process.stdin.on('end', () => sock.end())
  process.stdin.resume()
  return
}
process.exit(2)
`
  const p = path.join(dir, 'netbird-fixture.js')
  fs.writeFileSync(p, script, { mode: 0o755 })
  executables.set(p, p)
  return p
}

function createPromptWs () {
  return {
    messages: [],
    s (payload) {
      this.messages.push(payload)
    },
    once (handler) {
      queueMicrotask(() => handler({ results: [] }))
    },
    close () {}
  }
}

describe('expandProxyCommand', () => {
  test('expands %h %p %r placeholders', () => {
    assert.deepEqual(
      expandProxyCommand('netbird ssh proxy %h %p', { host: '100.99.0.1', port: 22, username: 'root' }),
      ['netbird', 'ssh', 'proxy', '100.99.0.1', '22']
    )
    assert.deepEqual(
      expandProxyCommand('cloudflared access ssh --hostname %h --port %p --username %r', {
        host: 'a.example.com', port: 2222, username: 'bob'
      }),
      ['cloudflared', 'access', 'ssh', '--hostname', 'a.example.com', '--port', '2222', '--username', 'bob']
    )
    assert.deepEqual(
      expandProxyCommand('  fixed   command  ', { host: 'x', port: 1, username: '' }),
      ['fixed', 'command']
    )
  })
  test('preserves quoted executable paths, Windows separators and argument boundaries', () => {
    assert.deepEqual(
      expandProxyCommand('"C:\\Program Files\\Netbird\\netbird.exe" ssh proxy "%h" %p --user=%r', {
        host: 'host.example', port: 2222, username: 'domain\\user name'
      }),
      ['C:\\Program Files\\Netbird\\netbird.exe', 'ssh', 'proxy', 'host.example', '2222', '--user=domain\\user name']
    )
    assert.deepEqual(
      expandProxyCommand("'proxy tool' '' --host='%h'", { host: 'host name', port: 22 }),
      ['proxy tool', '', '--host=host name']
    )
    assert.throws(() => expandProxyCommand('"unclosed', {}), /Unterminated quote/)
  })
})

describe('isNetbirdLikeHost', () => {
  test('matches netbird CGNAT range only', () => {
    assert.equal(isNetbirdLikeHost('100.64.0.1'), true)
    assert.equal(isNetbirdLikeHost('100.127.255.254'), true)
    assert.equal(isNetbirdLikeHost('100.63.255.255'), false)
    assert.equal(isNetbirdLikeHost('100.128.0.1'), false)
    assert.equal(isNetbirdLikeHost('101.1.1.1'), false)
    assert.equal(isNetbirdLikeHost('192.168.1.1'), false)
    assert.equal(isNetbirdLikeHost('peer.example.com'), false)
    assert.equal(isNetbirdLikeHost(''), false)
    assert.equal(isNetbirdLikeHost(undefined), false)
  })
})

describe('ssh proxy command', { timeout: 20000 }, () => {
  let tmpDir
  let server
  let netbirdPath
  let origBin

  beforeEach(async () => {
    invocations.length = 0
    tmpDir = makeTmpDir()
    server = await startServer()
    netbirdPath = writeFakeNetbird(tmpDir, server.port, 0)
    origBin = process.env.ELECTERM_NETBIRD_BIN
    process.env.ELECTERM_NETBIRD_BIN = netbirdPath
    // reset module level detect cache between tests
    const mod = require('../../../src/app/server/ssh-proxy-command')
    mod.clearDetectCache()
  })

  afterEach(async () => {
    if (origBin === undefined) {
      delete process.env.ELECTERM_NETBIRD_BIN
    } else {
      process.env.ELECTERM_NETBIRD_BIN = origBin
    }
    await server.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
    executables.clear()
  })

  test('connects through netbird ssh proxy for netbird-like host', async () => {
    const ws = createPromptWs()
    let term
    try {
      term = await session({
        host: '100.99.0.1',
        port: 22,
        username: USERNAME,
        password: PASSWORD,
        useSshAgent: false,
        enableSsh: false,
        readyTimeout: 10000
      }, ws)
      assert.ok(term, 'session should connect through proxy command')
      // no host key confirm prompt should appear: proxied connection skips verification
      const confirms = ws.messages.filter(m => m.action === 'session-interactive')
      assert.equal(confirms.length, 0)
      // SSO url from proxy stderr surfaced once
      const notes = ws.messages.filter(m => m.action === 'ssh-proxy-command-message')
      assert.equal(notes.length, 1)
      assert.ok(notes[0].url.includes('example.netbird.io'))
      assert.deepEqual(invocations.map(call => call.args.slice(0, 2)), [
        ['ssh', 'detect'], ['ssh', 'proxy']
      ])
    } finally {
      term && term.kill()
    }
  })

  test('returns null when detect exits non-zero (non-netbird server)', async () => {
    // point at a detect-only stub: detect exits 2 ("regular ssh server"),
    // any proxy invocation exits 1 - so a non-null result would fail loudly
    const stub = path.join(tmpDir, 'netbird-detect-only')
    fs.writeFileSync(
      stub,
      '#!/usr/bin/env node\n' +
      'const args = process.argv.slice(2)\n' +
      "if (args[0] === 'ssh' && args[1] === 'detect') { process.exit(2) }\n" +
      'process.exit(1)\n',
      { mode: 0o755 }
    )
    executables.set(stub, stub)
    process.env.ELECTERM_NETBIRD_BIN = stub
    const mod = require('../../../src/app/server/ssh-proxy-command')
    mod.clearDetectCache()
    const r = await mod.maybeProxyCommand(
      { host: '100.99.0.2', port: 22 },
      { host: '100.99.0.2', port: 22 },
      {}
    )
    assert.equal(r, null)
    assert.deepEqual(invocations.map(call => call.args.slice(0, 2)), [['ssh', 'detect']])
  })

  test('non-netbird host skips detection entirely', async () => {
    // stub fails on every invocation; a null result proves it was never called
    const stub = path.join(tmpDir, 'netbird-fail-all')
    fs.writeFileSync(stub, '#!/usr/bin/env node\nprocess.exit(1)\n', { mode: 0o755 })
    executables.set(stub, stub)
    process.env.ELECTERM_NETBIRD_BIN = stub
    const mod = require('../../../src/app/server/ssh-proxy-command')
    mod.clearDetectCache()
    const r = await mod.maybeProxyCommand(
      { host: '192.168.1.10', port: 22 },
      { host: '192.168.1.10', port: 22 },
      {}
    )
    assert.equal(r, null)
    assert.equal(invocations.length, 0)
  })

  test('explicit proxyCommand option connects through it', async () => {
    const ws = createPromptWs()
    let term
    try {
      term = await session({
        host: '127.0.0.1',
        port: server.port,
        username: USERNAME,
        password: PASSWORD,
        useSshAgent: false,
        enableSsh: false,
        proxyCommand: `"${process.execPath}" "${netbirdPath}" ssh proxy 127.0.0.1 ${server.port}`,
        readyTimeout: 10000
      }, ws)
      assert.ok(term)
      const notes = ws.messages.filter(m => m.action === 'ssh-proxy-command-message')
      assert.equal(notes.length, 1)
    } finally {
      term && term.kill()
    }
  })

  test('a missing proxy executable rejects promptly without leaking a listener', async () => {
    const mod = require('../../../src/app/server/ssh-proxy-command')
    await assert.rejects(
      mod.maybeProxyCommand({
        host: '127.0.0.1',
        proxyCommand: `"${path.join(tmpDir, 'missing-proxy.exe')}"`
      }, {}, {}),
      /proxy command failed to start:.*ENOENT/
    )
  })

  test('an immediately exiting proxy closes the bridge', async () => {
    const mod = require('../../../src/app/server/ssh-proxy-command')
    const result = await mod.maybeProxyCommand({
      host: '127.0.0.1',
      proxyCommand: `"${process.execPath}" -e "process.exit(2)"`
    }, {}, {})
    try {
      if (!result.socket.destroyed) await once(result.socket, 'close')
      assert.equal(result.socket.destroyed, true)
    } finally {
      result.dispose()
    }
  })
})
