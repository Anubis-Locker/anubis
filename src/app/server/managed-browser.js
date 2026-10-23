const crypto = require('crypto')
const express = require('express')
const path = require('path')
const WebSocket = require('ws')

const HEADER = 'x-anubis-managed-transport'
const SESSION_TTL = 8 * 60 * 60 * 1000

function resolveBrowserAssets () {
  const bundled = path.resolve(__dirname, '../browser-assets')
  if (require('fs').existsSync(path.join(bundled, 'js'))) return bundled
  return path.join(path.dirname(require.resolve('@ai-security-tool/anubis-browser-assets/package.json')), 'assets')
}

function sameSecret (actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string' || !expected) return false
  const a = Buffer.from(actual)
  const b = Buffer.from(expected)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

function escapeJson (value) {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, c =>
    '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'))
}

function initManagedBrowser (app, {
  secret,
  rpc,
  assetsPath = resolveBrowserAssets(),
  getSessionPort,
  nativeToken,
  log = require('../common/log'),
  now = Date.now
}) {
  if (typeof rpc !== 'function' || typeof getSessionPort !== 'function') {
    throw new TypeError('Managed browser requires desktop RPC and session routing')
  }
  const sessions = new Map()
  const sockets = new Set()
  const sftpSessions = new Map()
  let files
  let failedLogins = 0
  let loginWindow = now()
  const staticFiles = express.static(assetsPath, { cacheControl: false, etag: false, lastModified: false })
  const manifest = path.join(assetsPath, 'manifest.json')
  const rendererVersion = require('fs').existsSync(manifest)
    ? JSON.parse(require('fs').readFileSync(manifest, 'utf8')).version
    : require('@ai-security-tool/anubis-browser-assets/package.json').version
  const issue = (unlocked) => {
    for (const [id, session] of sessions) {
      if (session.expires <= now()) sessions.delete(id)
    }
    if (sessions.size >= 128) throw new Error('Too many managed browser sessions')
    const token = crypto.randomBytes(32).toString('hex')
    sessions.set(token, { unlocked, expires: now() + SESSION_TTL })
    return token
  }
  const sessionFor = req => {
    const token = req.headers.token || req.query.token
    const session = sessions.get(token)
    return session && session.expires > now() && session.unlocked ? session : null
  }
  app.use(async (req, res, next) => {
    const provided = req.headers[HEADER]
    if (!provided) return next()
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('Referrer-Policy', 'no-referrer')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    if (req.headers.upgrade?.toLowerCase() !== 'websocket') {
      // The gateway injects transport authentication into the first request
      // only. Do not permit a second HTTP request on the same TCP channel.
      res.setHeader('Connection', 'close')
      res.shouldKeepAlive = false
    }
    if (!sameSecret(provided, secret)) return res.status(403).json({ error: 'Invalid managed transport' })
    if (req.headers.upgrade?.toLowerCase() === 'websocket') {
      log.debug('Managed browser WebSocket request:', req.path)
    }
    try {
      const pathname = req.path
      if (req.method === 'GET' && ['/', '/index.html'].includes(pathname)) {
        const info = await rpc('browserInfo')
        const token = info.requirePassword ? '' : issue(true)
        const version = rendererVersion
        const globals = {
          ...info,
          version,
          isDev: false,
          isWebApp: true,
          disableUpgradeCheck: true,
          siteName: info.brand.name,
          cdn: '',
          server: '',
          query: {},
          hasNodePty: true,
          needMigrate: false,
          extIconPath: '/icons/',
          sysMenus: ['onNewSsh', 'addTab', 'openSetting', 'history', 'bookmarks', 'sessions', 'layout', 'openAbout', 'zoom', 'reload']
        }
        delete globals.config
        delete globals.requirePassword
        return res.type('html').send(`<!doctype html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Managed Anubis desktop</title><link rel="stylesheet" href="/css/style-${version}.css">${req.managedContextUi ? '<script src="/_anubis/context-ui.js" defer></script>' : ''}</head><body><div role="status" id="managed-connectivity">Managed connectivity &mdash; authenticated remote desktop access</div><div id="container"></div><style id="theme-css"></style><style id="custom-css"></style><script>window.et=${escapeJson(globals)};${token ? `localStorage.setItem('tokenElecterm',${escapeJson(token)});` : ''}</script><script type="module" src="/js/basic-${version}.js"></script></body></html>`)
      }
      if (req.method === 'POST' && pathname === '/api/login') {
        if (now() - loginWindow >= 60000) {
          failedLogins = 0
          loginWindow = now()
        }
        if (++failedLogins > 10) return res.status(429).json({ error: 'Too many desktop login attempts' })
        const ok = await rpc('browserLogin', [req.body?.password])
        if (!ok) return res.status(401).json({ error: 'Invalid desktop password' })
        return res.json(issue(true))
      }
      const session = sessionFor(req)
      if (req.method === 'GET' && pathname === '/api/get-constants') {
        if (!session) return res.status(401).json({ error: 'Desktop authentication required' })
        const info = await rpc('browserInfo')
        return res.json({
          ...info,
          config: { ...info.config, tokenElecterm: req.headers.token || req.query.token }
        })
      }
      if (/^\/(?:js|chunk|css|images|icons|assets)\//.test(pathname) || pathname === '/favicon.ico') {
        return staticFiles(req, res, () => res.status(404).end())
      }
      if (!session) return res.status(401).json({ error: 'Desktop authentication required' })
      if (pathname === '/api/download' && req.method === 'GET') {
        files ||= require('./managed-files').createManagedFiles()
        return files.download(req, res)
      }
      if (pathname === '/api/upload' && req.method === 'POST') {
        files ||= require('./managed-files').createManagedFiles()
        return files.upload(req, res)
      }
      if (pathname === '/common/s/.websocket' || pathname === '/common/s') {
        sockets.add(req.ws)
        req.ws.once('close', () => sockets.delete(req.ws))
        req.managedSession = session
        req.managedRpc = (func, args) => {
          if (['managedMcpEndpoint', 'browserInfo', 'browserLogin'].includes(func)) {
            throw new Error('Internal managed function is not a browser API')
          }
          return rpc(func, args)
        }
        return next()
      }
      if (/^\/(?:terminals|sftp|transfer|vnc|rdp|spice)\/[^/]+(?:\/[^/]+)?(?:\/\.websocket)?$/.test(pathname)) {
        req.managedSession = session
        return next()
      }
      return res.status(403).json({ error: 'Endpoint is not available through managed access' })
    } catch (error) {
      log.warn('Managed browser request failed:', error.message)
      return res.status(503).json({ error: 'Managed desktop backend unavailable' })
    }
  })

  for (const type of ['terminals', 'sftp', 'transfer', 'vnc', 'rdp', 'spice']) {
    const route = `/${type}/:pid`
    app.ws(route, (browser, req) => {
      log.debug('Managed browser session route:', type, req.params.pid)
      if (!req.managedSession) return browser.close(1008, 'Managed authentication required')
      const terminalId = type === 'sftp'
        ? req.query.sftpId
        : type === 'transfer' ? sftpSessions.get(req.query.sftpId) : req.params.pid
      const port = getSessionPort(terminalId)
      if (!port) return browser.close(1008, 'Unknown desktop session')
      if (type === 'sftp') sftpSessions.set(req.params.pid, terminalId)
      const url = new URL(req.url.replace(/\/\.websocket(?=\?|$)/, ''), `ws://127.0.0.1:${port}`)
      url.searchParams.set('token', nativeToken)
      const upstream = new WebSocket(url, { perMessageDeflate: false, maxPayload: 16 * 1024 * 1024, handshakeTimeout: 10000 })
      const expiry = setTimeout(() => browser.close(1008, 'Desktop session expired'), req.managedSession.expires - now())
      const pending = []
      let queuedBytes = 0
      sockets.add(browser)
      sockets.add(upstream)
      browser.on('message', (data, binary) => {
        binary = typeof binary === 'boolean' ? binary : typeof data !== 'string'
        if (upstream.readyState === WebSocket.OPEN) {
          if (upstream.bufferedAmount > 16 * 1024 * 1024) return browser.close(1013, 'Connection is overloaded')
          upstream.send(data, { binary })
        } else if (upstream.readyState === WebSocket.CONNECTING) {
          queuedBytes += data.length
          if (queuedBytes > 1024 * 1024) return browser.close(1009, 'Connection queue exceeded')
          pending.push([data, binary])
        }
      })
      upstream.on('open', () => {
        log.debug('Managed session transport connected:', type, req.params.pid, port)
        for (const [data, binary] of pending) upstream.send(data, { binary })
        pending.length = 0
      })
      upstream.on('message', (data, binary) => {
        binary = typeof binary === 'boolean' ? binary : typeof data !== 'string'
        if (browser.readyState !== WebSocket.OPEN) return
        if (browser.bufferedAmount > 16 * 1024 * 1024) return browser.close(1013, 'Connection is overloaded')
        browser.send(data, { binary })
      })
      browser.on('close', () => {
        clearTimeout(expiry)
        sockets.delete(browser)
        if (type === 'sftp') sftpSessions.delete(req.params.pid)
        upstream.terminate()
      })
      upstream.on('close', () => {
        sockets.delete(upstream)
        browser.close()
      })
      upstream.on('error', error => {
        log.warn('Managed terminal transport failed:', error.message)
        browser.close(1011, 'Desktop session unavailable')
      })
      browser.on('error', () => upstream.terminate())
    })
  }
  return {
    invalidateSessions: () => {
      sessions.clear()
      for (const socket of sockets) socket.close(1008, 'Desktop password changed; sign in again')
    },
    close: () => {
      sessions.clear()
      sftpSessions.clear()
      for (const socket of sockets) socket.terminate()
      sockets.clear()
      files?.close()
    }
  }
}

module.exports = { initManagedBrowser, sameSecret, escapeJson, HEADER }
