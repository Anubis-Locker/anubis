const { test } = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')
const { once } = require('node:events')
const { DatabaseSync } = require('node:sqlite')
const express = require('express')
const WebSocket = require('ws')
const { createBrowserRpc } = require('../../app/lib/managed-browser-rpc')
const { initManagedBrowser, HEADER } = require('../../app/server/managed-browser')
const { createProfilePasswordUpdater, verifyProfilePassword } = require('../../app/lib/profile-password')

function load (relative, overrides) {
  const file = path.join(__dirname, relative)
  const nativeRequire = createRequire(file)
  const module = { exports: {} }
  const body = vm.runInThisContext('(function(require,module,exports){' + fs.readFileSync(file, 'utf8') + '\n})', { filename: file })
  body(name => Object.hasOwn(overrides, name) ? overrides[name] : nativeRequire(name), module, module.exports)
  return module.exports
}

function passwordConfig () {
  const salt = '0123456789abcdef0123456789abcdef'
  return {
    _id: 'userConfig',
    salt,
    hashedPassword: crypto.pbkdf2Sync('original-profile-password', salt, 1000, 64, 'sha512').toString('hex'),
    theme: 'existing-theme',
    syncSetting: { enabled: true }
  }
}

async function fixture (t, { adapter = 'sqlite', initial = passwordConfig(), missingDecryptor = false, onAuthorizedLogin, afterPasswordRead } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'anubis-profile-password-'))
  const handles = []
  const cleanup = []
  t.after(async () => {
    for (const close of cleanup) await close()
    for (const handle of handles) handle.close()
    fs.rmSync(root, { recursive: true, force: true })
  })
  const key = crypto.randomBytes(32)
  const state = { readable: true, encryptionAvailable: true, decryptResult: undefined }
  const enc = text => {
    if (!state.encryptionAvailable) return text
    const iv = crypto.randomBytes(12)
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
    const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()])
    return 'v2:safe:' + Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64')
  }
  const dec = text => {
    if (!state.readable) return text
    if (state.decryptResult !== undefined) return state.decryptResult
    const bytes = Buffer.from(text.slice(8), 'base64')
    const cipher = crypto.createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12))
    cipher.setAuthTag(bytes.subarray(12, 28))
    return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString('utf8')
  }
  const options = { enc, dec: missingDecryptor ? undefined : dec }
  const { createDb } = adapter === 'sqlite'
    ? load('../../app/lib/sqlite.js', {
      'node:sqlite': {
        DatabaseSync: function (file) {
          const handle = new DatabaseSync(file)
          handles.push(handle)
          return handle
        }
      }
    })
    : require('../../app/lib/nedb')
  const previous = process.env.DATA_PATH
  let db
  try {
    process.env.DATA_PATH = root
    db = createDb(root, 'synthetic', options)
  } finally {
    if (previous === undefined) delete process.env.DATA_PATH
    else process.env.DATA_PATH = previous
  }
  if (adapter === 'nedb') {
    await Promise.all(db.tables.map(table => db.dbAction(table, 'find', {})))
  }
  if (initial !== null) await db.dbAction('data', 'insert', initial)
  await db.dbAction('bookmarks', 'insert', { _id: 'saved-host', host: 'synthetic.invalid', password: 'synthetic-connection-secret' })
  await db.dbAction('profiles', 'insert', { _id: 'saved-profile', title: 'Existing profile' })
  fs.writeFileSync(path.join(root, 'synthetic-storage-key'), 'unchanged-synthetic-key')
  const rpc = createBrowserRpc({
    functions: {},
    getConfig: () => ({}),
    getPassword: async () => {
      const config = await db.dbAction('data', 'findOne', { _id: 'userConfig' }) || {}
      if (afterPasswordRead) await afterPasswordRead(config)
      return config
    },
    onAuthorizedLogin,
    constants: () => ({ brand: { name: 'Anubis fixture' } }),
    init: async () => ({ config: {} })
  })
  const snapshot = () => {
    const folder = path.join(root, 'users', 'synthetic')
    return Object.fromEntries(fs.readdirSync(folder).sort().map(file => [file, fs.readFileSync(path.join(folder, file))]))
  }
  return { db, root, state, rpc, cleanup, snapshot }
}

