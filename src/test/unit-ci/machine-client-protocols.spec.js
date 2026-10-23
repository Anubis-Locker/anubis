const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const { DatabaseSync } = require('node:sqlite')
const { readDeepLinkAutoRegister } = require('../../app/lib/machine-client-protocols')
const { createBrowserRpc } = require('../../app/lib/managed-browser-rpc')
const brand = require('../../common/brand.config')

function profile (t, rows = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'anubis-protocols-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const dir = path.join(root, brand.data.dirName, 'users', 'default_user')
  const file = path.join(dir, 'electerm_data.db')
  const seed = () => {
    fs.mkdirSync(dir, { recursive: true })
    const db = new DatabaseSync(file)
    db.exec('CREATE TABLE data (_id TEXT PRIMARY KEY, data TEXT)')
    for (const row of rows) db.prepare('INSERT INTO data VALUES (?, ?)').run(...row)
    db.close()
  }
  return {
    root,
    file,
    dir,
    seed,
    read: decrypt => readDeepLinkAutoRegister(root, brand.data.dirName, decrypt)
  }
}

test('fresh profile defaults on without creating a profile or database; missing config retains original default', t => {
  const f = profile(t)
  assert.equal(f.read(), true)
  assert.deepEqual(fs.readdirSync(f.root), [])
  f.seed()
  assert.equal(f.read(), true)
  assert.deepEqual(fs.readdirSync(f.dir), ['electerm_data.db'])
})

test('plaintext and existing encrypted opt-outs are read without database mutation or writable workspace initialization', t => {
  for (const encrypted of [false, true]) {
    const stored = encrypted ? 'enc:fixture-ciphertext' : JSON.stringify({ deepLinkAutoRegister: false })
    const f = profile(t, [['userConfig', stored]])
    f.seed()
    const bytes = fs.readFileSync(f.file)
    assert.equal(f.read(value => {
      assert.equal(value, 'fixture-ciphertext')
      return JSON.stringify({ deepLinkAutoRegister: false })
    }), false)
    assert.deepEqual(fs.readFileSync(f.file), bytes)
    assert.deepEqual(fs.readdirSync(f.dir), ['electerm_data.db'])
    fs.renameSync(f.file, f.file + '.closed')
    fs.renameSync(f.file + '.closed', f.file)
  }
})

test('only literal false in original userConfig opts out; unencrypted bootstrap record does not replace it', t => {
  for (const config of [{}, { deepLinkAutoRegister: true }, { deepLinkAutoRegister: null }]) {
    const f = profile(t, [
      ['userConfig', JSON.stringify(config)],
      ['userConfigNoEncrypt', JSON.stringify({ deepLinkAutoRegister: false })]
    ])
    f.seed()
    assert.equal(f.read(), true)
  }
})

test('invalid config, decryption failure and invalid database fail closed and release the read-only connection', t => {
  for (const stored of ['private-invalid-json', 'null', '[]', 'enc:encrypted']) {
    const f = profile(t, [['userConfig', stored]])
    f.seed()
    const bytes = fs.readFileSync(f.file)
    assert.throws(() => f.read(() => { throw new Error('Cannot decrypt') }))
    assert.deepEqual(fs.readFileSync(f.file), bytes)
    fs.renameSync(f.file, f.file + '.closed')
  }
  const f = profile(t)
  fs.mkdirSync(f.dir, { recursive: true })
  fs.writeFileSync(f.file, 'Not a SQLite database')
  assert.throws(() => f.read())
  assert.equal(fs.readFileSync(f.file, 'utf8'), 'Not a SQLite database')
})

function protocols (packaged = true) {
  const mutations = []
  const app = {
    isPackaged: packaged,
    isDefaultProtocolClient: protocol => protocol === 'telnet',
    setAsDefaultProtocolClient (protocol) { mutations.push(protocol); return true }
  }
  const output = { exports: {} }
  const dependencies = {
    electron: { app },
    '../common/log': { info () {}, warn () {} },
    '../common/runtime-constants': { isMac: false },
    '../common/brand': brand,
    './glob-state': {},
    '../common/parse-quick-connect': {}
  }
  const source = fs.readFileSync(path.resolve(__dirname, '../../app/lib/deep-link.js'), 'utf8')
  vm.runInNewContext('(function (require,module) {\n' + source + '\n})', { process: { env: {} } })(
    name => {
      assert.ok(Object.hasOwn(dependencies, name), 'Unexpected protocol dependency: ' + name)
      return dependencies[name]
    }, output)
  return { mutations, ...output.exports }
}

test('existing packaged deep-link helper registers brand protocols only and never HTTP(S); development is not forced', () => {
  const f = protocols()
  const result = f.registerDeepLink()
  assert.equal(result.registered, true)
  assert.deepEqual(Object.keys(result.protocols).sort(), [...brand.protocol.extra, brand.protocol.custom].sort())
  assert.deepEqual(f.mutations.sort(), [...brand.protocol.extra.filter(value => value !== 'telnet'), brand.protocol.custom].sort())
  assert.equal(f.mutations.includes('http'), false)
  assert.equal(f.mutations.includes('https'), false)
  const dev = protocols(false)
  assert.equal(dev.registerDeepLink().reason, 'development-mode')
  assert.deepEqual(dev.mutations, [])
})

test('headless machine entry dispatch and remote browser registration never invoke native protocol APIs', async () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../../app/app.js'), 'utf8')
  for (const role of ['--anubis-machine-host', '--anubis-context-worker']) {
    const started = []
    vm.runInNewContext(source, {
      process: { argv: ['anubis.exe', role], stderr: { write: () => assert.fail('Headless startup failed') } },
      require (name) {
        if (name === './lib/machine-runtime-contract') return { parseMachineInvocation: () => ({ role }) }
        if (name === './lib/machine-host-entry') return { startMachineHost: async value => { started.push(value.role) } }
        assert.fail('Headless branch loaded interactive dependency: ' + name)
      }
    })
    assert.deepEqual(started, [role])
  }
  const rpc = createBrowserRpc({ functions: { registerDeepLink: () => assert.fail('Remote browser registered protocols') } })
  assert.equal(await rpc('registerDeepLink', [true]), true)
})
