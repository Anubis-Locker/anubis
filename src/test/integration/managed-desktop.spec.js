const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const net = require('node:net')
const crypto = require('node:crypto')
const { once } = require('node:events')
const { DatabaseSync } = require('node:sqlite')
const { _electron: electron, chromium } = require('playwright')
const { stageBrowserAssets } = require('../../build/bin/browser-assets')
const { checkRendererNavigation } = require('../packaged/lib/renderer-navigation')
const { checkUIDataFlows, checkUIDataPersistence } = require('../packaged/lib/ui-data-flows')
const { startTestVncServer } = require('./lib/vnc-test-server')
const { snapshotWindowsProtocols } = require('./lib/windows-protocol-fixture')
const { createAgent } = require('@ai-security-tool/managed-access')
const { createGateway } = require('@ai-security-tool/managed-access/server')

async function responseStatus (url, options) {
  const response = await fetch(url, options)
  await response.arrayBuffer()
  return response.status
}

async function waitUntil (predicate, message, timeout = 30000) {
  const deadline = Date.now() + timeout
  while (!await predicate()) {
    if (Date.now() >= deadline) throw new Error(message)
    await new Promise(resolve => setTimeout(resolve, 100))
  }
}

async function reservePort () {
  const server = net.createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  return port
}

async function bounded (promise, message, timeout = 8000) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeout)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}

function httpShape (status, contentType, text) {
  const shape = { status, contentType, bytes: Buffer.byteLength(text) }
  if (contentType.includes('json')) {
    let data
    try {
      data = JSON.parse(text)
    } catch {
      return { ...shape, bodyType: 'invalid-json' }
    }
    shape.bodyType = data === null ? 'null' : Array.isArray(data) ? 'array' : typeof data
    if (data && typeof data === 'object') {
      shape.keys = ['error', 'config', 'brand', 'version', 'requirePassword'].filter(key => Object.hasOwn(data, key))
      if (data.error) {
        shape.errorClass = {
          'Desktop authentication required': 'desktop-password',
          'Invalid desktop password': 'invalid-password',
          'Open this device from the administrator panel': 'gateway-operator'
        }[data.error] || 'other'
      }
    }
  } else if (contentType.includes('html')) {
    shape.bodyType = 'html'
    shape.managedBootstrap = text.includes('id="managed-connectivity"') && text.includes('window.et=')
    shape.automaticSessionIssued = /localStorage\.setItem\(['"]tokenElecterm['"]/.test(text)
  } else {
    shape.bodyType = text ? 'text' : 'empty'
  }
  return shape
}

async function checkNativeMcp (request, nativeSessions, browserTabs, localToken) {
  const initialize = await request('/mcp', 'POST', {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'managed-desktop-qa', version: '1.0.0' } }
  })
  assert.equal(initialize.status, 200)
  const info = JSON.parse(initialize.body)
  assert.ok(info.result.serverInfo)
  const headers = {
    'mcp-session-id': initialize.headers['mcp-session-id'],
    'mcp-protocol-version': info.result.protocolVersion
  }
  assert.ok(headers['mcp-session-id'])
  const call = body => request('/mcp', 'POST', { jsonrpc: '2.0', ...body }, headers)
  assert.equal((await call({ method: 'notifications/initialized' })).status, 202)
  const tools = await call({ id: 2, method: 'tools/list' })
  assert.equal(tools.status, 200)
  assert.ok(JSON.parse(tools.body).result.tools.some(tool => tool.name === 'list_electerm_tabs'))
  const tabs = await call({ id: 3, method: 'tools/call', params: { name: 'list_electerm_tabs', arguments: {} } })
  assert.equal(tabs.status, 200)
  assert.notEqual(JSON.parse(tabs.body).result.isError, true)
  for (const id of nativeSessions) assert.ok(tabs.body.includes(id), 'MCP must address the native Electron store')
  for (const id of browserTabs.filter(id => !nativeSessions.includes(id))) assert.equal(tabs.body.includes(id), false)
  assert.ok(!JSON.stringify([initialize, tools, tabs]).includes(localToken), 'Native MCP credential must not leave the desktop')
  return headers
}

