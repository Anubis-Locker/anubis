const net = require('node:net')
const { validOutcome, CORE_CODES } = require('./native-password-client')

function createRuntimeControl ({ pipe, contextId, getEndpoint, nativePasswordHandler, onError, onFatal = onError }) {
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
      if (input?.operation === 'native-password-update' && typeof nativePasswordHandler === 'function') {
        if (Object.keys(input).sort().join(',') !== 'admissionId,contextId,operation,version' ||
            input.version !== 1 || input.contextId !== contextId ||
            typeof input.admissionId !== 'string' || !/^[a-f0-9]{64}$/.test(input.admissionId) ||
            request.subarray(end + 1).toString().trim()) return reject()
        answered = true
        socket.setTimeout(10000, () => socket.destroy())
        const deadline = setTimeout(() => socket.destroy(), 10000)
        deadline.unref()
        socket.once('close', () => clearTimeout(deadline))
        Promise.resolve().then(() => nativePasswordHandler(input)).then(value => {
          const result = value?.result
          const successful = value?.ok === true && result?.committed === true &&
            Object.keys(value).sort().join(',') === 'ok,result,version'
          const denied = value?.ok === false && result?.committed === false &&
            (CORE_CODES.has(value.error?.code) || value.error?.code === 'ERR_NATIVE_PASSWORD_ADMISSION')
          const committedFailure = value?.ok === false && result?.committed === true &&
            value.error?.code === 'ERR_NATIVE_PASSWORD_COMMITTED_INVALIDATION_FAILED'
          const failed = (denied || committedFailure) &&
            Object.keys(value).sort().join(',') === 'error,ok,result,version' &&
            Object.keys(value.error).join(',') === 'code'
          if (value?.version !== 1 || (!successful && !failed) ||
              !validOutcome(result, contextId, input.admissionId) || result.pid !== process.pid) {
            throw new Error('Invalid native password outcome')
          }
          reply(value)
        }).catch(() => {
          socket.destroy()
          onError(new Error('Native password operation outcome is unknown'))
        })
        return
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
