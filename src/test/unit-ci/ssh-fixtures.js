const fs = require('node:fs')
const net = require('node:net')
const path = require('node:path')
const { once } = require('node:events')
const { randomUUID } = require('node:crypto')
const { AgentProtocol, utils } = require('@ai-security-tool/ssh2')

function makeFixtureDir (prefix) {
  return fs.mkdtempSync(path.join(__dirname, prefix))
}

function generateKey ({ dir, name, type = 'ed25519', passphrase = '', bits }) {
  const options = { comment: `electerm-${name}` }
  if (bits) options.bits = bits
  if (passphrase) {
    options.passphrase = passphrase
    options.cipher = 'aes256-cbc'
  }
  const pair = utils.generateKeyPairSync(type, options)
  const keyPath = path.join(dir, name)
  fs.writeFileSync(keyPath, pair.private, { mode: 0o600 })
  fs.writeFileSync(`${keyPath}.pub`, pair.public)
  return { keyPath, privateKey: pair.private, publicKey: pair.public }
}

// Speak the real OpenSSH agent protocol over a Windows named pipe or Unix
// socket, without touching the user's ssh-agent service or requiring ssh-add.
async function startAgent () {
  const socketPath = process.platform === 'win32'
    ? `\\\\.\\pipe\\electerm-test-agent-${randomUUID()}`
    : path.relative(process.cwd(), path.join(__dirname, `agent-${randomUUID()}.sock`))
  const keys = []
  const sockets = new Set()
  const state = { identities: 0, signatures: 0 }
  const server = net.createServer((socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => socket.destroy())
    const protocol = new AgentProtocol(false)
    protocol.on('error', () => socket.destroy())
    protocol.on('identities', (request) => {
      state.identities++
      protocol.getIdentitiesReply(request, keys)
    })
    protocol.on('sign', (request, publicKey, data, flags) => {
      const key = keys.find(key => key.getPublicSSH().equals(publicKey.getPublicSSH()))
      if (!key) return protocol.failureReply(request)
      const signature = key.sign(data, flags.hash)
      if (signature instanceof Error) return protocol.failureReply(request)
      state.signatures++
      protocol.signReply(request, signature)
    })
    socket.pipe(protocol).pipe(socket)
  })
  server.listen(socketPath)
  await once(server, 'listening')
  let closing
  return {
    env: { ...process.env, SSH_AUTH_SOCK: socketPath },
    state,
    addKey (keyPath) {
      let key = utils.parseKey(fs.readFileSync(keyPath))
      if (Array.isArray(key)) key = key[0]
      if (key instanceof Error) throw key
      keys.push(key)
    },
    kill () {
      if (closing) return closing
      for (const socket of sockets) socket.destroy()
      closing = new Promise((resolve, reject) => {
        server.close(err => err ? reject(err) : resolve())
      })
      return closing
    }
  }
}

module.exports = { makeFixtureDir, generateKey, startAgent }
