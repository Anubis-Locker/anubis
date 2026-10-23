const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createMachineConnection } = require('../../app/lib/machine-client-connection')

function descriptor (number = 1) {
  return {
    contextId: String(number).repeat(32),
    identity: { sid: 'S-1-5-18', account: 'SYSTEM', sessionId: 0, elevated: true, pid: number },
    endpoint: { localPort: 40000 + number, privateProof: String(number).repeat(64) }
  }
}

function fixture () {
  let value = descriptor()
  let ticks = 0
  let resolved = 0
  let clears = 0
  const timers = new Map()
  const events = []
  const attachments = []
  const selections = []
  const signals = []
  let nextId = 0
  let attach = async () => {}
  const connection = createMachineConnection({
    async resolve (selection, signal) {
      resolved++
      selections.push(selection)
      signals.push(signal)
      if (value instanceof Error) throw value
      return typeof value === 'function' ? value() : value
    },
    async attach (selected) { attachments.push(selected); await attach(selected) },
    clear () { clears++ },
    notify: value => events.push(value),
    now: () => ticks,
    schedule (callback) { const id = ++nextId; timers.set(id, callback); return id },
    cancel: id => timers.delete(id),
    interval: 3,
    retryTimeout: 10
  })
  return {
    connection,
    events,
    attachments,
    selections,
    signals,
    timers,
    value: next => { value = next },
    attach: callback => { attach = callback },
    resolved: () => resolved,
    clears: () => clears,
    async tick () {
      ticks += 3
      const [id, callback] = timers.entries().next().value
      timers.delete(id)
      return callback()
    }
  }
}

test('secure broker polling preserves a healthy view and replaces expired endpoint/proof after a service restart', async () => {
  const f = fixture()
  const selected = { target: { target: 'system' } }
  await f.connection.select(selected)
  await f.tick()
  assert.equal(f.attachments.length, 1)
  f.value(new Error('service stopped'))
  await f.tick()
  assert.equal(f.connection.getContext(), null)
  assert.equal(f.events.at(-1).reconnecting, true)
  f.value(descriptor(2))
  await f.tick()
  assert.equal(f.attachments.length, 2)
  assert.equal(f.connection.getContext().identity.pid, 2)
  assert.ok(f.selections.every(value => value === selected))
  assert.ok(f.clears() >= 3)
  assert.equal(JSON.stringify(f.events).includes('privateProof'), false)
  f.connection.dispose()
  assert.equal(f.timers.size, 0)
})

test('reconnection retries are bounded and stop without selecting a fallback account', async () => {
  const f = fixture()
  f.value(new Error('not running'))
  await f.connection.select({ target: { target: 'user', sessionId: 2 }, user: { id: 2, sid: 'user-sid' } })
  while (f.timers.size) await f.tick()
  assert.equal(f.events.at(-1).reconnecting, false)
  assert.equal(f.resolved(), 4)
  assert.ok(f.selections.every(value => value.target.target === 'user' && value.user.sid === 'user-sid'))
  assert.equal(f.attachments.length, 0)
})

test('changed Windows identity or malformed descriptors stop reconnection immediately', async () => {
  for (const code of ['ERR_HOST_CONTEXT_IDENTITY', 'ERR_HOST_DESCRIPTOR']) {
    const f = fixture()
    f.value(Object.assign(new Error('rejected'), { code }))
    const result = await f.connection.select({ target: { target: 'user', sessionId: 2 } })
    assert.equal(result.code, code)
    assert.equal(result.reconnecting, false)
    assert.equal(f.timers.size, 0)
  }
})

test('late broker responses never replace a newer selection or recreate a closed GUI', async () => {
  for (const close of [false, true]) {
    const f = fixture()
    let release
    f.value(() => new Promise(resolve => { release = resolve }))
    const first = f.connection.select({ target: { target: 'system' } })
    if (close) {
      f.connection.dispose()
    } else {
      f.value(descriptor(2))
      await f.connection.select({ target: { target: 'user', sessionId: 2 } })
    }
    release(descriptor())
    assert.equal((await first).code, 'ERR_HOST_CONTEXT_REPLACED')
    assert.equal(f.signals[0].aborted, true)
    assert.equal(f.attachments.length, close ? 0 : 1)
    assert.equal(f.connection.getContext()?.identity.pid, close ? undefined : 2)
    f.connection.dispose()
  }
})

test('renderer failure and failed navigation discard the view and retry only the same validated context', async () => {
  const f = fixture()
  await f.connection.select({ target: { target: 'system' } })
  f.connection.invalidate()
  await f.tick()
  assert.equal(f.attachments.length, 2)
  f.attach(async () => { throw new Error('navigation failed') })
  f.connection.invalidate()
  await f.tick()
  assert.equal(f.connection.getContext(), null)
  assert.equal(f.events.at(-1).reconnecting, true)
  f.attach(async () => {})
  await f.tick()
  assert.equal(f.connection.getContext().identity.pid, 1)
  f.connection.dispose()
})
