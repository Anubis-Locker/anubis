const http = require('http')
const { pipeline } = require('stream')
const { sameSecret, HEADER } = require('./managed-browser')

function createManagedMcpProxy ({ secret, rpc, log = require('../common/log') }) {
  return async (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('Connection', 'close')
    res.shouldKeepAlive = false
    if (!sameSecret(req.headers[HEADER], secret)) {
      return res.status(403).json({ error: 'Managed transport authentication required' })
    }
    if (Object.hasOwn(req.headers, 'x-anubis-managed-context')) {
      return res.status(403).json({ error: 'Managed MCP is fixed to the SYSTEM context' })
    }
    if (!['GET', 'POST', 'DELETE'].includes(req.method)) {
      return res.status(405).json({ error: 'Unsupported MCP method' })
    }
    let endpoint
    try {
      endpoint = await rpc('managedMcpEndpoint')
      if (!endpoint || !['127.0.0.1', '::1'].includes(endpoint.host) ||
          !Number.isInteger(endpoint.port) || endpoint.port < 1 || endpoint.port > 65535 ||
          !/^[0-9a-f]{64}$/.test(endpoint.token)) {
        throw new Error('Administrator-managed MCP listener is not available')
      }
    } catch (error) {
      log.warn('Managed MCP unavailable:', error.message)
      return res.status(503).json({ error: 'Administrator-managed MCP is disabled or not running' })
    }
    const headers = { authorization: `Bearer ${endpoint.token}` }
    for (const name of ['content-type', 'accept', 'mcp-session-id', 'mcp-protocol-version', 'last-event-id']) {
      if (req.headers[name]) headers[name] = req.headers[name]
    }
    const upstream = http.request({
      host: endpoint.host,
      port: endpoint.port,
      path: '/mcp',
      method: req.method,
      headers
    }, incoming => {
      const responseHeaders = {}
      for (const name of ['content-type', 'cache-control', 'mcp-session-id', 'mcp-protocol-version']) {
        if (incoming.headers[name]) responseHeaders[name] = incoming.headers[name]
      }
      res.writeHead(incoming.statusCode, responseHeaders)
      pipeline(incoming, res, error => {
        if (error) log.warn('Managed MCP response stream failed:', error.message)
      })
    })
    upstream.once('error', error => {
      log.warn('Managed MCP connection failed:', error.message)
      if (!res.headersSent) res.status(503).json({ error: 'Administrator-managed MCP listener is unavailable' })
      else res.destroy()
    })
    req.once('aborted', () => upstream.destroy())
    res.once('close', () => upstream.destroy())
    req.pipe(upstream)
  }
}

module.exports = { createManagedMcpProxy }
