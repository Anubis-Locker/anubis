const net = require('node:net')
const { Client } = require('@ai-security-tool/ssh2')

async function startSshForward ({ remotePort, remoteHost = '127.0.0.1', ...options }) {
  const client = new Client()
  const sockets = new Set()
  const errors = []
  client.on('error', error => errors.push(error))
  await new Promise((resolve, reject) => {
    client.once('ready', resolve)
    client.once('error', reject)
    client.connect({ readyTimeout: 15000, ...options })
  })
  const server = net.createServer(socket => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', error => errors.push(error))
    client.forwardOut('127.0.0.1', socket.remotePort, remoteHost, remotePort, (error, stream) => {
      if (error) {
        errors.push(error)
        socket.destroy()
        return
      }
      stream.on('error', error => {
        errors.push(error)
        socket.destroy()
      })
      socket.on('close', () => stream.destroy())
      stream.on('close', () => socket.destroy())
      socket.pipe(stream).pipe(socket)
    })
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return {
    port: server.address().port,
    errors,
    exec (command) {
      return new Promise((resolve, reject) => {
        client.exec(command, (error, stream) => {
          if (error) return reject(error)
          let stdout = ''
          let stderr = ''
          stream.on('data', data => { stdout += data })
          stream.stderr.on('data', data => { stderr += data })
          stream.on('error', reject)
          stream.on('close', code => {
            if (code) reject(new Error(stderr || `SSH command failed: ${code}`))
            else resolve(stdout)
          })
        })
      })
    },
    async close () {
      for (const socket of sockets) socket.destroy()
      await new Promise(resolve => server.close(resolve))
      await new Promise(resolve => {
        client.once('close', resolve)
        client.end()
      })
    }
  }
}

module.exports = { startSshForward }
