const { test } = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { once } = require('node:events')
const express = require('express')
const WebSocket = require('ws')
const { initManagedBrowser, HEADER } = require('../../app/server/managed-browser')
const { createManagedContexts, nativeContextBridge, CONTEXT_HEADER, SESSION_HEADER, CONTEXT_ROUTE, CONTEXT_SCRIPT } = require('../../app/server/managed-contexts')

async function fixture (t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'anubis-context-routing-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, 'js'))
  fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({ version: 'test' }))
  fs.writeFileSync(path.join(root, 'js', 'basic-test.js'), 'window.privateWorkspaceAsset=true')
  const secret = 'system-private-transport'
  const workerProof = 'b'.repeat(64)
  const system = {
    contextId: '1'.repeat(32),
    identity: { sid: 'S-1-5-18', account: 'NT AUTHORITY\\SYSTEM', elevated: true, sessionId: 0, pid: 100 },
    endpoint: { localPort: 0, privateProof: 'a'.repeat(64) }
  }
  const worker = {
    contextId: '2'.repeat(32),
    identity: { sid: 'S-1-5-21-1-2-3-1001', account: 'MACHINE\\Root', elevated: false, sessionId: 2, pid: 101 },
    endpoint: { localPort: 0, privateProof: workerProof }
  }
  const state = { authorized: true, logonSid: 'S-1-5-5-10-20', calls: [], unsupported: false }
  const bridge = {
    async call (request) {
      state.calls.push(request)
      if (state.unsupported) throw new Error('unsupported broker operation')
      if (request.operation === 'list-contexts') {
        return {
          machine: { contextId: system.contextId, identity: system.identity },
          sessions: state.authorized
            ? [{ id: 2, sid: worker.identity.sid, account: worker.identity.account, state: 0, logonSid: state.logonSid }]
            : []
        }
      }
      if (request.target === 'user' &&
          (!state.authorized || request.sessionId !== 2 || request.accountSid !== worker.identity.sid || request.logonSid !== state.logonSid)) {
        throw new Error('native token/policy changed')
      }
      const descriptor = request.target === 'system' ? system : worker
      if (request.operation === 'resolve-context' && request.contextId !== descriptor.contextId) throw new Error('worker replaced')
      if (request.operation === 'resolve-context' && request.target === 'user' && state.deferUserResolve) {
        await state.deferUserResolve()
      }
      return structuredClone(descriptor)
    }
  }
  const router = createManagedContexts({ secret, bridge, pollInterval: 20, log: { warn () {} } })
  t.after(() => router.close())
  async function backend (target, transport, routeContexts) {
    const app = express()
    app.use(express.json())
    require('express-ws')(app)
    if (routeContexts) app.use(router.middleware)
    const rpc = async (func, args) => {
      if (func === 'browserInfo') return { brand: { name: target }, requirePassword: target === 'Root', config: { workspace: target } }
      if (func === 'browserLogin') return args[0] === `${target}-password`
      return target
    }
    const browser = initManagedBrowser(app, {
      secret: transport,
      rpc,
      assetsPath: root,
      nativeToken: `${target}-native-token`,
      getSessionPort: () => undefined,
      log: { debug () {}, warn () {} }
    })
    app.ws('/common/s', (ws, req) => {
      if (!req.managedSession) return ws.close(1008)
      ws.on('message', (data, binary) => {
        binary = typeof binary === 'boolean' ? binary : typeof data !== 'string'
        ws.send(data, { binary })
      })
    })
    app.get('/', (req, res) => res.send(`${target}-native-desktop`))
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
    return server.address().port
  }
  worker.endpoint.localPort = await backend('Root', workerProof, false)
  system.endpoint.localPort = await backend('SYSTEM', secret, true)
  const origin = `http://127.0.0.1:${system.endpoint.localPort}`
  const headersFor = session => ({ [HEADER]: secret, [SESSION_HEADER]: session })
  const session = () => crypto.randomBytes(32).toString('hex')
  const list = async binding => {
    const response = await fetch(origin + CONTEXT_ROUTE, { headers: headersFor(binding) })
    assert.equal(response.status, 200)
    return response.json()
  }
  const select = async (binding, target) => {
    const { contexts } = await list(binding)
    const choice = contexts.find(choice => choice.target === target)
    const response = await fetch(origin + CONTEXT_ROUTE, {
      method: 'POST',
      headers: { ...headersFor(binding), 'content-type': 'application/json' },
      body: JSON.stringify({ id: choice.id })
    })
    assert.equal(response.status, 200)
    const selected = await response.json()
    return { ...selected, headers: { ...headersFor(binding), [CONTEXT_HEADER]: selected.selector } }
  }
  const login = async selected => {
    const response = await fetch(origin + '/api/login', {
      method: 'POST',
      headers: { ...selected.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'Root-password' })
    })
    assert.equal(response.status, 200)
    return response.json()
  }
  return { origin, headersFor, session, list, select, login, state, worker, system, secret, workerProof }
}