async function browser (f) {
  const assets = path.join(f.root, 'assets')
  fs.mkdirSync(assets)
  fs.writeFileSync(path.join(assets, 'manifest.json'), JSON.stringify({ version: 'synthetic' }))
  const warnings = []
  const app = express()
  app.use(express.json())
  require('express-ws')(app)
  const managed = initManagedBrowser(app, {
    secret: 'isolated-private-transport',
    rpc: f.rpc,
    assetsPath: assets,
    getSessionPort: () => undefined,
    log: { debug () {}, warn (...args) { warnings.push(args.join(' ')) } }
  })
  app.ws('/common/s', (socket, req) => {
    if (!req.managedSession) return socket.close(1008)
    socket.on('error', () => {})
  })
  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const sockets = new Set()
  server.on('connection', socket => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  f.cleanup.push(async () => {
    managed.close()
    for (const socket of sockets) socket.destroy()
    await new Promise(resolve => server.close(resolve))
  })
  const origin = `http://127.0.0.1:${server.address().port}`
  const headers = { [HEADER]: 'isolated-private-transport' }
  const request = (url, options = {}) => fetch(origin + url, {
    ...options,
    headers: { ...headers, ...options.headers }
  })
  const login = password => request('/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password })
  })
  return { managed, origin, headers, request, login, warnings }
}

for (const adapter of ['sqlite', 'nedb']) {
  test(`${adapter}: unreadable encrypted data rejects config, browser auth and saved-profile reads without writes`, async t => {
    const f = await fixture(t, { adapter })
    const before = f.snapshot()
    assert.equal((await f.rpc('browserInfo')).requirePassword, true)
    f.state.readable = false
    for (const action of [
      () => f.db.dbAction('data', 'findOne', { _id: 'userConfig' }),
      () => f.db.dbAction('bookmarks', 'find', {}),
      () => f.db.dbAction('profiles', 'findOne', { _id: 'saved-profile' }),
      () => f.rpc('browserInfo'),
      () => f.rpc('browserLogin', ['not-the-password'])
    ]) {
      await assert.rejects(action(), {
        code: 'ERR_PROFILE_DATA_UNAVAILABLE',
        message: 'Protected profile data is unavailable'
      })
    }
    assert.deepEqual(f.snapshot(), before)
    f.state.readable = true
    assert.equal(await f.rpc('browserLogin', ['original-profile-password']), true)
    assert.equal((await f.db.dbAction('bookmarks', 'findOne', { _id: 'saved-host' })).password, 'synthetic-connection-secret')
  })

  test(`${adapter}: missing decryptor never returns a passwordless encrypted profile`, async t => {
    const f = await fixture(t, { adapter, missingDecryptor: true })
    const before = f.snapshot()
    await assert.rejects(f.rpc('browserInfo'), { code: 'ERR_PROFILE_DATA_UNAVAILABLE' })
    await assert.rejects(f.rpc('browserLogin', ['anything']), { code: 'ERR_PROFILE_DATA_UNAVAILABLE' })
    assert.deepEqual(f.snapshot(), before)
  })

  test(`${adapter}: decrypted null, arrays and primitives are not fresh profiles`, async t => {
    const f = await fixture(t, { adapter })
    for (const raw of ['null', '[]', 'false', '"text"', '']) {
      f.state.decryptResult = raw
      await assert.rejects(f.rpc('browserInfo'), { code: 'ERR_PROFILE_DATA_UNAVAILABLE' })
    }
  })
}

