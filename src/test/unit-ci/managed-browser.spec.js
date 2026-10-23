const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { once } = require('node:events')
const express = require('express')
const WebSocket = require('ws')
const { initManagedBrowser, HEADER } = require('../../app/server/managed-browser')
const { createBrowserRpc } = require('../../app/lib/managed-browser-rpc')

async function fixture (t, { requirePassword = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'anubis-managed-browser-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, 'js'))
  fs.writeFileSync(path.join(root, 'js', 'basic-5.6.11.js'), 'window.browserCompanionLoaded = true')
  const app = express()
  app.use(express.json())
  require('express-ws')(app)
  const upstreamApp = express()
  require('express-ws')(upstreamApp)
  const tokens = []
  for (const type of ['terminals', 'sftp', 'transfer']) {
    upstreamApp.ws(`/${type}/:id`, (ws, req) => {
      tokens.push(req.query.token)
      ws.on('message', data => ws.send(data))
    })
  }
  const upstream = upstreamApp.listen(0, '127.0.0.1')
  await once(upstream, 'listening')
  const upstreamSockets = new Set()
  upstream.on('connection', socket => {
    upstreamSockets.add(socket)
    socket.once('close', () => upstreamSockets.delete(socket))
  })
  t.after(() => {
    for (const socket of upstreamSockets) socket.destroy()
    return new Promise(resolve => upstream.close(resolve))
  })
  const port = upstream.address().port
  const rpc = async (func, args) => {
    if (func === 'browserInfo') {
      return {
        packInfo: { version: '5.6.11' },
        brand: { name: 'Anubis' },
        requirePassword,
        config: { theme: 'dark' }
      }
    }
    if (func === 'browserLogin') return args[0] === 'desktop-password'
    return createBrowserRpc({
      functions: {},
      getConfig: () => ({}),
      getPassword: async () => ({}),
      constants: () => ({}),
      init: async () => ({ config: {} })
    })(func, args)
  }
  const browser = initManagedBrowser(app, {
    secret: 'private-launch-secret',
    log: { debug () {}, warn () {} },
    assetsPath: root,
    nativeToken: 'native-terminal-token',
    rpc,
    getSessionPort: id => id === 'terminal-1' ? port : undefined
  })
  app.ws('/common/s', (ws, req) => {
    if (!req.managedSession) return ws.close(1008)
    ws.on('message', async message => {
      const request = JSON.parse(message)
      try {
        ws.send(JSON.stringify({ id: request.id, data: await req.managedRpc(request.func, request.args) }))
      } catch (error) {
        ws.send(JSON.stringify({ id: request.id, error: { message: error.message } }))
      }
    })
  })
  app.get('/', (req, res) => res.send('native desktop renderer'))
  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const sockets = new Set()
  server.on('connection', socket => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  t.after(async () => {
    browser.close()
    for (const socket of sockets) socket.destroy()
    await new Promise(resolve => server.close(resolve))
  })
  const origin = `http://127.0.0.1:${server.address().port}`
  const headers = { [HEADER]: 'private-launch-secret' }
  const response = await fetch(origin, { headers })
  const html = await response.text()
  const match = /localStorage\.setItem\('tokenElecterm',"([0-9a-f]+)"\)/.exec(html)
  return { origin, root, headers, html, token: match?.[1], tokens }
}

test('real HTTP serves native renderer unchanged and managed renderer only over private transport', async t => {
  const f = await fixture(t)
  assert.equal(await (await fetch(f.origin)).text(), 'native desktop renderer')
  assert.equal((await fetch(f.origin, { headers: { [HEADER]: 'forged' } })).status, 403)
  assert.match(f.html, /Managed connectivity/)
  assert.ok(!f.html.includes('native-terminal-token'))
  assert.ok(!f.html.includes('private-launch-secret'))
  assert.match(f.token, /^[0-9a-f]{64}$/)
  const asset = await fetch(f.origin + '/js/basic-5.6.11.js', { headers: f.headers })
  assert.equal(asset.status, 200)
  assert.equal(asset.headers.get('cache-control'), 'no-store')
  assert.equal(asset.headers.get('connection'), 'close')
  assert.match(await asset.text(), /browserCompanionLoaded/)
  const constants = await fetch(f.origin + '/api/get-constants', { headers: { ...f.headers, token: f.token } })
  assert.equal(constants.status, 200)
  assert.equal((await constants.json()).config.tokenElecterm, f.token)
  for (const endpoint of ['/auth', '/mcp', '/upgrade/install', '/run']) {
    const response = await fetch(f.origin + endpoint, { headers: { ...f.headers, token: f.token } })
    assert.equal(response.status, 403)
  }
})

test('desktop password remains required after transport authentication', async t => {
  const f = await fixture(t, { requirePassword: true })
  assert.equal(f.token, undefined)
  assert.equal((await fetch(f.origin + '/api/get-constants', { headers: f.headers })).status, 401)
  const login = password => fetch(f.origin + '/api/login', {
    method: 'POST',
    headers: { ...f.headers, 'content-type': 'application/json' },
    body: JSON.stringify({ password })
  })
  assert.equal((await login('wrong')).status, 401)
  const response = await login('desktop-password')
  assert.equal(response.status, 200)
  const token = await response.json()
  assert.match(token, /^[0-9a-f]{64}$/)
  assert.equal((await fetch(f.origin + '/api/get-constants', { headers: { ...f.headers, token } })).status, 200)
})

test('real browser WebSockets proxy text and binary using private native credentials', async t => {
  const f = await fixture(t)
  for (const [route, query] of [
    ['/terminals/terminal-1', ''],
    ['/sftp/sftp-1', '&sftpId=terminal-1'],
    ['/transfer/transfer-1', '&sftpId=sftp-1']
  ]) {
    const socket = new WebSocket(f.origin.replace('http:', 'ws:') + route + '?token=' + f.token + query, { headers: f.headers })
    await once(socket, 'open')
    const text = once(socket, 'message')
    socket.send('browser-terminal-text')
    assert.equal(String((await text)[0]), 'browser-terminal-text')
    const bytes = Buffer.from([0, 255, 16, 128])
    const binary = once(socket, 'message')
    socket.send(bytes)
    assert.deepEqual(Buffer.from((await binary)[0]), bytes)
    if (route.startsWith('/sftp/')) {
      t.after(() => socket.terminate())
    } else {
      const closed = once(socket, 'close')
      socket.close()
      await closed
    }
  }
  assert.deepEqual(f.tokens, ['native-terminal-token', 'native-terminal-token', 'native-terminal-token'])
})

test('browser RPC rejects native process control over an authenticated real WebSocket', async t => {
  const f = await fixture(t)
  const socket = new WebSocket(f.origin.replace('http:', 'ws:') + '/common/s?token=' + f.token, { headers: f.headers })
  await once(socket, 'open')
  const result = once(socket, 'message')
  socket.send(JSON.stringify({ id: 'rpc-1', func: 'restart', args: [] }))
  assert.match(JSON.parse(String((await result)[0])).error.message, /Unsupported/)
  const closed = once(socket, 'close')
  socket.close()
  await closed
})

test('browser file download and upload require authentication and preserve exact bytes', async t => {
  const f = await fixture(t)
  const source = path.join(f.root, 'download.bin')
  const content = Buffer.from([0, 1, 255, 128])
  fs.writeFileSync(source, content)
  assert.equal((await fetch(f.origin + '/api/download?path=' + encodeURIComponent(source), { headers: f.headers })).status, 401)
  const response = await fetch(f.origin + '/api/download?path=' + encodeURIComponent(source), {
    headers: { ...f.headers, token: f.token }
  })
  assert.equal(response.status, 200)
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), content)
  const form = new FormData()
  form.set('path', f.root)
  form.set('file', new Blob([content]), 'uploaded.bin')
  const upload = await fetch(f.origin + '/api/upload', {
    method: 'POST',
    headers: { ...f.headers, token: f.token },
    body: form
  })
  assert.equal(upload.status, 200)
  assert.deepEqual(fs.readFileSync(path.join(f.root, 'uploaded.bin')), content)
})