test('context catalog/selection is sanitized, authorized and bound to each gateway browser session', async t => {
  const f = await fixture(t)
  const first = f.session()
  assert.equal((await fetch(f.origin + CONTEXT_ROUTE)).status, 403)
  const catalog = await f.list(first)
  assert.equal(catalog.supported, true)
  assert.equal(catalog.contexts.length, 2)
  for (const context of catalog.contexts) {
    assert.match(context.id, /^[a-f0-9]{32}$/)
    assert.deepEqual(Object.keys(context).sort(), ['id', 'identity', 'target'])
    assert.deepEqual(Object.keys(context.identity).sort(), ['account', 'sessionId', 'sid'])
  }
  const selected = await f.select(first, 'user')
  assert.equal(selected.context.identity.sid, f.worker.identity.sid)
  assert.match(selected.selector, /^[a-f0-9]{32}$/)
  const serialized = JSON.stringify({ catalog, selected })
  assert.ok(!serialized.includes('privateProof'))
  assert.ok(!serialized.includes('localPort'))
  assert.ok(!serialized.includes(f.workerProof))
  assert.equal((await fetch(f.origin + '/', {
    headers: { ...selected.headers, [SESSION_HEADER]: f.session() }
  })).status, 403)
  assert.equal((await fetch(f.origin + '/', { headers: { ...selected.headers, [CONTEXT_HEADER]: '' } })).status, 503)
  assert.equal((await fetch(f.origin + '/', { headers: { [HEADER]: f.secret, [CONTEXT_HEADER]: selected.selector } })).status, 403)
  f.state.authorized = false
  assert.deepEqual((await f.list(first)).contexts.map(item => item.target), ['system'])
})

test('selected user keeps its own desktop password/token and HTML chooser without exposing endpoint proof', async t => {
  const f = await fixture(t)
  const binding = f.session()
  const normal = await (await fetch(f.origin + '/', { headers: { [HEADER]: f.secret } })).text()
  assert.ok(!normal.includes(CONTEXT_SCRIPT))
  const systemHtml = await (await fetch(f.origin + '/', { headers: f.headersFor(binding) })).text()
  assert.ok(systemHtml.includes(CONTEXT_SCRIPT))
  const systemToken = /tokenElecterm',"([a-f0-9]+)"/.exec(systemHtml)[1]
  const selected = await f.select(binding, 'user')
  const html = await (await fetch(f.origin + '/', { headers: selected.headers })).text()
  assert.ok(html.includes(CONTEXT_SCRIPT))
  assert.ok(html.includes('"name":"Root"'))
  assert.ok(!html.includes("localStorage.setItem('tokenElecterm'"))
  assert.ok(!html.includes(f.workerProof))
  assert.equal((await fetch(f.origin + '/api/get-constants', { headers: { ...selected.headers, token: systemToken } })).status, 401)
  const token = await f.login(selected)
  const response = await fetch(f.origin + '/api/get-constants', { headers: { ...selected.headers, token } })
  assert.equal(response.status, 200)
  assert.equal((await response.json()).config.workspace, 'Root')
  const asset = await fetch(f.origin + '/js/basic-test.js', { headers: selected.headers })
  assert.equal(asset.status, 200)
  assert.ok((await asset.text()).includes('privateWorkspaceAsset'))
  assert.equal((await fetch(f.origin + '/api/get-constants', { headers: { ...f.headersFor(f.session()), token } })).status, 401)
})