test('actual shared auth initialization propagates unreadable profile instead of defaulting to passwordless', async t => {
  const f = await fixture(t)
  let portReads = 0
  const config = load('../../app/lib/get-config.js', {
    './db': f.db,
    '../common/config-default': {},
    './get-port': async () => { portReads++; return 12345 },
    '../common/constants': { userConfigId: 'userConfig', userNoEncryptConfigId: 'userConfigNoEncrypt' },
    '../common/uid': () => 'synthetic-token',
    './glob-state': {},
    '../common/admin-policy': {}
  })
  f.state.readable = false
  await assert.rejects(config.getConfig(), { code: 'ERR_PROFILE_DATA_UNAVAILABLE' })
  await assert.rejects(config.getDbConfig(), { code: 'ERR_PROFILE_DATA_UNAVAILABLE' })
  assert.equal(portReads, 0)
})

test('actual HTTP bootstrap/login fail503 without auto-token or data mutation, then existing password works after recovery', async t => {
  const f = await fixture(t)
  const web = await browser(f)
  const before = f.snapshot()
  f.state.readable = false
  for (const response of [await web.request('/'), await web.login('not-the-profile-password')]) {
    assert.equal(response.status, 503)
    const text = await response.text()
    assert.equal(text, '{"error":"Managed desktop backend unavailable"}')
    assert.ok(!text.includes('tokenElecterm'))
  }
  assert.equal((await web.request('/api/get-constants')).status, 401)
  assert.ok(web.warnings.every(text => text === 'Managed browser request failed: Protected profile data is unavailable'))
  assert.deepEqual(f.snapshot(), before)
  f.state.readable = true
  const html = await (await web.request('/')).text()
  assert.ok(!html.includes("localStorage.setItem('tokenElecterm'"))
  assert.equal((await web.login('wrong-password')).status, 401)
  const login = await web.login('original-profile-password')
  assert.equal(login.status, 200)
  const token = await login.json()
  assert.equal((await web.request('/api/get-constants', { headers: { token } })).status, 200)
})

test('pure verifier checks existing format without backend unlock or treating malformed auth as unset', async () => {
  const config = passwordConfig()
  assert.equal(await verifyProfilePassword('original-profile-password', config), true)
  assert.equal(await verifyProfilePassword('wrong-password', config), false)
  assert.equal(await verifyProfilePassword('', null), true)
  assert.equal(await verifyProfilePassword('', { salt: '', hashedPassword: '' }), true)
  for (const value of [
    undefined, [], 'bad', { salt: '' }, { hashedPassword: '' },
    { salt: config.salt }, { hashedPassword: config.hashedPassword },
    { salt: '', hashedPassword: config.hashedPassword },
    { salt: config.salt, hashedPassword: 'bad' }
  ]) await assert.rejects(verifyProfilePassword('', value), { code: 'ERR_NATIVE_PASSWORD_PROFILE_UNAVAILABLE' })
})

test('wrong old password cannot mutate config, encrypted data or sessions', async t => {
  const f = await fixture(t)
  let invalidations = 0
  const update = createProfilePasswordUpdater({ ...f.db, invalidateSessions: () => { invalidations++ } })
  const before = f.snapshot()
  await assert.rejects(update({ oldPassword: 'wrong', newPassword: 'new' }), {
    code: 'ERR_NATIVE_PASSWORD_OLD_PASSWORD', committed: false
  })
  assert.deepEqual(f.snapshot(), before)
  assert.equal(invalidations, 0)
})

test('initial setup requires truly unset readable config and commits encrypted authentication only', async t => {
  const f = await fixture(t, { initial: null })
  let invalidations = 0
  const update = createProfilePasswordUpdater({ ...f.db, invalidateSessions: () => { invalidations++ } })
  const before = f.snapshot()
  assert.deepEqual(await update({ oldPassword: '', newPassword: 'first-password' }), { committed: true })
  const config = await f.db.dbAction('data', 'findOne', { _id: 'userConfig' })
  assert.equal(await verifyProfilePassword('first-password', config), true)
  assert.equal(invalidations, 1)
  assert.deepEqual(f.snapshot()['electerm.db'], before['electerm.db'])
  assert.equal(fs.readFileSync(path.join(f.root, 'synthetic-storage-key'), 'utf8'), 'unchanged-synthetic-key')
  const disk = f.snapshot()['electerm_data.db'].toString('utf8')
  assert.ok(!disk.includes('first-password') && !disk.includes(config.hashedPassword))
})

