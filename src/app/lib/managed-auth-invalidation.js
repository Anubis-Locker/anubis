const crypto = require('node:crypto')

function invalidationError () {
  return Object.assign(new Error('Managed authentication invalidation failed'), {
    code: 'ERR_MANAGED_AUTH_INVALIDATION'
  })
}

function awaitManagedAuthInvalidation (child, { hashedPassword }) {
  if (!child?.connected || typeof child.send !== 'function' ||
      typeof hashedPassword !== 'string' || !/^[a-f0-9]{128}$/i.test(hashedPassword)) {
    if (child?.exitCode === null && child.signalCode === null) child.kill()
    return Promise.reject(invalidationError())
  }
  return new Promise((resolve, reject) => {
    const requestId = crypto.randomBytes(16).toString('hex')
    let done = false
    const cleanup = () => {
      clearTimeout(timer)
      child.removeListener('message', onMessage)
      child.removeListener('exit', failed)
      child.removeListener('disconnect', failed)
      child.removeListener('error', failed)
    }
    const failed = () => {
      if (done) return
      done = true
      cleanup()
      // A backend that cannot confirm revocation must not retain old sessions.
      if (child.exitCode === null && child.signalCode === null) child.kill()
      reject(invalidationError())
    }
    const onMessage = message => {
      if (message?.type !== 'managed-auth-invalidated' || message.requestId !== requestId ||
          Object.keys(message).sort().join(',') !== 'requestId,type' || done) return
      done = true
      cleanup()
      resolve()
    }
    const timer = setTimeout(failed, 1000)
    timer.unref()
    child.on('message', onMessage)
    child.once('exit', failed)
    child.once('disconnect', failed)
    child.once('error', failed)
    try {
      child.send({ type: 'managed-auth-changed', requestId, hashedPassword }, error => {
        if (error) failed()
      })
    } catch {
      failed()
    }
  })
}

function registerManagedAuthInvalidation (browser) {
  const listener = async message => {
    if (message?.type !== 'managed-auth-changed') return
    const acknowledge = Object.hasOwn(message, 'requestId')
    if (acknowledge && (Object.keys(message).sort().join(',') !== 'hashedPassword,requestId,type' ||
        !/^[a-f0-9]{32}$/.test(message.requestId) ||
        typeof message.hashedPassword !== 'string' || !/^[a-f0-9]{128}$/i.test(message.hashedPassword))) return
    try {
      await browser.invalidateSessions()
      if (acknowledge) {
        process.env.requireAuth = message.hashedPassword
        process.send({ type: 'managed-auth-invalidated', requestId: message.requestId }, error => {
          if (error && process.connected) process.disconnect()
        })
      }
    } catch {
      process.stderr.write('Managed authentication invalidation failed\n')
      if (process.connected) process.disconnect()
    }
  }
  process.on('message', listener)
  return () => process.removeListener('message', listener)
}

module.exports = { awaitManagedAuthInvalidation, registerManagedAuthInvalidation }
