const { test } = require('node:test')
const assert = require('node:assert/strict')
const net = require('node:net')
const crypto = require('node:crypto')
const os = require('node:os')
const path = require('node:path')
const { once } = require('node:events')
const { performance } = require('node:perf_hooks')
const { createRuntimeControl } = require('../../app/lib/machine-runtime-control')

const contextId = 'a'.repeat(32)
const admissionId = 'b'.repeat(64)
const packet = { version: 1, operation: 'native-password-update', contextId, admissionId }
const success = value => ({
  version: 1,
  ok: true,
  result: { pid: process.pid, contextId, admissionId: value.admissionId, committed: true }
})

async function fixture (t, nativePasswordHandler) {
  const id = crypto.randomBytes(16).toString('hex')
  const pipe = process.platform === 'win32'
    ? '\\\\.\\pipe\\anubis-password-fixture-' + id
    : path.join(os.tmpdir(), 'anubis-password-' + id + '.sock')
  const errors = []
  const control = createRuntimeControl({
    pipe,
    contextId,
    getEndpoint: () => ({ localPort: 12345, privateProof: 'c'.repeat(64) }),
    nativePasswordHandler,
    onError: error => errors.push(error.message)
  })
  await control.start()
  t.after(() => control.close())
  return {
    errors,
    async connect () {
      const socket = net.createConnection(pipe)
      socket.on('error', () => {})
      await once(socket, 'connect')
      t.after(() => socket.destroy())
      const response = new Promise((resolve, reject) => {
        let raw = ''
        let answered = false
        socket.on('data', bytes => {
          raw += bytes.toString()
          if (!raw.includes('\n') || answered) return
          answered = true
          try { resolve(JSON.parse(raw)) } catch (error) { reject(error) }
        })
        socket.once('close', () => { if (!answered) resolve(null) })
      })
      return { socket, response }
    }
  }
}

test('actual local pipe keeps native updater unreachable without configured admission handler', async t => {
  const f = await fixture(t)
  const client = await f.connect()
  client.socket.write(JSON.stringify(packet) + '\n')
  assert.deepEqual(await client.response, {
    version: 1, ok: false, error: { code: 'ERR_INVALID_REQUEST' }
  })
})

test('actual local describe protocol remains unchanged', async t => {
  const f = await fixture(t)
  const client = await f.connect()
  client.socket.write(JSON.stringify({ version: 1, operation: 'describe' }) + '\n')
  assert.deepEqual(await client.response, {
    version: 1,
    ok: true,
    result: { pid: process.pid, contextId, endpoint: { localPort: 12345, privateProof: 'c'.repeat(64) } }
  })
})

// The handler fixtures exercise dispatch only, never Windows admission or data.
test('actual pipe marks one invocation pending before await and ignores later replacement packets', async t => {
  let calls = 0
  let entered
  const called = new Promise(resolve => { entered = resolve })
  let release
  const blocked = new Promise(resolve => { release = resolve })
  const f = await fixture(t, async value => {
    calls++
    entered()
    await blocked
    return success(value)
  })
  const client = await f.connect()
  client.socket.write(JSON.stringify(packet) + '\n')
  await called
  client.socket.write(JSON.stringify({ ...packet, admissionId: 'd'.repeat(64) }) + '\n')
  release()
  assert.deepEqual(await client.response, success(packet))
  assert.equal(calls, 1)
})

test('credential/caller fields or trailing JSON cannot reach the configured handler', async t => {
  let calls = 0
  const f = await fixture(t, value => { calls++; return success(value) })
  for (const frame of [
    JSON.stringify({ ...packet, oldPassword: 'forged-secret' }) + '\n',
    JSON.stringify({ ...packet, caller: { sid: 'S-1-5-18' } }) + '\n',
    JSON.stringify(packet) + '\n' + JSON.stringify(packet) + '\n'
  ]) {
    const client = await f.connect()
    client.socket.write(frame)
    assert.equal((await client.response).error.code, 'ERR_INVALID_REQUEST')
  }
  assert.equal(calls, 0)
})

test('malformed handler outcome closes only its socket without forwarding arbitrary data', async t => {
  const f = await fixture(t, () => ({ version: 1, ok: true, result: { ...success(packet).result, privateDetail: 'not-forwarded' } }))
  const client = await f.connect()
  client.socket.write(JSON.stringify(packet) + '\n')
  assert.equal(await client.response, null)
  assert.deepEqual(f.errors, ['Native password operation outcome is unknown'])
})

test('new operation has absolute ten-second bound despite input activity and never uses describe five-second timeout', async t => {
  const f = await fixture(t, () => new Promise(() => {}))
  const client = await f.connect()
  const started = performance.now()
  client.socket.write(JSON.stringify(packet) + '\n')
  const activity = setInterval(() => {
    if (!client.socket.destroyed) client.socket.write(' ')
  }, 50)
  t.after(() => clearInterval(activity))
  assert.equal(await client.response, null)
  clearInterval(activity)
  const elapsed = performance.now() - started
  assert.ok(elapsed >= 9500, 'must not fall back to describe timeout')
  assert.ok(elapsed < 11500, 'input activity must not extend the ten-second deadline')
})
