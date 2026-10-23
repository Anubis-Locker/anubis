const crypto = require('node:crypto')
const http = require('node:http')
const path = require('node:path')
const { pipeline } = require('node:stream')
const WebSocket = require('ws')
const { requestHost, validateDescriptor, publicContext } = require('../lib/windows-host-client')
const { sameContext } = require('../lib/machine-client-connection')
const { sameSecret, HEADER } = require('./managed-browser')

const CONTEXT_HEADER = 'x-anubis-managed-context'
const SESSION_HEADER = 'x-anubis-managed-session'
const CONTEXT_ROUTE = '/api/machine-contexts'
const CONTEXT_SCRIPT = '<script src="/_anubis/context-ui.js" defer></script>'
const SESSION_TTL = 8 * 60 * 60 * 1000
const hexID = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value)
const validSession = value => typeof value === 'string' && /^[a-f0-9]{32,64}$/.test(value)

function nativeContextBridge (serviceName, helper = path.join(path.dirname(process.execPath), 'anubis-host.exe'), callHost = requestHost) {
  if (!/^AnubisHost(?:-QA-[A-Za-z0-9-]{1,40})?$/.test(serviceName)) throw new Error('Invalid machine service')
  let active = 0
  const pending = []
  const reads = new Map()
  const drain = () => {
    if (active >= 4 || !pending.length) return
    const { request, resolve, reject, key } = pending.shift()
    // Only callers admitted before this native check starts may share it.
    if (key) reads.delete(key)
    active++
    callHost(helper, serviceName, { version: 1, ...request }).then(resolve, reject).finally(() => {
      active--
      drain()
    })
  }
  return {
    call (request) {
      const key = ['list-contexts', 'resolve-context'].includes(request.operation)
        ? JSON.stringify(Object.keys(request).sort().map(name => [name, request[name]]))
        : null
      if (key && reads.has(key)) return reads.get(key)
      if (pending.length >= 128) return Promise.reject(new Error('Managed context request queue exceeded'))
      let entry
      const operation = new Promise((resolve, reject) => {
        entry = { request, resolve, reject, key }
      })
      if (key) reads.set(key, operation)
      pending.push(entry)
      drain()
      return operation
    }
  }
}