test('rotation preserves all settings and profile bytes and rejects queued reuse of the old password', async t => {
  const f = await fixture(t)
  const before = f.snapshot()
  let invalidations = 0
  const update = createProfilePasswordUpdater({ ...f.db, invalidateSessions: () => { invalidations++ } })
  const outcomes = await Promise.allSettled([
    update({ oldPassword: 'original-profile-password', newPassword: 'new-password' }),
    update({ oldPassword: 'original-profile-password', newPassword: 'must-not-win' })
  ])
  assert.equal(outcomes[0].status, 'fulfilled')
  assert.equal(outcomes[1].reason.code, 'ERR_NATIVE_PASSWORD_OLD_PASSWORD')
  const config = await f.db.dbAction('data', 'findOne', { _id: 'userConfig' })
  assert.equal(config.theme, 'existing-theme')
  assert.deepEqual(config.syncSetting, { enabled: true })
  assert.equal(await verifyProfilePassword('new-password', config), true)
  assert.equal(await verifyProfilePassword('original-profile-password', config), false)
  assert.deepEqual(f.snapshot()['electerm.db'], before['electerm.db'])
  assert.equal(invalidations, 1)
})

test('CAS refuses stale config without clobbering a concurrent settings change', async t => {
  const f = await fixture(t)
  let invalidations = 0
  const update = createProfilePasswordUpdater({
    ...f.db,
    async compareAndSetUserConfig (expected, replacement) {
      await f.db.dbAction('data', 'update', { _id: 'userConfig' }, { ...expected, theme: 'concurrent-theme' })
      return f.db.compareAndSetUserConfig(expected, replacement)
    },
    invalidateSessions: () => { invalidations++ }
  })
  await assert.rejects(update({ oldPassword: 'original-profile-password', newPassword: 'new-password' }), {
    code: 'ERR_NATIVE_PASSWORD_CONFLICT', committed: false
  })
  const config = await f.db.dbAction('data', 'findOne', { _id: 'userConfig' })
  assert.equal(config.theme, 'concurrent-theme')
  assert.equal(await verifyProfilePassword('original-profile-password', config), true)
  assert.equal(invalidations, 0)
})

test('unreadable profile and encryption fallback refuse native mutation without changing bytes', async t => {
  const f = await fixture(t)
  const before = f.snapshot()
  const update = createProfilePasswordUpdater({
    ...f.db,
    invalidateSessions: () => assert.fail('No committed update')
  })
  f.state.readable = false
  await assert.rejects(update({ oldPassword: '', newPassword: 'new-password' }), {
    code: 'ERR_NATIVE_PASSWORD_PROFILE_UNAVAILABLE', committed: false
  })
  f.state.readable = true
  f.state.encryptionAvailable = false
  await assert.rejects(update({ oldPassword: 'original-profile-password', newPassword: 'new-password' }), {
    code: 'ERR_NATIVE_PASSWORD_PROFILE_UNAVAILABLE', committed: false
  })
  assert.deepEqual(f.snapshot(), before)
})

test('invalid new passwords or auth-record injection never reach storage', async t => {
  const f = await fixture(t)
  const before = f.snapshot()
  const update = createProfilePasswordUpdater({
    ...f.db,
    invalidateSessions: () => assert.fail('No committed update')
  })
  for (const input of [
    null, [], {}, { oldPassword: 'original-profile-password', newPassword: '' },
    { oldPassword: 'original-profile-password', newPassword: 'x'.repeat(4097) },
    { oldPassword: 1, newPassword: 'new-password' },
    { oldPassword: 'original-profile-password', newPassword: 'new-password', callerSid: 'S-1-5-18' }
  ]) await assert.rejects(update(input), { code: 'ERR_NATIVE_PASSWORD_INVALID_INPUT', committed: false })
  assert.deepEqual(f.snapshot(), before)
})

