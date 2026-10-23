const { test } = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const { createBrowserRpc } = require('../../app/lib/managed-browser-rpc')

function fixture () {
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
  for (const func of ['constructor', '__proto__', 'toString', 'closeApp', 'restart', 'safeDecrypt', 'setPassword']) {
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

test('browser RPC reuses the existing DB/config functions and preserves ordering data', async () => {
  const { rpc, config, db } = fixture()
  assert.deepEqual(await rpc('dbAction', ['bookmarks', 'find', {}]), [{ _id: 'bookmark' }])
  await rpc('dbAction', ['data', 'findOne', { _id: 'bookmarks:order' }])
  await rpc('dbAction', ['data', 'update', { _id: 'lastDataUpdateTime' }, { $set: { value: 123 } }, { upsert: true }])
  assert.equal(db.length, 3)
  assert.equal(await rpc('saveUserConfig', [{ theme: 'light' }]), true)
  assert.equal(config.theme, 'light')
})