function createManagedContexts ({
  secret, bridge, now = Date.now, pollInterval = 2000,
  log = require('../common/log')
}) {
  const bindings = new Map()
  const invalidate = record => {
    record.grant = null
    for (const stop of record.active) stop()
    record.active.clear()
  }
  const binding = id => {
    for (const [key, record] of bindings) {
      if (record.expires <= now()) {
        invalidate(record)
        bindings.delete(key)
      }
    }
    if (!bindings.has(id)) {
      if (bindings.size >= 128) throw new Error('Too many managed context sessions')
      bindings.set(id, { expires: now() + SESSION_TTL, choices: new Map(), active: new Set(), grant: null })
    }
    return bindings.get(id)
  }
  const catalog = async record => {
    const value = await bridge.call({ operation: 'list-contexts' })
    if (!value || !Array.isArray(value.sessions)) throw new Error('Unsupported machine contexts')
    const available = []
    if (value.machine) {
      const { contextId, identity } = value.machine
      if (!hexID(contextId) || identity?.sid !== 'S-1-5-18' || identity.sessionId !== 0) {
        throw new Error('Invalid canonical machine identity')
      }
      available.push({ target: 'system', identity, contextId })
    }
    for (const session of value.sessions) {
      if (!Number.isInteger(session.id) || session.id < 1 || !/^S-1-5-21-(?:\d+-){3}\d+$/.test(session.sid) ||
          !/^S-1-5-5-\d+-\d+$/.test(session.logonSid) || typeof session.account !== 'string' || !session.account) {
        throw new Error('Invalid authorized Windows session')
      }
      available.push({
        target: 'user',
        logonSid: session.logonSid,
        identity: { sid: session.sid, account: session.account, sessionId: session.id }
      })
    }
    const choices = new Map()
    const result = []
    for (const choice of available) {
      const fingerprint = JSON.stringify([choice.target, choice.contextId, choice.identity.sid, choice.identity.sessionId, choice.logonSid])
      const previous = [...record.choices].find(([, value]) => value.fingerprint === fingerprint)
      const id = previous?.[0] || crypto.randomBytes(16).toString('hex')
      choices.set(id, { ...choice, fingerprint })
      const { sid, account, sessionId } = choice.identity
      result.push({ id, target: choice.target, identity: { sid, account, sessionId } })
    }
    record.choices = choices
    return { supported: true, contexts: result }
  }
  const targetRequest = choice => ({
    target: choice.target,
    ...(choice.target === 'user'
      ? { sessionId: choice.identity.sessionId, accountSid: choice.identity.sid, logonSid: choice.logonSid }
      : {})
  })
  const validate = async (record, grant) => {
    try {
      if (!grant || record.grant !== grant || record.expires <= now()) throw new Error('Context selection expired')
      const resolved = validateDescriptor(await bridge.call({
        operation: 'resolve-context', ...targetRequest(grant.choice), contextId: grant.descriptor.contextId
      }), targetRequest(grant.choice), grant.choice.identity.sid)
      if (record.grant !== grant || record.expires <= now() || !sameContext(resolved, grant.descriptor)) throw new Error('Context identity changed')
      return resolved
    } catch (error) {
      if (record.grant === grant) invalidate(record)
      throw error
    }
  }
  const timer = setInterval(() => {
    for (const record of bindings.values()) {
      if (!record.active.size || record.checking) continue
      record.checking = true
      validate(record, record.grant).catch(() => {
        log.warn('Managed Windows context authorization expired')
      }).finally(() => { record.checking = false })
    }
  }, pollInterval)
  timer.unref()

  function forward (req, res, record, descriptor, releaseMessages) {
    const headers = { [HEADER]: descriptor.endpoint.privateProof }
    for (const name of ['accept', 'accept-language', 'content-type', 'content-length', 'token', 'range', 'if-range']) {
      if (req.headers[name]) headers[name] = req.headers[name]
    }
    const requestedPath = req.originalUrl || req.url
    if (!requestedPath.startsWith('/') || requestedPath.includes('\r') || requestedPath.includes('\n')) {
      throw new Error('Invalid context route')
    }
    if (req.ws) {
      req.wsHandled = true
      const browser = req.ws
      if (browser.readyState !== WebSocket.OPEN) return releaseMessages(false)
      const upstream = new WebSocket(
        `ws://127.0.0.1:${descriptor.endpoint.localPort}${requestedPath.replace(/\/\.websocket(?=\?|$)/, '')}`,
        { headers, perMessageDeflate: false, maxPayload: 16 * 1024 * 1024, handshakeTimeout: 10000 }
      )
      const stop = () => { browser.close(1008, 'Windows context unavailable'); upstream.terminate() }
      record.active.add(stop)
      const pending = []
      let queued = 0
      browser.on('message', (data, binary) => {
        binary = typeof binary === 'boolean' ? binary : typeof data !== 'string'
        if (upstream.readyState === WebSocket.OPEN) {
          if (upstream.bufferedAmount > 16 * 1024 * 1024) return stop()
          upstream.send(data, { binary })
        } else if (upstream.readyState === WebSocket.CONNECTING) {
          queued += data.length
          if (queued > 1024 * 1024 || pending.length >= 1024) return stop()
          pending.push([data, binary])
        }
      })
      upstream.on('open', () => {
        for (const [data, binary] of pending) upstream.send(data, { binary })
        pending.length = 0
      })
      upstream.on('message', (data, binary) => {
        binary = typeof binary === 'boolean' ? binary : typeof data !== 'string'
        if (browser.readyState !== WebSocket.OPEN) return
        if (browser.bufferedAmount > 16 * 1024 * 1024) return stop()
        browser.send(data, { binary })
      })
      upstream.on('error', () => { log.warn('Managed Windows context WebSocket unavailable'); stop() })
      browser.on('error', stop)
      browser.on('close', () => { record.active.delete(stop); upstream.terminate() })
      upstream.on('close', () => { record.active.delete(stop); browser.close() })
      releaseMessages(true)
      return
    }
    let body
    if (req.body !== undefined && /^(?:application\/json|application\/x-www-form-urlencoded)(?:;|$)/i.test(req.headers['content-type'] || '')) {
      body = Buffer.from(/^application\/json/i.test(req.headers['content-type'])
        ? JSON.stringify(req.body)
        : new URLSearchParams(req.body).toString())
      headers['content-length'] = String(body.length)
    }
    const upstream = http.request({
      hostname: '127.0.0.1',
      port: descriptor.endpoint.localPort,
      path: requestedPath,
      method: req.method,
      headers,
      timeout: 40000
    }, incoming => {
      incoming.once('error', () => upstream.destroy(new Error('Context response unavailable')))
      const responseHeaders = { 'cache-control': 'no-store', connection: 'close', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff' }
      for (const name of ['content-type', 'content-disposition', 'content-range', 'accept-ranges']) {
        if (incoming.headers[name]) responseHeaders[name] = incoming.headers[name]
      }
      if (req.method === 'GET' && ['/', '/index.html'].includes(req.path) &&
          /^text\/html\b/i.test(incoming.headers['content-type'] || '')) {
        const chunks = []
        let length = 0
        incoming.on('data', chunk => {
          length += chunk.length
          if (length > 1024 * 1024) return upstream.destroy(new Error('Context HTML limit exceeded'))
          chunks.push(chunk)
        })
        incoming.on('end', () => {
          const html = Buffer.concat(chunks).toString('utf8')
          if (!html.includes('</head>')) return upstream.destroy(new Error('Invalid context HTML'))
          res.writeHead(incoming.statusCode, responseHeaders)
          res.end(html.replace('</head>', CONTEXT_SCRIPT + '</head>'))
        })
      } else {
        res.writeHead(incoming.statusCode, responseHeaders)
        pipeline(incoming, res, error => { if (error) res.destroy() })
      }
    })
    const stop = () => { upstream.destroy(); res.destroy() }
    record.active.add(stop)
    res.once('close', () => { record.active.delete(stop); upstream.destroy() })
    req.once('aborted', () => upstream.destroy())
    upstream.once('timeout', () => upstream.destroy(new Error('Context response timeout')))
    upstream.once('error', () => {
      log.warn('Managed Windows context HTTP unavailable')
      if (!res.headersSent) res.status(503).json({ error: 'Selected Windows context unavailable' })
      else res.destroy()
    })
    if (body) upstream.end(body)
    else req.pipe(upstream)
  }

  return {
    async middleware (req, res, next) {
      const control = req.path === CONTEXT_ROUTE
      const selected = Object.hasOwn(req.headers, CONTEXT_HEADER)
      let releaseMessages = () => {}
      if (selected && req.ws) {
        req.wsHandled = true
        const pending = []
        let bytes = 0
        const buffer = (data, binary) => {
          bytes += Buffer.byteLength(data)
          if (bytes > 1024 * 1024 || pending.length >= 1024) return req.ws.close(1009, 'Context connection queue exceeded')
          pending.push([data, binary])
        }
        req.ws.on('message', buffer)
        releaseMessages = replay => {
          req.ws.removeListener('message', buffer)
          if (replay) for (const message of pending) req.ws.emit('message', ...message)
          pending.length = 0
        }
      }
      const deny = (status, error) => {
        releaseMessages(false)
        if (req.ws) { req.wsHandled = true; return req.ws.close(1008, error) }
        return res.status(status).json({ error })
      }
      if (!control && !selected && !(validSession(req.headers[SESSION_HEADER]) && ['/', '/index.html'].includes(req.path))) return next()
      res.setHeader('Cache-Control', 'no-store')
      if (!sameSecret(req.headers[HEADER], secret) || !validSession(req.headers[SESSION_HEADER])) {
        return deny(403, 'Managed context authentication required')
      }
      try {
        if (selected && !hexID(req.headers[CONTEXT_HEADER])) throw new Error('Invalid context selector')
        const record = binding(req.headers[SESSION_HEADER])
        if (control) {
          if (selected || req.ws) return deny(403, 'Context control requires canonical SYSTEM transport')
          if (req.method === 'GET') return res.json(await catalog(record))
          if (req.method !== 'POST') return res.status(405).json({ error: 'Unsupported context method' })
          if (!req.body || Object.keys(req.body).join(',') !== 'id' || !hexID(req.body.id)) {
            return res.status(400).json({ error: 'Select one listed Windows context' })
          }
          const choice = record.choices.get(req.body.id)
          if (!choice) return res.status(409).json({ error: 'Windows context list expired; refresh it' })
          await catalog(record)
          if (!record.choices.has(req.body.id)) return res.status(409).json({ error: 'Windows context session changed' })
          const descriptor = validateDescriptor(await bridge.call({
            operation: 'launch-context', ...targetRequest(choice)
          }), targetRequest(choice), choice.identity.sid)
          if (choice.target === 'system' && descriptor.contextId !== choice.contextId) throw new Error('Machine context changed')
          const grant = { choice, descriptor, selector: crypto.randomBytes(16).toString('hex') }
          invalidate(record)
          record.grant = grant
          await validate(record, grant)
          return res.json({ selector: grant.selector, context: publicContext(descriptor) })
        }
        if (!selected) {
          req.managedContextUi = true
          return next()
        }
        if (/^\/mcp(?:\/\.websocket)?\/?$/.test(req.path) || req.path.startsWith('/_anubis/')) return deny(403, 'Context endpoint is not available')
        const grant = record.grant
        if (!grant || grant.selector !== req.headers[CONTEXT_HEADER]) return deny(403, 'Context selection does not belong to this browser session')
        const descriptor = await validate(record, grant)
        if (grant.choice.target === 'system') {
          req.managedContextUi = true
          next()
          releaseMessages(true)
          return
        }
        return forward(req, res, record, descriptor, releaseMessages)
      } catch {
        log.warn('Managed Windows context request rejected')
        return deny(503, 'Selected Windows context unavailable; refresh the context list')
      }
    },
    close () {
      clearInterval(timer)
      for (const record of bindings.values()) invalidate(record)
      bindings.clear()
    }
  }
}

module.exports = { createManagedContexts, nativeContextBridge, CONTEXT_HEADER, SESSION_HEADER, CONTEXT_ROUTE, CONTEXT_SCRIPT }
