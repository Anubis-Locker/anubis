const crypto = require('crypto')
const path = require('path')

function createManagedRuntime ({
  createAgent,
  userData,
  port,
  header,
  version,
  env = process.env,
  onStatus
}) {
  const baseUrl = env.ANUBIS_ADMIN_MANAGED_URL || 'https://api.anubis.locker'
  const url = new URL(baseUrl)
  if (url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) {
    throw new Error('Managed connectivity requires HTTPS (except loopback tests)')
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('Invalid managed connectivity server URL')
  }
  const agent = createAgent({
    baseUrl: url.href.replace(/\/$/, ''),
    identityFile: path.join(userData, 'managed-access-identity.json'),
    label: require('os').hostname(),
    app: 'anubis-desktop',
    version,
    localHost: '127.0.0.1',
    localPort: port,
    localHeaders: { 'x-anubis-managed-transport': header },
    probe: async () => {
      const response = await fetch(`http://127.0.0.1:${port}/run`, {
        signal: AbortSignal.timeout(5000)
      })
      return response.ok && await response.text() === 'ok'
    },
    onStatus
  })
  return agent
}

function createTransportSecret () {
  return crypto.randomBytes(32).toString('hex')
}

module.exports = { createManagedRuntime, createTransportSecret }