test('selected WS buffers early text/binary and context switching closes only its browser binding', async t => {
  const f = await fixture(t)
  const bindingA = f.session()
  const first = await f.select(bindingA, 'user')
  const second = await f.select(f.session(), 'user')
  const tokenA = await f.login(first)
  const tokenB = await f.login(second)
  const connect = async (selection, token) => {
    const ws = new WebSocket(f.origin.replace('http:', 'ws:') + '/common/s?token=' + token, { headers: selection.headers })
    t.after(() => ws.terminate())
    await once(ws, 'open')
    const reply = once(ws, 'message', { signal: AbortSignal.timeout(2000) })
    ws.send('early browser message')
    assert.equal(String((await reply)[0]), 'early browser message')
    return ws
  }
  const a = await connect(first, tokenA)
  const b = await connect(second, tokenB)
  const reply = once(b, 'message', { signal: AbortSignal.timeout(2000) })
  const bytes = Buffer.from([0, 255, 128])
  b.send(bytes)
  assert.deepEqual(Buffer.from((await reply)[0]), bytes)
  const closedA = once(a, 'close', { signal: AbortSignal.timeout(2000) })
  await f.select(bindingA, 'system')
  await closedA
  assert.equal(b.readyState, WebSocket.OPEN)
  const stillWorking = once(b, 'message', { signal: AbortSignal.timeout(2000) })
  b.send('other browser unchanged')
  assert.equal(String((await stillWorking)[0]), 'other browser unchanged')
})

test('policy removal, logout/logon reuse and worker replacement fail closed without relaunch or SYSTEM fallback', async t => {
  const f = await fixture(t)
  for (const change of [
    () => { f.state.authorized = false },
    () => { f.state.logonSid = 'S-1-5-5-10-21' },
    () => { f.worker.contextId = '3'.repeat(32) }
  ]) {
    f.state.authorized = true
    f.state.logonSid = 'S-1-5-5-10-20'
    f.worker.contextId = '2'.repeat(32)
    const selected = await f.select(f.session(), 'user')
    const count = f.state.calls.filter(call => call.operation === 'launch-context').length
    change()
    const response = await fetch(f.origin + '/', { headers: selected.headers })
    assert.equal(response.status, 503)
    assert.ok(!(await response.text()).includes('"name":"SYSTEM"'))
    assert.equal(f.state.calls.filter(call => call.operation === 'launch-context').length, count)
  }
})

test('existing user WS is revoked on native policy/logon change and unsupported old host never claims context support', async t => {
  const f = await fixture(t)
  const selected = await f.select(f.session(), 'user')
  const token = await f.login(selected)
  const ws = new WebSocket(f.origin.replace('http:', 'ws:') + '/common/s?token=' + token, { headers: selected.headers })
  t.after(() => ws.terminate())
  await once(ws, 'open')
  const reply = once(ws, 'message', { signal: AbortSignal.timeout(2000) })
  ws.send('ready')
  await reply
  const closed = once(ws, 'close')
  f.state.authorized = false
  await closed
  f.state.unsupported = true
  assert.equal((await fetch(f.origin + CONTEXT_ROUTE, { headers: f.headersFor(f.session()) })).status, 503)
  const native = await (await fetch(f.origin)).text()
  assert.equal(native, 'SYSTEM-native-desktop')
})

test('an older in-flight validation cannot revoke a newer selection in the same browser', async t => {
  const f = await fixture(t)
  const binding = f.session()
  const old = await f.select(binding, 'user')
  let release
  let pending
  const started = new Promise(resolve => { pending = resolve })
  const delayed = new Promise(resolve => { release = resolve })
  f.state.deferUserResolve = () => { pending(); return delayed }
  const oldRequest = fetch(f.origin + '/', { headers: old.headers })
  await started
  const current = await f.select(binding, 'system')
  release()
  assert.equal((await oldRequest).status, 503)
  const response = await fetch(f.origin + '/', { headers: current.headers })
  assert.equal(response.status, 200)
  assert.ok((await response.text()).includes('"name":"SYSTEM"'))
})

test('native bridge bounds concurrent helper processes without skipping per-request validation', async () => {
  const releases = []
  let active = 0
  let maximum = 0
  const bridge = nativeContextBridge('AnubisHost', 'trusted-test-helper.exe', async (helper, service, request) => {
    assert.equal(helper, 'trusted-test-helper.exe')
    assert.equal(service, 'AnubisHost')
    assert.equal(request.version, 1)
    active++
    maximum = Math.max(maximum, active)
    await new Promise(resolve => releases.push(resolve))
    active--
    return request.operation
  })
  const pending = Array.from({ length: 12 }, () => bridge.call({ operation: 'list-contexts' }))
  assert.equal(active, 4)
  for (let batch = 0; batch < 3; batch++) {
    const release = releases.splice(0)
    assert.equal(release.length, 4)
    for (const resolve of release) resolve()
    await new Promise(resolve => setImmediate(resolve))
  }
  assert.equal((await Promise.all(pending)).length, 12)
  assert.equal(maximum, 4)
  assert.equal(active, 0)
})
