const { test } = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const { createBrowserRpc } = require('../../app/lib/managed-browser-rpc')

function fixture (options = {}) {
  const salt = 'isolated-fixture-salt'
  const password = {
    salt,
    hashedPassword: crypto.pbkdf2Sync('desktop-password', salt, 1000, 64, 'sha512').toString('hex')
  }
  const config = { theme: 'dark', tokenElecterm: 'native-token', requireAuth: password.hashedPassword, salt, mcpServerToken: 'private-mcp' }
  const db = []
  const functions = {
    dbAction: async (...args) => { db.push(args); return [{ _id: 'bookmark' }] },
    saveUserConfig: async value => { Object.assign(config, value) }
  }
  const rpc = createBrowserRpc({
    functions,
    ...options,
    getConfig: () => config,
    getPassword: async () => password,
    constants: () => ({ packInfo: { version: '5.6.11' } }),
    init: async () => ({ config, langMap: {} })
  })
  return { rpc, config, db }
}

test('browser authentication verifies the existing desktop password independently', async () => {
  const { rpc } = fixture()
  assert.equal(await rpc('browserLogin', ['wrong-password']), false)
  assert.equal(await rpc('browserLogin', ['desktop-password']), true)
  assert.equal(await rpc('browserLogin', [null]), false)
  for (const name of ['browserInfo', 'init']) {
    const result = await rpc(name)
    assert.equal(result.config.theme, 'dark')
    const serialized = JSON.stringify(result)
    for (const secret of ['native-token', 'private-mcp', 'isolated-fixture-salt']) {
      assert.ok(!serialized.includes(secret))
    }
    assert.equal(result.config.requireAuth, undefined)
  }
})

test('browser RPC denies native process controls, prototype pivots and authentication records', async () => {
  const { rpc, db } = fixture()
  for (const func of ['constructor', '__proto__', 'toString', 'closeApp', 'restart', 'safeDecrypt', 'setPassword', 'onAuthorizedLogin', 'isHeadlessAuthorized']) {
    await assert.rejects(rpc(func), /Unsupported/)
  }
  for (const args of [
    ['data', 'find', {}],
    ['data', 'findOne', { _id: 'userConfig' }],
    ['data', 'remove', {}],
    ['data', 'update', { _id: 'lastDataUpdateTime' }, { $set: { _id: 'userConfig', value: 'evil' } }],
    ['bookmarks', 'drop', {}],
    ['unknown-table', 'find', {}]
  ]) await assert.rejects(rpc('dbAction', args))
  assert.equal(db.length, 0)
  for (const key of ['hashedPassword', 'salt', 'requireAuth', 'mcpServerToken']) {
    await assert.rejects(rpc('saveUserConfig', [{ [key]: 'evil' }]), /cannot be changed remotely/)
  }
})

test('only verified profile passwords invoke and await an explicitly enabled headless unlock', async () => {
  let calls = 0
  let release
  const pending = new Promise(resolve => { release = resolve })
  const { rpc } = fixture({
    async onAuthorizedLogin (password) {
      assert.equal(password, 'desktop-password')
      calls++
      await pending
    }
  })
  assert.equal(await rpc('browserLogin', ['wrong-password']), false)
  assert.equal(await rpc('browserLogin', [null]), false)
  assert.equal(calls, 0)
  let finished = false
  const login = rpc('browserLogin', ['desktop-password']).then(value => { finished = true; return value })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(calls, 1)
  assert.equal(finished, false)
  release()
  assert.equal(await login, true)
})

test('failed native unlock remains an explicit failure instead of a successful browser login', async () => {
  const { rpc } = fixture({
    async onAuthorizedLogin () { throw new Error('native workspace unavailable') }
  })
  await assert.rejects(rpc('browserLogin', ['desktop-password']), /native workspace unavailable/)
})

test('browser RPC reuses the existing DB/config functions and preserves ordering data', async () => {
  const { rpc, config, db } = fixture()
  assert.deepEqual(await rpc('dbAction', ['bookmarks', 'find', {}]), [{ _id: 'bookmark' }])
  await rpc('dbAction', ['data', 'findOne', { _id: 'bookmarks:order' }])
  await rpc('dbAction', ['data', 'update', { _id: 'lastDataUpdateTime' }, { $set: { value: 123 } }, { upsert: true }])
  assert.equal(db.length, 3)
  assert.equal(await rpc('saveUserConfig', [{ theme: 'light' }]), true)
  assert.equal(config.theme, 'light')
})
