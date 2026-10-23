const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { fork } = require('node:child_process')
const { once } = require('node:events')
const { awaitManagedAuthInvalidation } = require('../../app/lib/managed-auth-invalidation')

async function fixture (t, mode = 'ack') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'anubis-auth-ipc-'))
  const file = path.join(root, 'backend.cjs')
  fs.writeFileSync(file, `
const { registerManagedAuthInvalidation } = require(${JSON.stringify(require.resolve('../../app/lib/managed-auth-invalidation'))})
let invalidations = 0
if (${JSON.stringify(mode)} === 'ack') {
  registerManagedAuthInvalidation({
    async invalidateSessions () {
      await new Promise(resolve => setTimeout(resolve, 20))
      invalidations++
    }
  })
}
process.on('message', message => {
  if (message.type === 'inspect') process.send({ invalidations, hash: process.env.requireAuth })
  if (message.type !== 'managed-auth-changed') return
  if (${JSON.stringify(mode)} === 'wrong-ack') {
    process.send({ type: 'managed-auth-invalidated', requestId: 'a'.repeat(32) })
  }
  if (${JSON.stringify(mode)} === 'exit') process.exit(0)
})
process.send({ ready: true })
`)
  const child = fork(file, [], {
    env: { ...process.env, requireAuth: 'old-fixture-hash' },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc']
  })
  let stderr = ''
  child.stderr.on('data', data => { stderr += data })
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit')
      child.kill()
      await exited
    }
    fs.rmSync(root, { recursive: true, force: true })
    assert.equal(stderr, '')
  })
  assert.deepEqual((await once(child, 'message'))[0], { ready: true })
  return child
}

test('actual owned child IPC acknowledges only after revocation and updates native login hash', async t => {
  const child = await fixture(t)
  const hash = 'b'.repeat(128)
  await awaitManagedAuthInvalidation(child, { hashedPassword: hash })
  const state = once(child, 'message')
  child.send({ type: 'inspect' })
  assert.deepEqual((await state)[0], { invalidations: 1, hash })
  assert.equal(child.listenerCount('message'), 0)
})

test('wrong request ACK cannot confirm revocation and only the owned backend is terminated', async t => {
  const child = await fixture(t, 'wrong-ack')
  const exited = once(child, 'exit')
  await assert.rejects(awaitManagedAuthInvalidation(child, { hashedPassword: 'b'.repeat(128) }), {
    code: 'ERR_MANAGED_AUTH_INVALIDATION',
    message: 'Managed authentication invalidation failed'
  })
  await exited
  assert.equal(child.listenerCount('message'), 0)
})

test('backend exit before ACK is an explicit failure rather than an invalidation success', async t => {
  const child = await fixture(t, 'exit')
  await assert.rejects(awaitManagedAuthInvalidation(child, { hashedPassword: 'b'.repeat(128) }), {
    code: 'ERR_MANAGED_AUTH_INVALIDATION'
  })
})

test('invalid authentication hash fails closed without leaving the owned backend serving sessions', async t => {
  const child = await fixture(t)
  const exited = once(child, 'exit')
  await assert.rejects(awaitManagedAuthInvalidation(child, { hashedPassword: 'invalid' }), {
    code: 'ERR_MANAGED_AUTH_INVALIDATION'
  })
  await exited
})
