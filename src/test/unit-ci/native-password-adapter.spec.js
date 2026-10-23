const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')
const { Writable } = require('node:stream')
const { createBrowserRpc } = require('../../app/lib/managed-browser-rpc')

const contextId = 'a'.repeat(32)
const admissionId = 'b'.repeat(64)
const helper = 'C:\\Program Files\\Anubis\\anubis-host.exe'
const packet = { version: 1, operation: 'native-password-update', contextId, admissionId }

function load (relative, overrides = {}) {
  const file = path.join(__dirname, relative)
  const nativeRequire = createRequire(file)
  const module = { exports: {} }
  vm.runInThisContext('(function(require,module,exports){' + fs.readFileSync(file, 'utf8') + '\n})', { filename: file })(
    name => Object.hasOwn(overrides, name) ? overrides[name] : nativeRequire(name), module, module.exports)
  return module.exports
}

function outcome (committed = true) {
  return { pid: process.pid, contextId, admissionId, committed }
}

function redemption () {
  return {
    admissionId,
    operation: 'native-password-update',
    contextId,
    runtime: { pid: process.pid, creationTime: '01dc000000000001' },
    caller: {
      sid: 'S-1-5-21-111-222-333-1001',
      account: 'FIXTURE\\admin',
      elevated: true,
      sessionId: 2,
      pid: 123,
      logonSid: 'S-1-5-5-1-2',
      creationTime: '01dc000000000002'
    },
    oldPassword: 'old-fixture-password',
    newPassword: 'new-fixture-password'
  }
}

// These fixtures verify framing/dispatch, not Windows OS admission.
function clientFixture (reply, error = null) {
  const calls = []
  const client = load('../../app/lib/native-password-client.js', {
    'node:child_process': {
      execFile (file, args, options, callback) {
        const chunks = []
        const stdin = new Writable({
          write (chunk, encoding, done) { chunks.push(chunk); done() },
          final (done) {
            const frame = Buffer.concat(chunks).toString('utf8')
            calls.push({ file, args, options, frame })
            queueMicrotask(() => callback(error, typeof reply === 'string' ? reply : JSON.stringify(reply)))
            done()
          }
        })
        return { stdin }
      }
    }
  })
  return { client, calls }
}

test('native initiation uses only protected helper private stdio, never password arguments', async () => {
  const { client, calls } = clientFixture({ version: 1, ok: true, result: outcome() })
  const request = {
    version: 1,
    operation: 'native-password-update',
    target: 'system',
    contextId,
    oldPassword: 'old-fixture-password',
    newPassword: 'new-fixture-password'
  }
  assert.deepEqual(await client.executeNativePassword(helper, 'AnubisHost', request), outcome())
  assert.equal(calls.length, 1)
  assert.equal(calls[0].file, helper)
  assert.deepEqual(calls[0].args, ['broker-client', '--name', 'AnubisHost', '--stdio'])
  assert.deepEqual(JSON.parse(calls[0].frame), request)
  assert.deepEqual(calls[0].options.stdio, ['pipe', 'pipe', 'pipe'])
  assert.equal(calls[0].options.shell, false)
  assert.equal(calls[0].options.timeout, 10000)
})

test('redemption accepts exact binding and lossless full FILETIME strings only', async () => {
  const request = { version: 1, operation: 'redeem-native-password', contextId, admissionId }
  const valid = redemption()
  assert.deepEqual(await clientFixture({ version: 1, ok: true, result: valid }).client.executeNativePassword(
    helper, 'AnubisHost', request), valid)
  for (const mutate of [
    value => { value.contextId = 'c'.repeat(32) },
    value => { value.admissionId = 'c'.repeat(64) },
    value => { value.runtime.pid++ },
    value => { value.runtime.creationTime = 134000000000000000 },
    value => { value.caller.elevated = false },
    value => { value.caller.sessionId = 0 },
    value => { value.caller.sid = 'S-1-5-18' },
    value => { value.newPassword = '' },
    value => { value.newPassword = '\ud800' },
    value => { value.extra = true }
  ]) {
    const result = redemption()
    mutate(result)
    await assert.rejects(clientFixture({ version: 1, ok: true, result }).client.executeNativePassword(
      helper, 'AnubisHost', request), { code: 'ERR_NATIVE_PASSWORD_OUTCOME_UNKNOWN' })
  }
})

test('malformed or lost outcomes never become uncommitted claims or automatic retries', async () => {
  const request = {
    version: 1,
    operation: 'native-password-update',
    target: 'system',
    contextId,
    oldPassword: 'old',
    newPassword: 'new'
  }
  for (const reply of [
    '', {}, { version: 1, ok: true, result: { ...outcome(), committed: undefined } },
    { version: 1, ok: true, result: { ...outcome(), contextId: 'c'.repeat(32) } },
    { version: 1, ok: false, error: 'secret-freeform-error' },
    { version: 1, ok: false, error: 'ERR_NATIVE_PASSWORD_OLD_PASSWORD' },
    { version: 1, ok: false, error: 'ERR_NATIVE_PASSWORD_OUTCOME_UNKNOWN' }
  ]) {
    const { client, calls } = clientFixture(reply)
    await assert.rejects(client.executeNativePassword(helper, 'AnubisHost', request), error =>
      error.code === 'ERR_NATIVE_PASSWORD_OUTCOME_UNKNOWN' && !Object.hasOwn(error, 'committed'))
    assert.equal(calls.length, 1)
  }
})

