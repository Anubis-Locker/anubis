/**
 * ssh proxy command support
 *
 * Connects through an external stdio proxy command (like OpenSSH ProxyCommand):
 * the command is expected to speak the SSH protocol on its stdin/stdout.
 *
 * Used for:
 *  - netbird ssh proxy (auto-detected via `netbird ssh detect`, see
 *    https://github.com/electerm/electerm/issues/4500)
 *  - generic user-defined proxyCommand option (supports %h %p %r placeholders,
 *    e.g. `cloudflared access ssh --hostname %h`)
 *
 * Because @ai-security-tool/ssh2 requires a real net.Socket with full semantics
 * (setKeepAlive/destroy/connecting), we bridge the child stdio through a
 * loopback socketpair instead of patching a fake socket.
 */

const { spawn } = require('child_process')
const net = require('net')
const log = require('../common/log')

// resolved lazily so tests (and users) can override via env at any time
function getNetbirdBin () {
  return process.env.ELECTERM_NETBIRD_BIN || 'netbird'
}

// how long to wait for `netbird ssh detect` before giving up and connecting directly
const detectTimeout = 5 * 1000

// netbird CGNAT range 100.64.0.0/10
function isNetbirdLikeHost (host) {
  if (typeof host !== 'string' || !host) {
    return false
  }
  const h = host.startsWith('[') && host.endsWith(']')
    ? host.slice(1, -1)
    : host
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (!m) {
    // netbird also registers dns names, but avoid spawning a process
    // for every arbitrary hostname connection
    return false
  }
  const a = Number(m[1])
  const b = Number(m[2])
  return a === 100 && b >= 64 && b <= 127
}

/**
 * detect if target is a netbird JWT ssh server
 * `netbird ssh detect` exits 0 when the server requires netbird JWT auth
 */
function detectNetbird (host, port) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(getNetbirdBin(), ['ssh', 'detect', host, String(port)], {
        stdio: 'ignore'
      })
    } catch (e) {
      log.warn('spawn netbird detect failed', e.message)
      return resolve(false)
    }
    const timer = setTimeout(() => {
      child.kill()
      resolve(false)
    }, detectTimeout)
    child.on('error', () => {
      clearTimeout(timer)
      resolve(false)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve(code === 0)
    })
  })
}

// cache detection result per host:port for the process lifetime,
// so reconnects do not spawn `netbird ssh detect` again
const detectCache = new Map()

/**
 * Build command/args with quoted paths and %h %p %r placeholders.
 * Quotes only group arguments; shell expansion and shell operators are not run.
 */
function expandProxyCommand (command, { host, port, username }) {
  const args = []
  let current = ''
  let quote
  let started = false
  for (const char of command) {
    if (quote) {
      if (char === quote) quote = undefined
      else current += char
    } else if (char === '"' || char === "'") {
      quote = char
      started = true
    } else if (/\s/.test(char)) {
      if (started) args.push(current)
      current = ''
      started = false
    } else {
      current += char
      started = true
    }
  }
  if (quote) throw new Error('Unterminated quote in SSH proxy command')
  if (started) args.push(current)
  // Preserve Windows path separators and never invoke a shell. Expand values
  // after tokenizing so spaces in a username or host stay in one argument.
  const values = { h: host, p: String(port), r: username || '' }
  return args.map(arg => arg.replace(/%([hpr])/g, (_, key) => values[key]))
}

/**
 * create a loopback socketpair bridging to child stdio:
 * ssh2 client connects a normal tcp socket to 127.0.0.1:<random>,
 * the listener pipes both directions to the child process
 */
function bridgeChildStdio (child) {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    let settled = false
    server.once('error', (err) => {
      if (settled) {
        return
      }
      settled = true
      reject(err)
    })
    server.listen(0, '127.0.0.1', () => {
      if (settled) {
        return
      }
      settled = true
      const { port } = server.address()
      resolve({ server, port })
    })
    server.once('connection', (socket) => {
      server.close()
      socket.pipe(child.stdin)
      child.stdout.pipe(socket)
      const cleanup = () => {
        socket.destroy()
        try {
          child.kill()
        } catch {

        }
      }
      child.stdout.once('end', cleanup)
      child.stdout.once('error', cleanup)
      child.once('exit', () => socket.destroy())
      socket.once('error', () => {
        log.log('proxy command bridge socket error')
        try {
          child.kill()
        } catch {

        }
      })
    })
  })
}

/**
 * spawn proxy command and resolve { socket, dispose }
 * socket is an ordinary net.Socket connected to the bridge
 */
async function runProxyCommand (command, args, { onMessage } = {}) {
  const child = spawn(command, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  })
  const stderrBuf = []
  child.stderr?.on('data', (d) => {
    const text = d.toString()
    stderrBuf.push(text)
    onMessage && onMessage(text)
  })
  let bridge
  let socket
  let disposed = false
  const dispose = () => {
    if (disposed) return
    disposed = true
    socket?.destroy()
    child.stdin?.end()
    child.kill()
    bridge?.close()
  }
  await new Promise((resolve, reject) => {
    let settled = false
    const fail = (err) => {
      dispose()
      if (settled) return
      settled = true
      reject(err)
    }
    child.once('error', (err) => {
      fail(new Error(`proxy command failed to start: ${command}: ${err.message}`))
    })
    child.stdin.on('error', fail)
    child.once('exit', (code, signal) => {
      fail(new Error(`proxy command exited: ${command}: ${signal || code}`))
    })
    child.once('spawn', () => {
      bridgeChildStdio(child).then(
        ({ server, port }) => {
          bridge = server
          if (disposed) {
            server.close()
            return
          }
          socket = net.connect(port, '127.0.0.1')
          socket.once('connect', () => {
            if (settled) return
            settled = true
            resolve()
          })
          socket.once('error', fail)
        },
        fail
      )
    })
  })
  socket.once('close', dispose)
  return {
    socket,
    dispose,
    stderr: () => stderrBuf.join('')
  }
}

/**
 * main entry: decide whether to connect through a proxy command
 * returns { socket, dispose, stderr } or null when not applicable
 */
async function maybeProxyCommand (initOptions, connectOptions, { onMessage } = {}) {
  const host = connectOptions.host || initOptions.host
  const port = connectOptions.port || initOptions.port || 22
  let command
  let args
  if (initOptions.proxyCommand) {
    const expanded = expandProxyCommand(initOptions.proxyCommand, {
      host,
      port,
      username: connectOptions.username || initOptions.username
    })
    if (!expanded.length) {
      return null
    }
    command = expanded.shift()
    args = expanded
  } else if (
    !initOptions.proxy &&
    !connectOptions.sock &&
    isNetbirdLikeHost(host)
  ) {
    const key = `${host}:${port}`
    let detected = detectCache.get(key)
    if (detected === undefined) {
      detected = await detectNetbird(host, port)
      detectCache.set(key, detected)
    }
    if (!detected) {
      return null
    }
    command = getNetbirdBin()
    args = ['ssh', 'proxy', host, String(port)]
  } else {
    return null
  }
  log.log('using ssh proxy command:', command, args.join(' '))
  return runProxyCommand(command, args, { onMessage })
}

function clearDetectCache () {
  detectCache.clear()
}

exports.maybeProxyCommand = maybeProxyCommand
exports.expandProxyCommand = expandProxyCommand
exports.detectNetbird = detectNetbird
exports.isNetbirdLikeHost = isNetbirdLikeHost
exports.clearDetectCache = clearDetectCache
