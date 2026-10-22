const net = require('node:net')

async function startTestVncServer () {
  const sockets = new Set()
  const errors = []
  const events = { keys: [], pointers: [], clipboard: [] }
  const width = 64
  const height = 48
  const server = net.createServer(socket => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', error => errors.push(error))
    let buffer = Buffer.alloc(0)
    let state = 'version'
    socket.write('RFB 003.008\n')
    socket.on('data', data => {
      buffer = Buffer.concat([buffer, data])
      while (buffer.length) {
        let length
        if (state === 'version') {
          if (buffer.length < 12) return
          length = 12
          socket.write(Buffer.from([1, 1]))
          state = 'security'
        } else if (state === 'security') {
          length = 1
          socket.write(Buffer.alloc(4))
          state = 'init'
        } else if (state === 'init') {
          length = 1
          const name = Buffer.from('Anubis VNC test desktop')
          const init = Buffer.alloc(24)
          init.writeUInt16BE(width, 0)
          init.writeUInt16BE(height, 2)
          init[4] = 32
          init[5] = 24
          init[7] = 1
          for (const offset of [8, 10, 12]) init.writeUInt16BE(255, offset)
          init[14] = 16
          init[15] = 8
          init.writeUInt32BE(name.length, 20)
          socket.write(Buffer.concat([init, name]))
          state = 'messages'
        } else {
          const type = buffer[0]
          if (type === 0) {
            length = 20
          } else if (type === 2) {
            if (buffer.length < 4) return
            length = 4 + buffer.readUInt16BE(2) * 4
          } else if (type === 3) {
            length = 10
          } else if (type === 4) {
            length = 8
          } else if (type === 5) {
            length = 6
          } else if (type === 6) {
            if (buffer.length < 8) return
            length = 8 + buffer.readUInt32BE(4)
          } else {
            errors.push(new Error(`Unsupported VNC client message ${type}`))
            socket.destroy()
            return
          }
          if (buffer.length < length) return
          if (type === 3 && !socket.frameSent) {
            const frame = Buffer.alloc(16 + width * height * 4)
            frame.writeUInt16BE(1, 2)
            frame.writeUInt16BE(width, 8)
            frame.writeUInt16BE(height, 10)
            for (let i = 16; i < frame.length; i += 4) frame[i + 1] = 255
            socket.write(frame)
            socket.frameSent = true
          } else if (type === 4) {
            events.keys.push({ down: !!buffer[1], key: buffer.readUInt32BE(4) })
          } else if (type === 5) {
            events.pointers.push({ buttons: buffer[1], x: buffer.readUInt16BE(2), y: buffer.readUInt16BE(4) })
          } else if (type === 6) {
            events.clipboard.push(buffer.subarray(8, length).toString('utf8'))
          }
        }
        buffer = buffer.subarray(length)
      }
    })
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return {
    port: server.address().port,
    events,
    errors,
    async close () {
      for (const socket of sockets) socket.destroy()
      await new Promise((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve())
      })
    }
  }
}

module.exports = { startTestVncServer }
