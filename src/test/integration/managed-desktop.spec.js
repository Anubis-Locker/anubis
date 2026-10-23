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
const { createAgent } = require('@ai-security-tool/managed-access')
const { createGateway } = require('@ai-security-tool/managed-access/server')

async function responseStatus (url, options) {
  const response = await fetch(url, options)
  await response.arrayBuffer()
  return response.status
}

test('isolated Electron desktop serves a real browser through the managed adapter', {
  skip: process.env.ANUBIS_DESKTOP_MANAGED_E2E !== '1' || process.platform !== 'win32',
  timeout: 300000
}, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'anubis-managed-desktop-'))
  const runtime = path.join(root, 'app')
  const data = path.join(root, 'data')
  const home = path.join(root, 'home')
  const appData = path.join(root, 'appdata')
  const profile = path.join(root, 'profile')
  for (const directory of [runtime, data, home, appData, profile]) fs.mkdirSync(directory)
  fs.writeFileSync(path.join(home, 'managed-filesystem-marker.txt'), 'managed filesystem fixture')
  fs.cpSync(path.resolve(__dirname, '../../app'), runtime, { recursive: true })
  fs.copyFileSync(path.resolve(__dirname, '../../common/brand.config.js'), path.join(runtime, 'common', 'brand.config.js'))
  fs.writeFileSync(path.join(runtime, 'package.json'), JSON.stringify(require('../../../package.json')))
  const entry = path.join(runtime, 'qa-entry.cjs')
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
  const databaseDirectory = path.join(data, 'users', 'default_user')
  fs.mkdirSync(databaseDirectory, { recursive: true })
  const db = new DatabaseSync(path.join(databaseDirectory, 'electerm_data.db'))
  db.exec('CREATE TABLE data (_id TEXT PRIMARY KEY, data TEXT)')
  const insert = db.prepare('INSERT INTO data (_id, data) VALUES (?, ?)')
  insert.run('userConfigNoEncrypt', JSON.stringify({ _id: 'userConfigNoEncrypt', allowMultiInstance: true }))
  insert.run('userConfig', JSON.stringify({ _id: 'userConfig', debug: true, confirmBeforeExit: false, deepLinkAutoRegister: false }))
  db.close()
  const reservation = net.createServer()
  reservation.listen(0, '127.0.0.1')
  await once(reservation, 'listening')
  const port = reservation.address().port
  await new Promise(resolve => reservation.close(resolve))
  let desktop = null
  let browser = null
  let gateway = null
  const gatewaySockets = new Set()
  const errors = []
  t.after(async () => {
    if (browser) await browser.close()
    if (gateway) {
      for (const socket of gatewaySockets) socket.destroy()
      await new Promise(resolve => gateway.close(resolve))
    }
    if (desktop) await desktop.close()
    fs.rmSync(root, { recursive: true, force: true })
  })
  desktop = await electron.launch({
    executablePath: path.resolve('node_modules/electron/dist', process.platform === 'win32' ? 'electron.exe' : 'electron'),
    args: [entry, `--user-data-dir=${profile}`, '--server-port', String(port)],
    env: {
      ...process.env,
      NODE_ENV: 'production',
      NODE_TEST: '',
      DATA_PATH: data,
      HOME: home,
      USERPROFILE: home,
      APPDATA: appData,
      ANUBIS_ADMIN_MCP_ENABLED: '0',
      ANUBIS_ADMIN_MANAGED_ENABLED: '0',
      ANUBIS_ADMIN_AUTOSTART: '0',
      ANUBIS_ADMIN_ERROR_REPORT: '0',
      ANUBIS_ADMIN_UPDATE_ENABLED: '0'
    },
    timeout: 45000
  })
  desktop.process().stderr.on('data', chunk => {
    if (process.env.ANUBIS_TEST_VERBOSE === '1') process.stderr.write(chunk)
  })
  desktop.process().stdout.on('data', chunk => {
    if (process.env.ANUBIS_TEST_VERBOSE === '1') process.stdout.write(chunk)
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
  const nativeSessions = await nativePage.evaluate(() => window.store.tabs.map(tab => tab.id))
  const secret = await desktop.evaluate((_, file) => process.getBuiltinModule('module').createRequire(file)(file).get('managedTransportSecret'), path.join(runtime, 'lib', 'glob-state.js'))
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
  browser = await chromium.launch()
  const page = await browser.newPage()
  const websocketEvents = []
  page.on('websocket', socket => {
    const url = new URL(socket.url())
    const event = { host: url.host, path: url.pathname, tokenLength: url.searchParams.get('token')?.length, received: 0, sent: 0, closed: false }
    websocketEvents.push(event)
    socket.on('framereceived', frame => { event.received += frame.payload.length })
    socket.on('framesent', frame => { event.sent += frame.payload.length })
    socket.on('close', () => { event.closed = true })
    socket.on('socketerror', error => { event.error = error })
  })
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => {
    if (process.env.ANUBIS_TEST_VERBOSE === '1') process.stdout.write(message.type() + ': ' + message.text() + '\n')
  })
  await page.goto(`http://127.0.0.1:${gateway.address().port}/`, { waitUntil: 'domcontentloaded' })
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
  await checkRendererNavigation(page, t)
  await t.test('managed browser navigates the actual local filesystem', async () => {
    await page.locator('.session-current .term-sftp-tabs .type-tab').nth(1).click()
    const address = page.locator('.session-current .sftp-local-section .sftp-title input').first()
    await address.fill(home)
    await address.press('Enter')
    await page.locator('.session-current .sftp-local-section').getByText('managed-filesystem-marker.txt', { exact: true }).first().waitFor()
    await page.locator('.session-current .term-sftp-tabs .type-tab').nth(0).click()
  })
  await checkUIDataFlows(page, t)
  await page.reload()
  await page.waitForFunction(() => window.store?.configLoaded)
  await checkUIDataPersistence(page)
  for (const file of fs.readdirSync(databaseDirectory).filter(file => file.startsWith('electerm_data.db'))) {
    const bytes = fs.readFileSync(path.join(databaseDirectory, file))
    assert.equal(bytes.includes(Buffer.from('packaged-ui-password')), false, 'Saved credential must remain encrypted on disk')
  }
  await t.test('managed VNC renders native-backed binary pixels and sends input', async () => {
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
  await t.test('published gateway MCP grant reaches the native target without exporting credentials', async sub => {
    const origin = `http://127.0.0.1:${gateway.address().port}`
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
      const initialize = await deviceRequest('/mcp', 'POST', {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'managed-desktop-qa', version: '1.0.0' } }
      })
      assert.equal(initialize.status, 200)
      assert.ok(JSON.parse(initialize.body).result.serverInfo)
      const headers = { 'mcp-session-id': initialize.headers['mcp-session-id'] }
      const call = body => deviceRequest('/mcp', 'POST', { jsonrpc: '2.0', ...body }, headers)
      const initialized = await call({ method: 'notifications/initialized' })
      assert.equal(initialized.status, 202)
      const tabsResponse = await call({ id: 2, method: 'tools/call', params: { name: 'list_electerm_tabs', arguments: {} } })
      const tabsText = tabsResponse.body
      assert.equal(tabsResponse.status, 200)
      const result = JSON.parse(tabsText)
      assert.equal(result.result.isError, undefined)
      for (const id of nativeSessions) assert.ok(tabsText.includes(id), 'MCP must address the native Electron store')
      for (const id of browserTabs.filter(id => !nativeSessions.includes(id))) assert.equal(tabsText.includes(id), false)
      const token = fs.readFileSync(path.join(profile, 'admin-mcp-token'), 'utf8').trim()
      assert.ok(!tabsText.includes(token))
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
  await t.test('desktop password invalidates browser sessions without changing managed policy', async () => {
    const origin = `http://127.0.0.1:${gateway.address().port}`
    const token = await page.evaluate(() => window.store.config.tokenElecterm)
    const before = await nativePage.evaluate(() => window.pre.runGlobalAsync('getManagedConnectivity'))
    await nativePage.evaluate(() => window.pre.runGlobalAsync('setPassword', 'managed-desktop-fixture-password'))
    const deadline = Date.now() + 5000
    let status
    do {
      status = await responseStatus(origin + '/api/get-constants', { headers: { token } })
      if (status !== 401) await new Promise(resolve => setTimeout(resolve, 50))
    } while (status !== 401 && Date.now() < deadline)
    assert.equal(status, 401)
    const loginPage = await browser.newPage()
    await loginPage.goto(origin)
    await loginPage.locator('input[type="password"]').waitFor()
    const login = password => fetch(origin + '/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password })
    })
    const wrong = await login('wrong-password')
    await wrong.arrayBuffer()
    assert.equal(wrong.status, 401)
    const valid = await login('managed-desktop-fixture-password')
    assert.equal(valid.status, 200)
    const fresh = await valid.json()
    assert.match(fresh, /^[0-9a-f]{64}$/)
    assert.notEqual(fresh, token)
    assert.equal(await responseStatus(origin + '/api/get-constants', { headers: { token: fresh } }), 200)
    await loginPage.locator('input[type="password"]').fill('managed-desktop-fixture-password')
    await loginPage.locator('input[type="password"]').press('Enter')
    await loginPage.waitForFunction(() => window.store?.configLoaded)
    assert.deepEqual(await nativePage.evaluate(() => window.pre.runGlobalAsync('getManagedConnectivity')), before)
    await loginPage.close()
  })
  assert.deepEqual(await nativePage.evaluate(() => window.store.tabs.map(tab => tab.id)), nativeSessions)
  await nativePage.locator('.session-current .xterm-helper-textarea').first().focus()
  await nativePage.keyboard.insertText('Write-Output ("ANUBIS_NATIVE_" + "STILL_RUNNING")')
  await nativePage.keyboard.press('Enter')
  await nativePage.waitForFunction(() => document.body.innerText.includes('ANUBIS_NATIVE_STILL_RUNNING'))
  assert.deepEqual(errors, [])
})
