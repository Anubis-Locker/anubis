process.env.NODE_ENV = 'development'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const net = require('node:net')
const { once, EventEmitter } = require('node:events')
const vnc = require('../../app/server/session-vnc')

test('VNC connection test closes its successful TCP probe', { timeout: 5000 }, async t => {
  let closed
  const server = net.createServer(socket => { closed = once(socket, 'close') })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const result = await vnc.test({ host: '127.0.0.1', port: server.address().port })
  assert.equal(result, true)
  await closed
})

test('VNC connection refusal returns false without an uncaught socket error', { timeout: 5000 }, async () => {
  const server = net.createServer()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  assert.equal(await vnc.test({ host: '127.0.0.1', port }), false)
})

test('VNC probes enforce readyTimeout and destroy a timed-out socket', async t => {
  const socket = new EventEmitter()
  let destroyed = false
  socket.destroy = () => { destroyed = true }
  socket.end = () => {}
  socket.setTimeout = (timeout, callback) => {
    assert.equal(timeout, 25)
    queueMicrotask(callback)
  }
  t.mock.method(net, 'createConnection', () => socket)
  assert.equal(await vnc.test({ host: '127.0.0.1', port: 5900, readyTimeout: 25 }), false)
  assert.equal(destroyed, true)
})