test('committed invalidation failure is distinct and cannot report success or rollback', async t => {
  const f = await fixture(t)
  const update = createProfilePasswordUpdater({
    ...f.db,
    invalidateSessions: () => { throw new Error('sensitive-test-detail') }
  })
  await assert.rejects(update({ oldPassword: 'original-profile-password', newPassword: 'new-password' }), {
    code: 'ERR_NATIVE_PASSWORD_COMMITTED_INVALIDATION_FAILED',
    committed: true,
    message: 'Native profile password update failed'
  })
  const config = await f.db.dbAction('data', 'findOne', { _id: 'userConfig' })
  assert.equal(await verifyProfilePassword('new-password', config), true)
})

test('success waits for invalidation and actual HTTP tokens/common WebSocket are revoked after commit', async t => {
  const f = await fixture(t)
  const web = await browser(f)
  const token = await (await web.login('original-profile-password')).json()
  const ws = new WebSocket(web.origin.replace('http:', 'ws:') + '/common/s', { headers: { ...web.headers, token } })
  await once(ws, 'open')
  const closed = once(ws, 'close')
  let release
  const blocked = new Promise(resolve => { release = resolve })
  let reached
  const entered = new Promise(resolve => { reached = resolve })
  let finished = false
  const update = createProfilePasswordUpdater({
    ...f.db,
    async invalidateSessions () {
      reached()
      await blocked
      await web.managed.invalidateSessions()
    }
  })
  const result = update({ oldPassword: 'original-profile-password', newPassword: 'new-password' })
    .then(value => { finished = true; return value })
  await entered
  assert.equal(finished, false)
  assert.equal(await verifyProfilePassword('new-password', await f.db.dbAction('data', 'findOne', { _id: 'userConfig' })), true)
  release()
  assert.deepEqual(await result, { committed: true })
  assert.equal((await closed)[0], 1008)
  assert.equal((await web.request('/api/get-constants', { headers: { token } })).status, 401)
  assert.equal((await web.login('original-profile-password')).status, 401)
  assert.equal((await web.login('new-password')).status, 200)
})

function authenticationGate () {
  let enter
  let release
  const entered = new Promise(resolve => { enter = resolve })
  const blocked = new Promise(resolve => { release = resolve })
  return {
    entered,
    release,
    async wait () {
      enter()
      await blocked
    }
  }
}

function headlessLoginCallback (f, gate) {
  const babel = createRequire(require.resolve('@vitejs/plugin-react'))('@babel/core')
  const file = path.resolve(__dirname, '../../app/lib/ipc.js')
  let selected
  const { code } = babel.transformSync(fs.readFileSync(file, 'utf8'), {
    babelrc: false,
    configFile: false,
    plugins: [({ types: t }) => ({
      visitor: {
        ObjectProperty (value) {
          if (value.node.key.name === 'onAuthorizedLogin') selected = value.node.value.consequent
        },
        Program: {
          exit (value) {
            assert.ok(selected)
            value.node.body = [t.expressionStatement(t.assignmentExpression('=',
              t.memberExpression(t.identifier('module'), t.identifier('exports')), selected))]
          }
        }
      }
    })]
  })
  const events = []
  const win = {
    isDestroyed: () => false,
    webContents: {
      isDestroyed: () => false,
      send: message => events.push(message),
      async executeJavaScript () {
        events.push('readiness')
        await gate.wait()
        return true
      }
    }
  }
  const module = { exports: {} }
  vm.runInNewContext(code, {
    module,
    async checkPassword (password) {
      const verified = await verifyProfilePassword(password, await f.db.dbAction('data', 'findOne', { _id: 'userConfig' }))
      if (verified) events.push('verified')
      return verified
    },
    globalState: {
      get (key) { assert.equal(key, 'win'); return win },
      set (key, value) { assert.equal(value, true); events.push(key) }
    },
    require (name) {
      assert.equal(name, './machine-host-entry')
      return require('../../app/lib/machine-host-entry')
    }
  })
  return { callback: module.exports, events }
}

