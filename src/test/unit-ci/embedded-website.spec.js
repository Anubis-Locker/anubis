const { test } = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { setupEmbeddedWebsites, isWebsiteUrl } = require('../../app/lib/embedded-website')

function fixture (t) {
  const handlers = new Map()
  const app = new EventEmitter()
  const messages = []
  const contents = Object.assign(new EventEmitter(), {
    mainFrame: {},
    session: {},
    isDestroyed: () => false,
    send: (channel, value) => messages.push({ channel, value })
  })
  const sessions = new Map()
  const dispose = setupEmbeddedWebsites({
    contents,
    app,
    ipcMain: {
      handle: (name, fn) => handlers.set(name, fn),
      removeHandler: name => handlers.delete(name)
    },
    session: {
      fromPartition (partition) {
        const value = {
          setPermissionRequestHandler (fn) { this.permission = fn },
          setPermissionCheckHandler (fn) { this.check = fn },
          webRequest: { onBeforeSendHeaders (fn) { this.headers = fn } }
        }
        sessions.set(partition, value)
        return value
      }
    }
  })
  t.after(dispose)
  const event = { sender: contents, senderFrame: contents.mainFrame }
  const invoke = (name, value, sender = event) => handlers.get('anubis-website-' + name)(sender, value)
  return { handlers, app, contents, messages, sessions, dispose, event, invoke }
}

test('website capability accepts HTTP(S) only and rejects foreign senders and subframes', t => {
  const f = fixture(t)
  for (const url of ['https://google.com', 'http://127.0.0.1:8000/']) assert.ok(isWebsiteUrl(url))
  for (const url of ['file:///C:/secret', 'javascript:alert(1)', 'data:text/html,hi', 'https://', 'not a URL']) {
    assert.equal(isWebsiteUrl(url), false)
  }
  assert.throws(() => f.invoke('allocate', undefined, { sender: {} }), /Untrusted/)
  assert.throws(() => f.invoke('allocate', undefined, { sender: f.contents, senderFrame: {} }), /Untrusted/)
})

test('unissued partitions are refused and renderer-controlled webpreferences cannot relax guest isolation', t => {
  const f = fixture(t)
  let prevented = false
  const event = { preventDefault () { prevented = true } }
  f.contents.emit('will-attach-webview', event, {}, { partition: 'persist:privileged', src: 'https://example.org' })
  assert.equal(prevented, true)
  prevented = false
  const partition = f.invoke('allocate')
  assert.ok(!partition.startsWith('persist:'))
  const preferences = {
    preload: 'C:\\privileged-preload.js',
    preloadURL: 'file:///C:/privileged-preload.js',
    nodeIntegration: true,
    nodeIntegrationInSubFrames: true,
    nodeIntegrationInWorker: true,
    webSecurity: false,
    sandbox: false,
    contextIsolation: false,
    webviewTag: true,
    additionalArguments: ['--anubis-machine-host']
  }
  f.contents.emit('will-attach-webview', event, preferences, { partition, src: 'https://example.org' })
  assert.equal(prevented, false)
  assert.equal(preferences.preload, undefined)
  assert.equal(preferences.preloadURL, undefined)
  for (const key of ['nodeIntegration', 'nodeIntegrationInSubFrames', 'nodeIntegrationInWorker', 'webviewTag']) {
    assert.equal(preferences[key], false)
  }
  for (const key of ['sandbox', 'contextIsolation', 'webSecurity']) assert.equal(preferences[key], true)
  assert.deepEqual(preferences.additionalArguments, [])
  assert.equal(preferences.session, f.sessions.get(partition))
  const requestHeaders = { 'X-Anubis-Managed-Transport': 'private', Authorization: 'Basic website-only' }
  f.sessions.get(partition).webRequest.headers({ requestHeaders }, ({ requestHeaders }) => {
    assert.deepEqual(requestHeaders, { Authorization: 'Basic website-only' })
  })
  f.contents.emit('will-attach-webview', event, {}, { partition, src: 'https://example.org' })
  assert.equal(prevented, true)
})

test('authentication is scoped to attached website guests, cancels on disposal, and cannot use machine-role IPC', async t => {
  const f = fixture(t)
  const partition = f.invoke('allocate')
  const guest = Object.assign(new EventEmitter(), {
    session: f.sessions.get(partition),
    isDestroyed: () => false,
    setWindowOpenHandler (fn) { this.popup = fn },
    close () { this.emit('destroyed') }
  })
  f.contents.emit('did-attach-webview', {}, guest)
  guest.loadURL = async () => { throw Object.assign(new Error('Superseded navigation'), { code: 'ERR_ABORTED' }) }
  assert.deepEqual(guest.popup({ url: 'https://example.org' }), { action: 'deny' })
  await Promise.resolve()
  assert.equal(f.messages.length, 0)
  guest.loadURL = async () => { throw Object.assign(new Error('Load failed'), { code: 'ERR_CONNECTION_REFUSED' }) }
  guest.popup({ url: 'https://example.org' })
  await Promise.resolve()
  assert.deepEqual(f.messages.at(-1), {
    channel: 'anubis-website-error',
    value: { partition, code: 'ERR_CONNECTION_REFUSED' }
  })
  let prevented = false
  let answer
  f.app.emit('login', { preventDefault () { prevented = true } }, {}, {}, {}, () => assert.fail('Foreign login intercepted'))
  assert.equal(prevented, false)
  f.app.emit('login', { preventDefault () { prevented = true } }, guest, {}, { host: 'example.org' },
    (...args) => { answer = args })
  assert.equal(prevented, true)
  const request = f.messages.at(-1).value
  assert.equal(request.partition, partition)
  assert.throws(() => f.invoke('auth', { id: request.id, username: 'u', password: 'p' },
    { sender: guest, senderFrame: {} }), /Untrusted/)
  f.invoke('auth', { id: request.id, username: 'u', password: 'p' })
  assert.deepEqual(answer, ['u', 'p'])
  assert.throws(() => f.invoke('auth', { id: request.id, username: 'u', password: 'p' }), /expired/)
  f.app.emit('login', { preventDefault () {} }, guest, {}, { host: 'example.org' }, (...args) => { answer = args })
  f.dispose()
  assert.deepEqual(answer, [])
  assert.equal(f.handlers.size, 0)
  assert.equal(f.app.listenerCount('login'), 0)
})
