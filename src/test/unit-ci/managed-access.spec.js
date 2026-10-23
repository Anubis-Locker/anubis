const { test } = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const { EventEmitter } = require('node:events')
const { createManagedRuntime, createTransportSecret } = require('../../app/lib/managed-access')
const { startDesktopManaged } = require('../../app/lib/managed-startup')
const { createRpcChannel } = require('../../app/server/managed-rpc')

test('managed runtime pins a loopback endpoint and never forwards native credentials', async t => {
  const server = http.createServer((req, res) => res.end('ok'))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  let options
  const agent = { start () {}, stop () {} }
  const header = createTransportSecret()
  assert.match(header, /^[0-9a-f]{64}$/)
  assert.notEqual(header, createTransportSecret())
  const input = {
    createAgent: value => { options = value; return agent },
    userData: 'isolated-profile',
    port: server.address().port,
    header,
    version: '5.6.11',
    onStatus () {},
    env: { ANUBIS_ADMIN_MCP_TOKEN: 'never-forward-this' }
  }
  assert.equal(createManagedRuntime(input), agent)
  assert.equal(options.baseUrl, 'https://api.anubis.locker')
  assert.equal(options.localHost, '127.0.0.1')
  assert.equal(await options.probe(), true)
  assert.deepEqual(options.localHeaders, { 'x-anubis-managed-transport': header })
  assert.ok(!JSON.stringify(options).includes('never-forward-this'))
  for (const url of ['http://example.com', 'https://user:secret@example.com', 'https://example.com/?token=secret']) {
    assert.throws(() => createManagedRuntime({ ...input, env: { ANUBIS_ADMIN_MANAGED_URL: url } }))
  }
})

test('managed lifecycle starts once, stops on backend exit and awaits shutdown before quit', async () => {
  const app = new EventEmitter()
  app.getPath = () => 'isolated-profile'
  app.getVersion = () => '5.6.11'
  let quits = 0
  app.quit = () => { quits++ }
  const child = new EventEmitter()
  const state = new Map()
  let starts = 0
  let stops = 0
  let finish
  const stopPending = new Promise(resolve => { finish = resolve })
  const runtime = startDesktopManaged({
    app,
    child,
    port: 45678,
    header: createTransportSecret(),
    globalState: state,
    env: {},
    log: { info () {}, warn () {}, error () {} },
    createAgent: ({ onStatus }) => ({
      start () {
        starts++
        onStatus({ status: 'pending', fingerprint: 'fingerprint', secret: 'not-visible' })
      },
      stop () { stops++; return stopPending }
    })
  })
  assert.equal(starts, 1)
  assert.equal(state.get('managedConnectivity').status, 'pending')
  assert.equal(state.get('managedConnectivity').secret, undefined)
  child.emit('exit')
  let prevented = 0
  app.emit('before-quit', { preventDefault: () => { prevented++ } })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(stops, 1)
  assert.equal(quits, 0)
  assert.equal(prevented, 1)
  finish()
  await runtime.stop()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(quits, 1)
  app.emit('before-quit', { preventDefault: () => { prevented++ } })
  assert.equal(prevented, 1)
})

test('administrator can disable connectivity without creating credentials or an agent', async () => {
  const state = new Map()
  const runtime = startDesktopManaged({
    globalState: state,
    log: { info () {} },
    env: { ANUBIS_ADMIN_MANAGED_ENABLED: '0' },
    createAgent: () => assert.fail('disabled managed access must not enroll')
  })
  assert.equal(state.get('managedConnectivity').status, 'disabled')
  await runtime.stop()
})

test('child RPC correlates replies, rejects backend loss and times out without leaking listeners', async () => {
  const channel = new EventEmitter()
  let request
  channel.send = value => { request = value }
  const rpc = createRpcChannel(channel, 25)
  const pending = rpc.call('init', [])
  channel.emit('message', { type: 'managed-rpc-result', id: request.id, data: { config: {} } })
  assert.deepEqual(await pending, { config: {} })
  await assert.rejects(rpc.call('slow'), /timed out/)
  const disconnect = rpc.call('lost')
  channel.emit('disconnect')
  await assert.rejects(disconnect, /disconnected/)
  assert.equal(channel.listenerCount('message'), 0)
})