test('bound committed and uncommitted errors stay distinct despite helper nonzero exit', async () => {
  const request = {
    version: 1,
    operation: 'native-password-update',
    target: 'system',
    contextId,
    oldPassword: 'old',
    newPassword: 'new'
  }
  for (const [code, committed] of [
    ['ERR_NATIVE_PASSWORD_OLD_PASSWORD', false],
    ['ERR_NATIVE_PASSWORD_COMMITTED_INVALIDATION_FAILED', true]
  ]) {
    const { client } = clientFixture({ version: 1, ok: false, result: outcome(committed), error: code }, new Error('ignored-private-error'))
    await assert.rejects(client.executeNativePassword(helper, 'AnubisHost', request), {
      code, committed, message: 'Native workspace password operation failed'
    })
  }
})

test('password framing preserves supported maximum UTF16 length and rejects invalid local inputs', async () => {
  const request = {
    version: 1,
    operation: 'native-password-update',
    target: 'system',
    contextId,
    oldPassword: '\0'.repeat(4096),
    newPassword: '\ud83d\udd11'.repeat(2048)
  }
  const { client, calls } = clientFixture({ version: 1, ok: true, result: outcome() })
  await client.executeNativePassword(helper, 'AnubisHost', request)
  assert.ok(Buffer.byteLength(calls[0].frame) <= 65536)
  assert.deepEqual(JSON.parse(calls[0].frame), request)
  for (const extra of [
    { newPassword: '' }, { newPassword: 'x'.repeat(4097) },
    { oldPassword: '\ud800' }, { target: 'user' }, { callerSid: 'S-1-5-18' }
  ]) {
    await assert.rejects(client.executeNativePassword(helper, 'AnubisHost', { ...request, ...extra }), {
      code: 'ERR_NATIVE_PASSWORD_INVALID_INPUT', committed: false
    })
  }
  assert.equal(calls.length, 1)
})

test('runtime dispatch never invokes updater before actual helper redemption returns successfully', async () => {
  let calls = 0
  let updates = 0
  const client = require('../../app/lib/native-password-client')
  const { createNativePasswordHandler } = load('../../app/lib/native-password-runtime.js', {
    './native-password-client': {
      ...client,
      executeNativePassword: async () => { calls++; throw new Error('helper refused') }
    }
  })
  const handler = createNativePasswordHandler({
    helper,
    serviceName: 'AnubisHost',
    contextId,
    updatePassword: async () => { updates++; return { committed: true } }
  })
  await assert.rejects(handler({ ...packet, oldPassword: 'forged' }), { code: 'ERR_NATIVE_PASSWORD_ADMISSION' })
  assert.equal(calls, 0)
  assert.deepEqual(await handler(packet), {
    version: 1, ok: false, result: outcome(false), error: { code: 'ERR_NATIVE_PASSWORD_ADMISSION' }
  })
  assert.equal(updates, 0)
})

test('runtime success is bound and duplicate async packets cannot replace its invocation or update twice', async () => {
  let release
  const pending = new Promise(resolve => { release = resolve })
  const redeemed = redemption()
  let updates = 0
  const client = require('../../app/lib/native-password-client')
  const { createNativePasswordHandler } = load('../../app/lib/native-password-runtime.js', {
    './native-password-client': { ...client, executeNativePassword: async () => { await pending; return redeemed } }
  })
  const handler = createNativePasswordHandler({
    helper,
    serviceName: 'AnubisHost',
    contextId,
    updatePassword: async input => {
      updates++
      assert.deepEqual(input, { oldPassword: 'old-fixture-password', newPassword: 'new-fixture-password' })
      return { committed: true }
    }
  })
  const first = handler(packet)
  await assert.rejects(handler(packet), { code: 'ERR_NATIVE_PASSWORD_BUSY' })
  release()
  assert.deepEqual(await first, { version: 1, ok: true, result: outcome() })
  assert.equal(updates, 1)
  assert.equal(redeemed.oldPassword, undefined)
  assert.equal(redeemed.newPassword, undefined)
})

test('runtime forwards only fixed bound core failures with explicit committed state', async () => {
  const client = require('../../app/lib/native-password-client')
  const { createNativePasswordHandler } = load('../../app/lib/native-password-runtime.js', {
    './native-password-client': { ...client, executeNativePassword: async () => redemption() }
  })
  for (const [code, committed] of [
    ['ERR_NATIVE_PASSWORD_OLD_PASSWORD', false],
    ['ERR_NATIVE_PASSWORD_COMMITTED_INVALIDATION_FAILED', true]
  ]) {
    const handler = createNativePasswordHandler({
      helper,
      serviceName: 'AnubisHost',
      contextId,
      updatePassword: async () => { throw Object.assign(new Error('private detail'), { code, committed }) }
    })
    assert.deepEqual(await handler(packet), {
      version: 1, ok: false, result: outcome(committed), error: { code }
    })
  }
})

test('new internal storage, verifier, admission and mutation functions remain forbidden over Web RPC', async () => {
  const rpc = createBrowserRpc({
    functions: {},
    getConfig: () => ({}),
    getPassword: async () => ({}),
    constants: () => ({}),
    init: async () => ({ config: {} })
  })
  for (const name of [
    'compareAndSetUserConfig', 'createProfilePasswordUpdater', 'verifyProfilePassword',
    'executeNativePassword', 'createNativePasswordHandler', 'openNativePasswordSettings',
    'awaitManagedAuthInvalidation', 'native-password-update', 'redeem-native-password'
  ]) await assert.rejects(rpc(name), /Unsupported managed browser function/)
})
