const crypto = require('crypto')

function createRpcChannel (channel, timeout = 30000) {
  const pending = new Map()
  const onMessage = (message) => {
    if (message?.type !== 'managed-rpc-result') return
    const entry = pending.get(message.id)
    if (!entry) return
    pending.delete(message.id)
    clearTimeout(entry.timer)
    if (message.error) entry.reject(new Error(message.error))
    else entry.resolve(message.data)
  }
  const dispose = () => {
    channel.removeListener('message', onMessage)
    channel.removeListener('disconnect', dispose)
    for (const entry of pending.values()) {
      clearTimeout(entry.timer)
      entry.reject(new Error('Managed browser backend disconnected'))
    }
    pending.clear()
  }
  channel.on('message', onMessage)
  channel.on('disconnect', dispose)
  return {
    call: (func, args = []) => new Promise((resolve, reject) => {
      if (channel.connected === false) return reject(new Error('Managed browser backend disconnected'))
      if (pending.size >= 128) return reject(new Error('Too many managed browser requests'))
      const id = crypto.randomUUID()
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error('Managed browser request timed out'))
      }, timeout)
      pending.set(id, { resolve, reject, timer })
      const fail = (error) => {
        if (!error || !pending.has(id)) return
        pending.delete(id)
        clearTimeout(timer)
        reject(error)
      }
      try {
        channel.send({ type: 'managed-rpc', id, func, args }, fail)
      } catch (error) {
        fail(error)
      }
    }),
    dispose
  }
}

module.exports = { createRpcChannel }