test('held verified old-password authorized-login callback cannot issue a valid token after completed rotation', async t => {
  const gate = authenticationGate()
  const f = await fixture(t, {
    onAuthorizedLogin: password => native.callback(password)
  })
  const native = headlessLoginCallback(f, gate)
  const web = await browser(f)
  const pending = web.login('original-profile-password')
  await gate.entered
  assert.deepEqual(native.events, ['verified', 'headlessAuthorizedLogin', 'headless-authorized-login', 'readiness'])
  const update = createProfilePasswordUpdater({ ...f.db, invalidateSessions: web.managed.invalidateSessions })
  try {
    assert.deepEqual(await update({ oldPassword: 'original-profile-password', newPassword: 'new-password' }), { committed: true })
  } finally {
    gate.release()
  }
  const response = await pending
  const body = await response.json()
  const token = typeof body === 'string' ? body : 'no-stale-login-token'
  assert.equal((await web.request('/api/get-constants', { headers: { token } })).status, 401)
  assert.equal(response.status, 401)
  assert.equal((await web.login('original-profile-password')).status, 401)
  const fresh = await web.login('new-password')
  assert.equal(fresh.status, 200)
  assert.equal((await web.request('/api/get-constants', { headers: { token: await fresh.json() } })).status, 200)
})

test('held actual passwordless bootstrap cannot mint a valid token after completed first-password provisioning', async t => {
  const gate = authenticationGate()
  let hold = true
  const f = await fixture(t, {
    initial: { _id: 'userConfig', theme: 'existing-theme' },
    async afterPasswordRead () {
      if (hold) {
        hold = false
        await gate.wait()
      }
    }
  })
  const web = await browser(f)
  const pending = web.request('/')
  await gate.entered
  const update = createProfilePasswordUpdater({ ...f.db, invalidateSessions: web.managed.invalidateSessions })
  try {
    assert.deepEqual(await update({ oldPassword: '', newPassword: 'new-password' }), { committed: true })
  } finally {
    gate.release()
  }
  const response = await pending
  const html = await response.text()
  const issued = /localStorage\.setItem\('tokenElecterm',("[^"]+")\)/.exec(html)
  const token = issued ? JSON.parse(issued[1]) : 'no-stale-bootstrap-token'
  assert.equal((await web.request('/api/get-constants', { headers: { token } })).status, 401)
  assert.equal(response.status, 401)
  assert.equal(issued, null)
  const current = await web.request('/')
  assert.equal(current.status, 200)
  assert.ok(!(await current.text()).includes("localStorage.setItem('tokenElecterm'"))
  const fresh = await web.login('new-password')
  assert.equal(fresh.status, 200)
  assert.equal((await web.request('/api/get-constants', { headers: { token: await fresh.json() } })).status, 200)
})

test('held authenticated constants bootstrap rejects its stale session after completed rotation', async t => {
  const gate = authenticationGate()
  let hold = false
  const f = await fixture(t, {
    async afterPasswordRead () {
      if (hold) {
        hold = false
        await gate.wait()
      }
    }
  })
  const web = await browser(f)
  const token = await (await web.login('original-profile-password')).json()
  hold = true
  const pending = web.request('/api/get-constants', { headers: { token } })
  await gate.entered
  const update = createProfilePasswordUpdater({ ...f.db, invalidateSessions: web.managed.invalidateSessions })
  try {
    assert.deepEqual(await update({ oldPassword: 'original-profile-password', newPassword: 'new-password' }), { committed: true })
  } finally {
    gate.release()
  }
  assert.equal((await pending).status, 401)
  assert.equal((await web.request('/api/get-constants', { headers: { token } })).status, 401)
  const fresh = await web.login('new-password')
  assert.equal(fresh.status, 200)
  assert.equal((await web.request('/api/get-constants', { headers: { token: await fresh.json() } })).status, 200)
})
