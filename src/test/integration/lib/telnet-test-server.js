const net = require('node:net')

async function startTestTelnetServer () {
  const commands = []
  const errors = []
  const clients = new Set()
  const server = net.createServer(socket => {
    clients.add(socket)
    socket.once('close', () => clients.delete(socket))
    socket.on('error', error => {
      if (error.code !== 'ECONNRESET') errors.push(error)
    })
    socket.write('ANUBIS_TELNET_READY\r\n> ')
    let line = ''
    let negotiation = 0
    socket.on('data', data => {
      for (const byte of data) {
        if (negotiation) {
          if (negotiation === 1) negotiation = [251, 252, 253, 254].includes(byte) ? 2 : 0
          else negotiation = 0
        } else if (byte === 255) {
          negotiation = 1
        } else if (byte === 13 || byte === 10) {
          if (!line) continue
          commands.push(line)
          socket.write(`fixture reply: ${line.replace(/^echo /, '')}\r\n> `)
          line = ''
        } else if (byte >= 32 && byte < 127) {
          line += String.fromCharCode(byte)
        }
      }
    })
  })
  server.on('error', error => errors.push(error))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return {
    port: server.address().port,
    commands,
    errors,
    close: async () => {
      for (const client of clients) client.destroy()
      await new Promise(resolve => server.close(resolve))
    }
  }
}

module.exports = { startTestTelnetServer }