test('isolated Electron desktop serves a real browser through the managed adapter', {
  skip: (process.env.ANUBIS_DESKTOP_MANAGED_E2E !== '1' && !process.env.ANUBIS_MANAGED_EXE && process.env.ANUBIS_MANAGED_LIVE !== '1') || process.platform !== 'win32',
  timeout: 600000
}, async t => {
  const executable = process.env.ANUBIS_MANAGED_EXE
    ? path.resolve(process.env.ANUBIS_MANAGED_EXE)
    : null
  const live = process.env.ANUBIS_MANAGED_LIVE === '1'
  const adminToken = process.env.ANUBIS_MANAGED_ADMIN_TOKEN
  const apiOrigin = 'https://api.anubis.locker'
  if (executable) {
    assert.ok(fs.statSync(executable).isFile(), 'ANUBIS_MANAGED_EXE must identify an actual packaged executable')
    const resources = path.join(path.dirname(executable), 'resources')
    assert.ok(fs.existsSync(path.join(resources, 'app.asar')) ||
      fs.existsSync(path.join(resources, 'app', 'package.json')),
    'ANUBIS_MANAGED_EXE must be the packaged application, not an installer or bare Electron')
  }
  if (live) {
    assert.ok(executable, 'Live acceptance requires ANUBIS_MANAGED_EXE; source fallback is forbidden')
    assert.ok(adminToken, 'Live acceptance requires the QA controller administrator credential')
  }
  const redact = value => {
    let text = String(value)
    if (adminToken) text = text.split(adminToken).join('[redacted]')
    return text.replace(/\b[0-9a-f]{64,128}\b/gi, '[redacted]')
      .replace(/([?&](?:token|ticket)=)[^&\s]+/gi, '$1[redacted]')
  }
  const checks = []
  const check = (name, fn) => t.test(name, async sub => {
    try {
      await fn(sub)
      checks.push({ name, passed: true })
    } catch (error) {
      checks.push({ name, passed: false, error: redact(error.message) })
      const failure = new Error(redact(error.message))
      failure.stack = redact(error.stack || failure.stack)
      throw failure
    }
  })
  const testContext = { test: check }
  const report = {
    mode: live ? 'packaged-live' : executable ? 'packaged-local' : 'source-local',
    executable,
    checks,
    completed: false,
    authPhases: [],
    authHttp: []
  }
  const reportPath = process.env.ANUBIS_MANAGED_REPORT
    ? path.resolve(process.env.ANUBIS_MANAGED_REPORT)
    : null
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'anubis-managed-desktop-'))
  const runtime = path.join(root, 'app')
  const data = path.join(root, 'data')
  const home = path.join(root, 'home')
  const appData = path.join(root, 'appdata')
  const profile = path.join(root, 'profile')
  for (const directory of [runtime, data, home, appData, profile]) fs.mkdirSync(directory)
  for (const name of ['Local', 'Roaming']) fs.mkdirSync(path.join(home, 'AppData', name), { recursive: true })
  fs.writeFileSync(path.join(home, 'managed-filesystem-marker.txt'), 'managed filesystem fixture')
  const entry = path.join(runtime, 'qa-entry.cjs')
  if (!executable) {
    fs.cpSync(path.resolve(__dirname, '../../app'), runtime, { recursive: true })
    fs.copyFileSync(path.resolve(__dirname, '../../common/brand.config.js'), path.join(runtime, 'common', 'brand.config.js'))
    fs.writeFileSync(path.join(runtime, 'package.json'), JSON.stringify(require('../../../package.json')))
    fs.writeFileSync(entry, `const { app } = require('electron')
app.setPath('appData', ${JSON.stringify(appData)})
app.setPath('home', ${JSON.stringify(home)})
app.setPath('userData', ${JSON.stringify(profile)})
require('./app.js')
`)
    fs.symlinkSync(path.resolve('node_modules'), path.join(runtime, 'node_modules'), 'junction')
    fs.symlinkSync(path.resolve('work/app/assets'), path.join(runtime, 'assets'), 'junction')
    stageBrowserAssets({
      source: process.env.ANUBIS_TEST_BROWSER_ASSETS || undefined,
      destination: path.join(runtime, 'browser-assets')
    })
  }
  const databaseDirectory = path.join(data, 'users', 'default_user')
  fs.mkdirSync(databaseDirectory, { recursive: true })
  const db = new DatabaseSync(path.join(databaseDirectory, 'electerm_data.db'))
  db.exec('CREATE TABLE data (_id TEXT PRIMARY KEY, data TEXT)')
  const insert = db.prepare('INSERT INTO data (_id, data) VALUES (?, ?)')
  insert.run('userConfigNoEncrypt', JSON.stringify({ _id: 'userConfigNoEncrypt', allowMultiInstance: true }))
  insert.run('userConfig', JSON.stringify({ _id: 'userConfig', debug: true, confirmBeforeExit: false, deepLinkAutoRegister: false }))
  db.close()
  const port = await reservePort()
  let desktop = null
  let browser = null
  let gateway = null
  const gatewaySockets = new Set()
  const errors = []
  const executablePath = executable || path.resolve('node_modules/electron/dist/electron.exe')
  const protocols = snapshotWindowsProtocols(root, [root, executablePath])
  let liveDevice
  let isolatedProfileVerified = false
  let revoked = false
  let adminPage
  let tracingAuth = false
  const api = (route, method = 'GET') => {
    assert.ok(live && liveDevice, 'Production API requests require a verified fresh QA identity')
    return fetch(apiOrigin + route, {
      method,
      headers: { authorization: `Bearer ${adminToken}` },
      redirect: 'error',
      signal: AbortSignal.timeout(15000)
    })
  }
  t.after(async () => {
    const cleanupErrors = []
    const cleanupState = { desktopClosed: false, protocolsRestored: false, profileRemoved: false }
    const cleanup = async fn => {
      try {
        await fn()
      } catch (error) {
        cleanupErrors.push(error)
      }
    }
    if (live && isolatedProfileVerified && !liveDevice && fs.existsSync(path.join(profile, 'managed-access-identity.json'))) {
      await cleanup(() => {
        const identity = JSON.parse(fs.readFileSync(path.join(profile, 'managed-access-identity.json'), 'utf8'))
        assert.ok(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(identity.id))
        assert.ok(typeof identity.secret === 'string' && /^[0-9a-f]{64}$/.test(identity.secret))
        liveDevice = { id: identity.id, fingerprint: crypto.createHash('sha256').update(identity.secret).digest('hex') }
        report.device = liveDevice
      })
    }
    if (liveDevice && !revoked) {
      await cleanup(async () => {
        const response = await api(`/api/agents/${liveDevice.id}/revoke`, 'POST')
        const result = await response.json()
        assert.equal(response.status, 200, 'Failed to revoke the fresh QA device during cleanup')
        assert.equal(result.id, liveDevice.id)
        assert.equal(result.status, 'revoked')
        revoked = true
      })
    }
    if (browser) await cleanup(() => browser.close())
    if (gateway) {
      await cleanup(async () => {
        for (const socket of gatewaySockets) socket.destroy()
        await new Promise(resolve => gateway.close(resolve))
      })
    }
    cleanupState.deviceRevoked = liveDevice ? revoked : null
    if (desktop) await cleanup(async () => { await desktop.close(); cleanupState.desktopClosed = true })
    if (protocols) await cleanup(() => { protocols.restore(); cleanupState.protocolsRestored = true })
    // Keep registry snapshots if restoration failed, so the parent can recover.
    if (!cleanupErrors.length) {
      await cleanup(() => {
        fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
        cleanupState.profileRemoved = true
      })
    }
    report.cleanupState = cleanupState
    report.cleanupErrors = cleanupErrors.map(error => redact(error.message))
    report.passed = report.completed && checks.every(check => check.passed) && !cleanupErrors.length
    if (reportPath) {
      fs.mkdirSync(path.dirname(reportPath), { recursive: true })
      fs.writeFileSync(reportPath, JSON.stringify(report, null, 2))
    }
    if (cleanupErrors.length) {
      t.diagnostic('QA cleanup requires attention; isolated files retained at ' + root)
      throw new AggregateError(cleanupErrors, 'Managed desktop QA cleanup failed')
    }
  })
  const appEnv = {
    ...process.env,
    NODE_ENV: 'production',
    NODE_TEST: '',
    DATA_PATH: data,
    HOME: home,
    USERPROFILE: home,
    APPDATA: appData,
    LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    ANUBIS_ADMIN_MCP_ENABLED: '0',
    ANUBIS_ADMIN_MANAGED_ENABLED: live ? '1' : '0',
    ANUBIS_ADMIN_AUTOSTART: '0',
    ANUBIS_ADMIN_ERROR_REPORT: '0',
    ANUBIS_ADMIN_UPDATE_ENABLED: '0'
  }
  for (const key of Object.keys(appEnv)) {
    if (key.toUpperCase() === 'ANUBIS_MANAGED_ADMIN_TOKEN') delete appEnv[key]
  }
  if (live) appEnv.ANUBIS_ADMIN_MANAGED_URL = apiOrigin
  desktop = await electron.launch({
    executablePath,
    args: [...(executable ? [] : [entry]), `--user-data-dir=${profile}`, '--server-port', String(port)],
    env: appEnv,
    timeout: 45000
  })
  const paths = await desktop.evaluate(({ app }) => ({
    userData: app.getPath('userData'),
    appPath: app.getAppPath(),
    version: app.getVersion(),
    hasAdminCredential: Object.keys(process.env).some(key => key.toUpperCase() === 'ANUBIS_MANAGED_ADMIN_TOKEN')
  }))
  assert.equal(path.resolve(paths.userData).toLowerCase(), path.resolve(profile).toLowerCase(), 'Packaged launch must use the isolated profile')
  isolatedProfileVerified = true
  assert.equal(paths.hasAdminCredential, false)
  report.appPath = paths.appPath
  report.version = paths.version
  if (executable) assert.equal(paths.version, require('../../../package.json').version, 'Packaged application must match the version under test')
  desktop.process().stderr.on('data', chunk => {
    if (process.env.ANUBIS_TEST_VERBOSE === '1') process.stderr.write(redact(chunk))
  })
  desktop.process().stdout.on('data', chunk => {
    if (process.env.ANUBIS_TEST_VERBOSE === '1') process.stdout.write(redact(chunk))
  })
  const nativePage = await desktop.firstWindow()
  await nativePage.waitForFunction(() => window.store?.configLoaded, null, { timeout: 45000 })
  await nativePage.waitForFunction(() => /PS [^\r\n]*>/.test(document.body.innerText), null, { timeout: 30000 })
  await nativePage.locator('.session-current .xterm-helper-textarea').first().focus()
  await nativePage.keyboard.insertText(process.platform === 'win32'
    ? 'Write-Output ("ANUBIS_NATIVE_" + "TERMINAL_OK")'
    : "printf 'ANUBIS_NATIVE_%s\\n' TERMINAL_OK")
  await nativePage.keyboard.press('Enter')
  await nativePage.waitForFunction(() => document.body.innerText.includes('ANUBIS_NATIVE_TERMINAL_OK'), null, { timeout: 15000 })
  await nativePage.keyboard.insertText("if (Test-Path Env:ANUBIS_MANAGED_ADMIN_TOKEN) { Write-Output ('ANUBIS_ADMIN_ENV_' + 'LEAKED') } else { Write-Output ('ANUBIS_ADMIN_ENV_' + 'CLEAN') }")
  await nativePage.keyboard.press('Enter')
  await nativePage.waitForFunction(() => document.body.innerText.includes('ANUBIS_ADMIN_ENV_CLEAN'), null, { timeout: 15000 })
  const nativeSessions = await nativePage.evaluate(() => window.store.tabs.map(tab => tab.id))
  const readMainState = key => desktop.evaluate(({ app }, key) => {
    const file = process.getBuiltinModule('path').join(app.getAppPath(), 'lib', 'glob-state.js')
    return process.getBuiltinModule('module').createRequire(file)(file).get(key)
  }, key)
  let secret
  let origin
  let page
  const browserEnv = Object.fromEntries(Object.entries(process.env)
    .filter(([key]) => key.toUpperCase() !== 'ANUBIS_MANAGED_ADMIN_TOKEN'))
  browser = await chromium.launch({ env: browserEnv })
  const context = await browser.newContext({ ignoreHTTPSErrors: false })
  const websocketEvents = []
  const pageIds = new WeakMap()
  let nextPageId = 0
  context.on('page', target => {
    pageIds.set(target, ++nextPageId)
    target.on('framenavigated', frame => {
      if (frame !== target.mainFrame()) return
      const previousId = pageIds.get(target)
      for (const event of websocketEvents) {
        if (event.pageId === previousId && !event.closed) event.retiredByNavigation = true
      }
      pageIds.set(target, ++nextPageId)
    })
    target.on('websocket', socket => {
      const url = new URL(socket.url())
      const event = { pageId: pageIds.get(target), protocol: url.protocol, host: url.host, path: url.pathname, tokenLength: url.searchParams.get('token')?.length, received: 0, sent: 0, closed: false }
      websocketEvents.push(event)
      socket.on('framereceived', frame => { event.received += frame.payload.length })
      socket.on('framesent', frame => { event.sent += frame.payload.length })
      socket.on('close', () => { event.closed = true; event.closedAt = Date.now() })
      socket.on('socketerror', error => { event.error = redact(error) })
    })
    target.on('response', async response => {
      if (!tracingAuth) return
      const url = new URL(response.url())
      if (url.origin !== origin) return
      const isAuth = ['/', '/index.html', '/api/get-constants', '/api/login'].includes(url.pathname)
      const isScript = response.request().resourceType() === 'script'
      if (!isAuth && !isScript) return
      const event = { pageId: pageIds.get(target), path: url.pathname, method: response.request().method(), status: response.status() }
      report.authHttp.push(event)
      if (isAuth) {
        try {
          event.shape = httpShape(response.status(), response.headers()['content-type'] || '',
            await bounded(response.text(), 'Auth diagnostic body read timed out', 5000))
        } catch (error) {
          event.bodyReadError = redact(error.message)
        }
      }
    })
    target.on('request', request => {
      if (!tracingAuth) return
      const url = new URL(request.url())
      if (url.origin === origin && (request.resourceType() === 'script' ||
          ['/', '/index.html', '/api/get-constants', '/api/login'].includes(url.pathname))) {
        report.authHttp.push({ pageId: pageIds.get(target), path: url.pathname, method: request.method(), started: true })
      }
    })
    target.on('requestfailed', request => {
      if (!tracingAuth) return
      const url = new URL(request.url())
      if (url.origin === origin) {
        report.authHttp.push({ pageId: pageIds.get(target), path: url.pathname, failure: redact(request.failure()?.errorText || 'unknown') })
      }
    })
    target.on('pageerror', error => errors.push(redact(error.message)))
    target.on('console', message => {
      if (process.env.ANUBIS_TEST_VERBOSE === '1') process.stdout.write(message.type() + ': ' + redact(message.text()) + '\n')
    })
  })
  report.websockets = websocketEvents
  if (!live) {
    secret = await readMainState('managedTransportSecret')
    assert.match(secret, /^[0-9a-f]{64}$/)
    gateway = http.createServer((req, res) => {
      const request = http.request({
        host: '127.0.0.1',
        port,
        path: req.url,
        method: req.method,
        headers: { ...req.headers, 'x-anubis-managed-transport': secret, connection: 'close' }
      }, response => {
        res.writeHead(response.statusCode, response.headers)
        response.pipe(res)
      })
      request.on('error', error => res.destroy(error))
      req.pipe(request)
    })
    gateway.on('connection', socket => {
      gatewaySockets.add(socket)
      socket.once('close', () => gatewaySockets.delete(socket))
    })
    gateway.on('upgrade', (req, socket, head) => {
      const upstream = net.connect({ host: '127.0.0.1', port })
      gatewaySockets.add(upstream)
      upstream.once('close', () => gatewaySockets.delete(upstream))
      upstream.once('connect', () => {
        const headers = { ...req.headers, 'x-anubis-managed-transport': secret }
        upstream.write(`${req.method} ${req.url} HTTP/1.1\r\n` +
        Object.entries(headers).map(([key, value]) => `${key}: ${value}`).join('\r\n') + '\r\n\r\n')
        if (head.length) upstream.write(head)
        socket.pipe(upstream).pipe(socket)
      })
      socket.on('error', () => upstream.destroy())
      upstream.on('error', () => socket.destroy())
      socket.once('close', () => upstream.destroy())
    })
    gateway.listen(0, '127.0.0.1')
    await once(gateway, 'listening')
    origin = `http://127.0.0.1:${gateway.address().port}`
    page = await context.newPage()
    await page.goto(origin, { waitUntil: 'domcontentloaded' })
  } else {
    await check('fresh built-in packaged agent fingerprint is approved through the actual administrator UI', async () => {
      await waitUntil(async () => (await readMainState('managedConnectivity'))?.status === 'pending', 'Built-in packaged agent did not enroll as pending', 90000)
      const state = await readMainState('managedConnectivity')
      assert.match(state.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
      assert.match(state.fingerprint, /^[0-9a-f]{64}$/)
      const identity = JSON.parse(fs.readFileSync(path.join(profile, 'managed-access-identity.json'), 'utf8'))
      assert.equal(identity.id, state.id)
      assert.equal(crypto.createHash('sha256').update(identity.secret).digest('hex'), state.fingerprint)
      liveDevice = { id: state.id, fingerprint: state.fingerprint }
      report.device = liveDevice
      const inventory = await api('/api/agents')
      assert.equal(inventory.status, 200)
      const agent = (await inventory.json()).agents.find(agent => agent.id === liveDevice.id)
      assert.ok(agent)
      assert.equal(agent.status, 'pending')
      assert.equal(agent.fingerprint, liveDevice.fingerprint)
      assert.equal(agent.app, 'anubis-desktop')
      assert.equal(agent.version, paths.version)
      await nativePage.locator('.control-icon-wrap[title="About"]').click()
      const modal = nativePage.locator('.info-modal')
      await modal.getByRole('tab').first().click()
      await modal.getByText(liveDevice.fingerprint, { exact: true }).waitFor()
      assert.ok((await modal.innerText()).includes('Administrator approval is required'))
      await modal.locator('.custom-modal-close').click()
      adminPage = await context.newPage()
      await adminPage.goto(apiOrigin + '/admin')
      await adminPage.locator('#token').fill(adminToken)
      await adminPage.locator('#sign-in').click()
      await adminPage.locator('#inventory').waitFor()
      const row = adminPage.locator('#agent-rows tr').filter({ hasText: liveDevice.id })
      await row.waitFor()
      assert.equal(await row.locator('code').innerText(), liveDevice.fingerprint)
      await row.locator('input[type="checkbox"]').check()
      const [approved] = await Promise.all([
        adminPage.waitForResponse(response =>
          response.url() === `${apiOrigin}/api/agents/${liveDevice.id}/approve` &&
          response.request().method() === 'POST'),
        row.getByRole('button', { name: 'Approve', exact: true }).click()
      ])
      assert.equal(approved.status(), 200)
      await waitUntil(async () => (await readMainState('managedConnectivity'))?.status === 'online', 'Built-in packaged agent did not become online', 90000)
      origin = `https://device-${liveDevice.id.replace(/-/g, '')}.anubis.locker`
      assert.equal(new URL((await readMainState('managedConnectivity')).url).origin, origin)
      await adminPage.locator('#refresh').click()
      await waitUntil(() => row.getByRole('button', { name: 'Open device', exact: true }).isEnabled(), 'Administrator UI did not show ready device')
    })
    assert.ok(origin, 'Live enrollment failed; refusing a local substitute')
    await check('actual Open device popup exchanges a secure cookie over native DNS and TLS', async () => {
      const row = adminPage.locator('#agent-rows tr').filter({ hasText: liveDevice.id })
      const [popup, response] = await Promise.all([
        adminPage.waitForEvent('popup'),
        context.waitForEvent('response', {
          predicate: response => response.url() === origin + '/' && response.request().resourceType() === 'document'
        }),
        row.getByRole('button', { name: 'Open device', exact: true }).click()
      ])
      page = popup
      await page.waitForURL(origin + '/', { timeout: 30000 })
      assert.equal(response.status(), 200)
      const tls = await response.securityDetails()
      assert.ok(tls && tls.protocol.startsWith('TLS'))
      report.tls = { protocol: tls.protocol, issuer: tls.issuer, subjectName: tls.subjectName }
      const cookie = (await context.cookies(origin)).find(cookie => cookie.name === '__Host-anubis-gateway')
      assert.ok(cookie)
      assert.equal(cookie.secure, true)
      assert.equal(cookie.httpOnly, true)
      assert.equal(cookie.sameSite, 'Strict')
      assert.equal(cookie.path, '/')
      assert.equal(cookie.domain, new URL(origin).hostname)
    })
    assert.ok(page, 'Live popup failed; refusing a direct/local substitute')
  }
  report.browserOrigin = origin
  const browserFetch = async (route, options = {}) => {
    const cookies = live ? (await context.cookies(origin)).map(cookie => `${cookie.name}=${cookie.value}`).join('; ') : ''
    return fetch(origin + route, {
      ...options,
      headers: { ...(cookies ? { cookie: cookies } : {}), ...options.headers },
      redirect: 'error',
      signal: AbortSignal.timeout(15000)
    })
  }
  const browserStatus = async (route, options) => {
    const response = await browserFetch(route, options)
    await response.arrayBuffer()
    return response.status
  }
  const diagnoseAuth = async (phase, target, detail = {}, emit = false) => {
    let state
    try {
      state = await bounded(target.evaluate(() => {
        let tokenLength
        let storageError
        try {
          tokenLength = window.localStorage.getItem('tokenElecterm')?.length || 0
        } catch (error) {
          storageError = error.name
        }
        return {
          origin: window.location.origin,
          path: window.location.pathname,
          contentType: document.contentType,
          readyState: document.readyState,
          managedBanner: !!document.querySelector('#managed-connectivity'),
          hasApi: !!window.api,
          hasStore: !!window.store,
          authChecked: !!window.store?.authChecked,
          logined: !!window.store?.logined,
          configLoaded: !!window.store?.configLoaded,
          fetchingUser: !!window.store?.fetchingUser,
          logining: !!window.store?.logining,
          passwordInputs: document.querySelectorAll('input[type="password"]').length,
          loginLoading: document.querySelectorAll('.login-loading').length,
          commonWsPresent: !!window.et?.commonWs,
          commonWsClosed: window.et?.commonWs?.closed ?? null,
          commonWsOpened: !!window.et?.wsOpened,
          tokenLength,
          storageError
        }
      }), 'Auth page-state diagnostic timed out', 5000)
    } catch (error) {
      state = { readError: redact(error.message) }
    }
    const diagnostic = { phase, ...detail, state }
    report.authPhases.push(diagnostic)
    if (emit) t.diagnostic(JSON.stringify(diagnostic))
  }
  await page.waitForFunction(() => window.store?.configLoaded, null, { timeout: 45000 })
  if (process.env.ANUBIS_TEST_VERBOSE === '1') {
    t.diagnostic(JSON.stringify(await page.evaluate(() => ({
      tabs: window.store.tabs.map(tab => ({ id: tab.id, type: tab.type, status: tab.status })),
      body: document.body.innerText.slice(-1500)
    }))))
  }
  assert.equal(await page.evaluate(() => window.et.isWebApp), true)
  assert.equal(await page.locator('#managed-connectivity').count(), 1)
  const bookmark = { _id: 'managed-browser-test', title: 'Managed browser persistence', host: '127.0.0.1', password: 'fixture-only' }
  await page.evaluate(record => window.api.runGlobalAsync('dbAction', 'bookmarks', 'insert', record), bookmark)
  const records = await nativePage.evaluate(() => window.pre.runGlobalAsync('dbAction', 'bookmarks', 'findOne', { _id: 'managed-browser-test' }))
  assert.equal(records.password, 'fixture-only')
  assert.deepEqual(await nativePage.evaluate(() => window.store.tabs.map(tab => tab.id)), nativeSessions)
  const config = await page.evaluate(() => window.api.runGlobalAsync('init'))
  assert.equal(config.config.requireAuth, undefined)
  assert.equal(config.config.mcpServerToken, undefined)
  assert.equal(await nativePage.evaluate(token => token !== window.store.config.tokenElecterm, config.config.tokenElecterm), true)
  try {
    await page.waitForFunction(() => /PS [^\r\n]*>/.test(document.body.innerText), null, { timeout: 15000 })
  } catch (error) {
    t.diagnostic(JSON.stringify(websocketEvents))
    t.diagnostic(await page.evaluate(() => document.body.innerText.slice(-1500)))
    throw error
  }
  await page.locator('.session-current .xterm-helper-textarea').first().focus()
  await page.keyboard.insertText(process.platform === 'win32'
    ? 'Write-Output ("ANUBIS_MANAGED_" + "TERMINAL_OK")'
    : "printf 'ANUBIS_MANAGED_%s\\n' TERMINAL_OK")
  await page.keyboard.press('Enter')
  await page.waitForFunction(() => document.body.innerText.includes('ANUBIS_MANAGED_TERMINAL_OK'), null, { timeout: 15000 })
  await checkRendererNavigation(page, testContext)
  await check('managed browser navigates the actual local filesystem', async () => {
    await page.locator('.session-current .term-sftp-tabs .type-tab').nth(1).click()
    const address = page.locator('.session-current .sftp-local-section .sftp-title input').first()
    await address.fill(home)
    await address.press('Enter')
    await page.locator('.session-current .sftp-local-section').getByText('managed-filesystem-marker.txt', { exact: true }).first().waitFor()
    await page.locator('.session-current .term-sftp-tabs .type-tab').nth(0).click()
  })
  await checkUIDataFlows(page, testContext)
  await page.reload()
  await page.waitForFunction(() => window.store?.configLoaded)
  await checkUIDataPersistence(page)
  for (const file of fs.readdirSync(databaseDirectory).filter(file => file.startsWith('electerm_data.db'))) {
    const bytes = fs.readFileSync(path.join(databaseDirectory, file))
    assert.equal(bytes.includes(Buffer.from('packaged-ui-password')), false, 'Saved credential must remain encrypted on disk')
  }
  await check('managed VNC renders native-backed binary pixels and sends input', async () => {
    const vnc = await startTestVncServer()
    try {
      await page.evaluate(port => window.store.addTab({
        type: 'vnc',
        host: '127.0.0.1',
        port,
        title: 'Managed browser VNC',
        scaleViewport: false,
        viewOnly: false
      }), vnc.port)
      await page.waitForFunction(() => {
        const canvas = document.querySelector('.session-current canvas')
        if (!canvas || canvas.width !== 64 || canvas.height !== 48) return false
        const pixel = canvas.getContext('2d').getImageData(10, 10, 1, 1).data
        return pixel[0] === 0 && pixel[1] === 255 && pixel[2] === 0
      })
      await page.locator('.session-current canvas').click({ position: { x: 10, y: 10 } })
      await page.keyboard.press('a')
      const deadline = Date.now() + 5000
      while (!vnc.events.keys.some(event => event.down && event.key === 97) && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 50))
      }
      assert.ok(vnc.events.keys.some(event => event.down && event.key === 97))
      assert.ok(vnc.events.pointers.some(event => event.buttons === 1))
      assert.deepEqual(vnc.errors, [])
    } finally {
      await vnc.close()
    }
  })
  if (!live) {
    await check('published gateway MCP grant reaches the native target without exporting credentials', async sub => {
      assert.equal(await responseStatus(origin + '/mcp'), 503)
      assert.equal(fs.existsSync(path.join(profile, 'admin-mcp-token')), false)
      await assert.rejects(page.evaluate(() => window.api.runGlobalAsync('managedMcpEndpoint')), /Internal managed function/)
      const browserTabs = await page.evaluate(() => window.store.tabs.map(tab => tab.id))
      const browserToken = await page.evaluate(() => window.store.config.tokenElecterm)
      await nativePage.evaluate(() => window.pre.runGlobalAsync('setPassword', 'managed-mcp-fixture-password'))
      assert.equal(await responseStatus(origin + '/api/get-constants', { headers: { token: browserToken } }), 401)
      const adminCredential = crypto.randomBytes(32).toString('hex')
      const controller = createGateway({
        dataDir: path.join(root, 'gateway-data'),
        domain: 'anubis.test',
        isAdmin: req => req.headers.authorization === `Bearer ${adminCredential}`,
        channelTimeout: 3000
      })
      const controllerServer = http.createServer(async (req, res) => {
        if (!await controller.handle(req, res)) res.writeHead(404).end()
      })
      controllerServer.on('upgrade', controller.upgrade)
      controllerServer.listen(0, '127.0.0.1')
      await once(controllerServer, 'listening')
      const controllerOrigin = `http://127.0.0.1:${controllerServer.address().port}`
      const states = []
      const agent = createAgent({
        baseUrl: controllerOrigin,
        identityFile: path.join(profile, 'qa-mcp-agent-identity.json'),
        localHost: '127.0.0.1',
        localPort: port,
        localHeaders: { 'x-anubis-managed-transport': secret },
        probe: async () => await responseStatus(`http://127.0.0.1:${port}/run`) === 200,
        onStatus: state => states.push(state),
        heartbeatMs: 50,
        reconnectMs: 50
      })
      sub.after(async () => {
        await agent.stop()
        await controller.close()
        controllerServer.closeAllConnections()
        await new Promise(resolve => controllerServer.close(resolve))
      })
      const admin = route => fetch(controllerOrigin + route, {
        method: 'POST',
        headers: { authorization: `Bearer ${adminCredential}` }
      })
      const waitState = async status => {
        const deadline = Date.now() + 10000
        while (!states.some(state => state.status === status)) {
          if (Date.now() > deadline) throw new Error(`Managed agent did not reach ${status}`)
          await new Promise(resolve => setTimeout(resolve, 25))
        }
      }
      agent.start()
      await waitState('pending')
      const approval = await admin(`/api/agents/${agent.id}/approve`)
      await approval.arrayBuffer()
      assert.equal(approval.status, 200)
      await waitState('online')
      const issued = await admin(`/api/agents/${agent.id}/mcp-token`)
      const grant = await issued.json()
      assert.equal(issued.status, 200)
      assert.equal(grant.scope, 'mcp')
      const deviceRequest = (route, method = 'GET', body, extraHeaders = {}) => new Promise((resolve, reject) => {
        const request = http.request(controllerOrigin + route, {
          method,
          headers: {
            host: new URL(grant.url).hostname,
            authorization: `Bearer ${grant.token}`,
            accept: 'application/json, text/event-stream',
            'content-type': 'application/json',
            ...extraHeaders
          }
        }, response => {
          const chunks = []
          response.on('data', chunk => chunks.push(chunk))
          response.once('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString() }))
          response.once('error', reject)
        })
        request.once('error', reject)
        request.setTimeout(15000, () => request.destroy(new Error('Managed MCP fixture timed out')))
        request.end(body === undefined ? undefined : JSON.stringify(body))
      })
      assert.equal((await deviceRequest('/')).status, 401)
      const listener = net.createServer()
      listener.listen(0, '127.0.0.1')
      await once(listener, 'listening')
      const mcpPort = listener.address().port
      await new Promise(resolve => listener.close(resolve))
      await desktop.evaluate(() => { process.env.ANUBIS_ADMIN_MCP_ENABLED = '1' })
      let widget
      try {
        widget = await nativePage.evaluate(port => window.store.runWidget('mcp-server', { host: '127.0.0.1', port }), mcpPort)
        const token = fs.readFileSync(path.join(profile, 'admin-mcp-token'), 'utf8').trim()
        const headers = await checkNativeMcp(deviceRequest, nativeSessions, browserTabs, token)
        assert.equal((await deviceRequest('/mcp', 'DELETE', undefined, headers)).status, 200)
        const revoke = await admin(`/api/agents/${agent.id}/revoke`)
        await revoke.arrayBuffer()
        assert.equal(revoke.status, 200)
        assert.equal((await deviceRequest('/mcp', 'POST', { jsonrpc: '2.0', id: 3, method: 'tools/list' }, headers)).status, 401)
      } finally {
        if (widget) await nativePage.evaluate(id => window.store.stopWidget(id), widget.instanceId)
        await desktop.evaluate(() => { process.env.ANUBIS_ADMIN_MCP_ENABLED = '0' })
      }
      assert.equal(await responseStatus(origin + '/mcp'), 503)
    })
  }
  let passwordVerified = false
  await check('desktop password invalidates browser sessions without changing managed policy', async () => {
    tracingAuth = true
    try {
      const token = await page.evaluate(() => window.store.config.tokenElecterm)
      const before = await nativePage.evaluate(() => window.pre.runGlobalAsync('getManagedConnectivity'))
      const readManagedPolicy = () => desktop.evaluate(() => ({
        enabled: process.env.ANUBIS_ADMIN_MANAGED_ENABLED,
        baseUrl: process.env.ANUBIS_ADMIN_MANAGED_URL || 'https://api.anubis.locker'
      }))
      const policyBefore = await readManagedPolicy()
      await diagnoseAuth('before-password-change', page)
      assert.equal(await nativePage.evaluate(() => window.pre.runGlobalAsync('setPassword', 'managed-desktop-fixture-password')), true)
      const deadline = Date.now() + 5000
      let rejected
      do {
        const response = await browserFetch('/api/get-constants', { headers: { token } })
        rejected = httpShape(response.status, response.headers.get('content-type') || '', await response.text())
        if (rejected.status !== 401) await new Promise(resolve => setTimeout(resolve, 50))
      } while (rejected.status !== 401 && Date.now() < deadline)
      await diagnoseAuth('old-session-rejected', page, { http: rejected })
      assert.equal(rejected.status, 401)
      assert.equal(rejected.errorClass, 'desktop-password', 'Rejection must come from the desktop password gate, not a lost gateway cookie')
      const documentResponse = await page.reload({ waitUntil: 'domcontentloaded' })
      assert.ok(documentResponse)
      const documentShape = httpShape(documentResponse.status(), documentResponse.headers()['content-type'] || '',
        await bounded(documentResponse.text(), 'Reauthentication document body timed out', 5000))
      await diagnoseAuth('reauthentication-document', page, { http: documentShape })
      assert.equal(documentShape.status, 200, 'Existing approved browser must still reach its managed bootstrap')
      assert.equal(documentShape.managedBootstrap, true)
      assert.equal(documentShape.automaticSessionIssued, false, 'Desktop password must prevent automatic browser session issuance')
      await page.locator('input[type="password"]').waitFor()
      await diagnoseAuth('password-form-visible', page)
      const login = password => browserFetch('/api/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password })
      })
      const wrong = await login('wrong-password')
      const wrongShape = httpShape(wrong.status, wrong.headers.get('content-type') || '', await wrong.text())
      assert.equal(wrongShape.status, 401)
      assert.equal(wrongShape.errorClass, 'invalid-password')
      const valid = await login('managed-desktop-fixture-password')
      assert.equal(valid.status, 200)
      const fresh = await valid.json()
      assert.match(fresh, /^[0-9a-f]{64}$/)
      assert.notEqual(fresh, token)
      assert.equal(await browserStatus('/api/get-constants', { headers: { token: fresh } }), 200)
      await page.locator('input[type="password"]').fill('managed-desktop-fixture-password')
      const [loginResponse] = await Promise.all([
        page.waitForResponse(response => response.url() === origin + '/api/login' && response.request().method() === 'POST'),
        page.locator('input[type="password"]').press('Enter')
      ])
      assert.equal(loginResponse.status(), 200)
      await page.waitForFunction(() => window.store?.configLoaded && window.store?.logined &&
        window.et?.wsOpened && window.et?.commonWs && !window.et.commonWs.closed)
      assert.deepEqual(await bounded(page.evaluate(() => window.api.runGlobalAsync('getScreenSize')),
        'Browser RPC did not recover after desktop password login'), { width: 1920, height: 1080 })
      await diagnoseAuth('browser-reauthenticated', page)
      let after
      await waitUntil(async () => {
        after = await nativePage.evaluate(() => window.pre.runGlobalAsync('getManagedConnectivity'))
        assert.equal(after.id, before.id, 'Desktop password must not replace the managed device identity')
        assert.equal(after.fingerprint, before.fingerprint, 'Desktop password must not rotate the managed device credential')
        return after.status === (live ? 'online' : 'disabled')
      }, 'Managed connectivity did not return to its administratively configured state after password login')
      if (live) assert.equal(new URL(after.url).origin, origin)
      assert.deepEqual(await readManagedPolicy(), policyBefore)
      report.managedPolicy = { identityUnchanged: true, policyUnchanged: true, finalStatus: after.status }
      passwordVerified = true
    } catch (error) {
      await diagnoseAuth('password-phase-failed', page, { error: redact(error.message), recentHttp: report.authHttp.slice(-12) }, true)
      throw error
    } finally {
      tracingAuth = false
    }
  })
  if (!passwordVerified) {
    report.blockedPhases = ['dependent MCP capability and revocation assertions']
    throw new Error('Desktop password phase failed; dependent MCP phase was not executed. See authPhases/authHttp diagnostics.')
  }
  if (live) {
    await check('live scoped MCP preserves native targeting and revocation closes active browser and SSE', async sub => {
      assert.equal(await browserStatus('/mcp'), 503)
      assert.equal(fs.existsSync(path.join(profile, 'admin-mcp-token')), false)
      await bounded(page.waitForFunction(() => window.store?.logined && window.et?.wsOpened &&
        window.et?.commonWs && !window.et.commonWs.closed),
      'Authenticated browser common WebSocket is not ready before MCP checks')
      await assert.rejects(bounded(page.evaluate(() => window.api.runGlobalAsync('managedMcpEndpoint')),
        'Internal RPC rejection did not arrive over the authenticated browser WebSocket'), /Internal managed function/)
      assert.equal(await browserStatus('/api/get-constants'), 401, 'Gateway cookie must not bypass the desktop password')
      const browserToken = await page.evaluate(() => window.store.config.tokenElecterm)
      assert.equal(await browserStatus('/api/get-constants', { headers: { token: browserToken } }), 200)
      const browserTabs = await page.evaluate(() => window.store.tabs.map(tab => tab.id))
      const mcpPort = await reservePort()
      await desktop.evaluate(() => { process.env.ANUBIS_ADMIN_MCP_ENABLED = '1' })
      let widget
      const streamAbort = new AbortController()
      sub.after(() => streamAbort.abort())
      try {
        widget = await nativePage.evaluate(port => window.store.runWidget('mcp-server', { host: '127.0.0.1', port }), mcpPort)
        const issued = await api(`/api/agents/${liveDevice.id}/mcp-token`, 'POST')
        assert.equal(issued.status, 200)
        const grant = await issued.json()
        assert.equal(grant.url, origin + '/mcp')
        assert.equal(grant.scope, 'mcp')
        assert.ok(typeof grant.token === 'string' && /^[0-9a-f]{64}$/.test(grant.token))
        assert.ok(grant.expiresAt > Date.now())
        const request = async (route, method = 'GET', body, extraHeaders = {}) => {
          const response = await fetch(origin + route, {
            method,
            headers: {
              authorization: `Bearer ${grant.token}`,
              accept: 'application/json, text/event-stream',
              'content-type': 'application/json',
              ...extraHeaders
            },
            body: body === undefined ? undefined : JSON.stringify(body),
            redirect: 'error',
            signal: AbortSignal.timeout(30000)
          })
          return {
            status: response.status,
            headers: Object.fromEntries(response.headers),
            body: await response.text()
          }
        }
        assert.equal((await request('/')).status, 401)
        const localToken = fs.readFileSync(path.join(profile, 'admin-mcp-token'), 'utf8').trim()
        const headers = await checkNativeMcp(request, nativeSessions, browserTabs, localToken)
        assert.equal((await request('/mcp', 'DELETE', undefined, headers)).status, 200)
        const streamHeaders = await checkNativeMcp(request, nativeSessions, browserTabs, localToken)
        const streamDeadline = setTimeout(() => streamAbort.abort(new Error('Native MCP SSE did not start')), 30000)
        sub.after(() => clearTimeout(streamDeadline))
        const stream = await fetch(origin + '/mcp', {
          headers: {
            ...streamHeaders,
            authorization: `Bearer ${grant.token}`,
            accept: 'text/event-stream'
          },
          redirect: 'error',
          signal: streamAbort.signal
        })
        assert.equal(stream.status, 200)
        assert.ok(stream.headers.get('content-type')?.includes('text/event-stream'))
        const reader = stream.body.getReader()
        const first = await reader.read()
        clearTimeout(streamDeadline)
        assert.equal(first.done, false)
        assert.ok(first.value.length > 0, 'MCP SSE must deliver native heartbeat bytes before revocation')
        let streamClosed = false
        let streamReadError
        let revokeStartedAt = 0
        let streamClosedAfterRevoke = false
        const closed = (async () => {
          try {
            while (true) {
              if ((await reader.read()).done) break
            }
          } catch (error) {
            streamReadError = error.name
          } finally {
            streamClosed = true
            streamClosedAfterRevoke = !!revokeStartedAt
          }
        })()
        const active = websocketEvents.filter(event => event.pageId === pageIds.get(page) && !event.closed)
        assert.ok(active.some(event => event.received > 0), 'A real browser WebSocket must be active before revocation')
        assert.ok(!streamClosed, 'MCP SSE must still be active before revocation')
        for (const event of websocketEvents) {
          assert.equal(event.protocol, 'wss:')
          assert.equal(event.host, new URL(origin).host)
          assert.equal(event.tokenLength, 64)
        }
        const [refreshed] = await Promise.all([
          adminPage.waitForResponse(response =>
            response.url() === `${apiOrigin}/api/agents` && response.request().method() === 'GET'),
          adminPage.locator('#refresh').click()
        ])
        assert.equal(refreshed.status(), 200)
        const row = adminPage.locator('#agent-rows tr').filter({ hasText: liveDevice.id })
        await row.getByRole('button', { name: 'Revoke', exact: true }).click()
        assert.ok(!streamClosed && active.every(event => !event.closed), 'Browser and MCP streams must remain open until revocation')
        revokeStartedAt = Date.now()
        const [revokedResponse] = await Promise.all([
          adminPage.waitForResponse(response =>
            response.url() === `${apiOrigin}/api/agents/${liveDevice.id}/revoke` &&
            response.request().method() === 'POST'),
          row.getByRole('button', { name: 'Confirm revoke', exact: true }).click()
        ])
        assert.equal(revokedResponse.status(), 200)
        const revocation = await revokedResponse.json()
        assert.equal(revocation.id, liveDevice.id)
        assert.equal(revocation.status, 'revoked')
        revoked = true
        await waitUntil(() => streamClosed && active.every(event => event.closed), 'Revocation did not close existing browser WebSockets and MCP SSE', 15000)
        await closed
        assert.equal(streamAbort.signal.aborted, false, 'SSE must close because of revocation, not the QA abort timer')
        assert.equal(streamClosedAfterRevoke, true)
        assert.ok(!streamReadError || ['TypeError', 'AbortError'].includes(streamReadError), 'Unexpected MCP SSE failure: ' + streamReadError)
        assert.ok(active.every(event => event.closedAt >= revokeStartedAt))
        report.revocation = { activeBrowserSocketsClosed: active.length, nativeMcpSseClosed: streamClosed }
        assert.equal(await browserStatus('/api/get-constants', { headers: { token: browserToken } }), 401)
        assert.equal((await request('/mcp', 'POST', { jsonrpc: '2.0', id: 4, method: 'tools/list' }, streamHeaders)).status, 401)
        await waitUntil(async () => (await readMainState('managedConnectivity'))?.status === 'revoked', 'Built-in packaged agent did not observe revocation', 30000)
      } finally {
        if (widget) await nativePage.evaluate(id => window.store.stopWidget(id), widget.instanceId)
        await desktop.evaluate(() => { process.env.ANUBIS_ADMIN_MCP_ENABLED = '0' })
      }
      await adminPage.locator('#sign-out').click()
    })
  }
  assert.deepEqual(await nativePage.evaluate(() => window.store.tabs.map(tab => tab.id)), nativeSessions)
  await nativePage.locator('.session-current .xterm-helper-textarea').first().focus()
  await nativePage.keyboard.insertText('Write-Output ("ANUBIS_NATIVE_" + "STILL_RUNNING")')
  await nativePage.keyboard.press('Enter')
  await nativePage.waitForFunction(() => document.body.innerText.includes('ANUBIS_NATIVE_STILL_RUNNING'))
  assert.deepEqual(errors, [])
  report.completed = true
})
