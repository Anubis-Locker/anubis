const net = require('node:net')

function createRuntimeControl ({ pipe, contextId, getEndpoint, onError, onFatal = onError }) {
  const sockets = new Set()
  const server = net.createServer(socket => {
    if (sockets.size >= 8) {
      socket.destroy()
      return
    }
    sockets.add(socket)
    socket.setTimeout(5000, () => socket.destroy())
    socket.on('error', onError)
    socket.once('close', () => sockets.delete(socket))
    let request = Buffer.alloc(0)
    let answered = false
    const reply = value => {
      answered = true
      socket.end(JSON.stringify(value) + '\n')
    }
    const reject = () => reply({ version: 1, ok: false, error: { code: 'ERR_INVALID_REQUEST' } })
    socket.on('data', chunk => {
      if (answered) return
      if (request.length + chunk.length > 4096) return reject()
      request = Buffer.concat([request, chunk])
      const end = request.indexOf(10)
      if (end === -1) return
      let input
      try {
        input = JSON.parse(request.subarray(0, end).toString('utf8'))
      } catch {
        return reject()
      }
      if (!input || typeof input !== 'object' || Array.isArray(input) ||
          Object.keys(input).length !== 2 || input.version !== 1 || input.operation !== 'describe' ||
          request.subarray(end + 1).toString().trim()) return reject()
      let endpoint
      try {
        endpoint = getEndpoint()
        if (!endpoint || !Number.isInteger(endpoint.localPort) || endpoint.localPort < 1 ||
            endpoint.localPort > 65535 || !/^[a-f0-9]{64}$/.test(endpoint.privateProof)) {
          throw Object.assign(new Error('Machine endpoint is not ready'), { code: 'ERR_ENGINE_NOT_READY' })
        }
      } catch (error) {
        onError(error)
        return reply({ version: 1, ok: false, error: { code: 'ERR_ENGINE_NOT_READY' } })
      }
      reply({
        version: 1,
        ok: true,
        result: {
          pid: process.pid,
          contextId,
          endpoint: { localPort: endpoint.localPort, privateProof: endpoint.privateProof }
        }
      })
    })
  })
  let started = false
  let closed = false
  server.on('error', error => {
    if (started && !closed) onFatal(error)
  })
  return {
    async start () {
      await new Promise((resolve, reject) => {
        const failed = error => {
          server.removeListener('listening', listening)
          reject(error)
        }
        const listening = () => {
          server.removeListener('error', failed)
          started = true
          resolve()
        }
        server.once('error', failed)
        server.once('listening', listening)
        // Native supervisor verifies this pipe's DACL and exact server PID.
        server.listen({ path: pipe, readableAll: false, writableAll: false })
      })
    },
    async close () {
      if (closed) return
      closed = true
      for (const socket of sockets) socket.destroy()
      if (server.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    }
  }
}

module.exports = { createRuntimeControl }
