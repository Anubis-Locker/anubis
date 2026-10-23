const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const crypto = require('node:crypto')
const { createRequire } = require('node:module')
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
    read: () => readDeepLinkAutoRegister(root, brand.data.dirName, 'C:\\Windows\\System32')
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

test('plaintext opt-outs are read without database mutation or writable workspace initialization', t => {
  for (const stored of [JSON.stringify({ deepLinkAutoRegister: false }), 'enc:' + JSON.stringify({ deepLinkAutoRegister: false })]) {
    const f = profile(t, [['userConfig', stored]])
    f.seed()
    const bytes = fs.readFileSync(f.file)
    assert.equal(f.read(), false)
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
    assert.throws(() => f.read())
    assert.deepEqual(fs.readFileSync(f.file), bytes)
    fs.renameSync(f.file, f.file + '.closed')
  }
  const f = profile(t)
  fs.mkdirSync(f.dir, { recursive: true })
  fs.writeFileSync(f.file, 'Not a SQLite database')
  assert.throws(() => f.read())
  assert.equal(fs.readFileSync(f.file, 'utf8'), 'Not a SQLite database')
})

function encryptedProfile (t, options = {}) {
  const key = crypto.randomBytes(32)
  const nonce = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce)
  const body = Buffer.concat([cipher.update(JSON.stringify({ deepLinkAutoRegister: false })), cipher.final()])
  let bytes = Buffer.concat([Buffer.from(options.version || 'v10'), nonce, body, cipher.getAuthTag()])
  if (options.short) bytes = bytes.subarray(0, 30)
  if (options.tamper) bytes[bytes.length - 1] ^= 1
  const wrapped = Buffer.concat([Buffer.from(options.prefix || 'DPAPI'), Buffer.from('wrapped-fixture-key')])
  const f = profile(t, [['userConfig', 'enc:v2:safe:' + bytes.toString('base64')]])
  f.seed()
  fs.writeFileSync(path.join(f.root, brand.data.dirName, 'Local State'),
    JSON.stringify({ os_crypt: { encrypted_key: wrapped.toString('base64') } }))
  const filename = path.resolve(__dirname, '../../app/lib/machine-client-protocols.js')
  const localRequire = createRequire(filename)
  const output = { exports: {} }
  const returned = []
  const commands = []
  vm.runInNewContext('(function(require,module){\n' + fs.readFileSync(filename, 'utf8') + '\n})', { Buffer })(
    name => name === 'node:child_process'
      ? {
          execFileSync (file, args, config) {
            commands.push({ file, args, config })
            assert.equal(file, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
            assert.ok(args.includes('-NoProfile') && args.includes('-NonInteractive'))
            assert.equal(config.input, wrapped.subarray(5).toString('base64'))
            assert.equal(config.timeout, 10000)
            assert.equal(config.maxBuffer, 4096)
            assert.equal(config.windowsHide, true)
            assert.equal(config.env, undefined)
            assert.deepEqual(Array.from(config.stdio), ['pipe', 'pipe', 'pipe'])
            assert.equal(args.join(' ').includes(config.input), false)
            const value = Buffer.from(options.badSize ? Buffer.alloc(31).toString('base64') : key.toString('base64'))
            if (options.badOutput) value[0] |= 128
            returned.push(value)
            if (options.failure) throw Object.assign(new Error('Private native error'), { stdout: value, stderr: Buffer.from('private') })
            return value
          }
        }
      : localRequire(name), output)
  return {
    ...f,
    commands,
    returned,
    read: () => output.exports.readDeepLinkAutoRegister(f.root, brand.data.dirName, 'C:\\Windows\\System32')
  }
}

test('same-user DPAPI key uses only bounded private pipes; authenticated decryption wipes transient output', t => {
  const f = encryptedProfile(t)
  const before = fs.readFileSync(f.file)
  assert.equal(f.read(), false)
  assert.equal(f.commands.length, 1)
  assert.ok(f.returned.every(value => value.every(byte => byte === 0)))
  assert.deepEqual(fs.readFileSync(f.file), before)
})

test('tampered framing, wrong DPAPI prefix, invalid key size and native failure never enable registration', t => {
  for (const options of [
    { tamper: true }, { prefix: 'OTHER' }, { version: 'v11' },
    { short: true }, { badSize: true }, { badOutput: true }, { failure: true }
  ]) {
    const f = encryptedProfile(t, options)
    assert.throws(() => f.read())
    assert.ok(f.returned.every(value => value.every(byte => byte === 0)))
    if (options.prefix || options.version || options.short) assert.equal(f.commands.length, 0)
  }
})

test('oversized config and Local State inputs fail closed before native unprotection', t => {
  for (const stored of [
    'x'.repeat(4 * 1024 * 1024 + 1),
    JSON.stringify({ deepLinkAutoRegister: false, padding: '\u00e9'.repeat(2 * 1024 * 1024) })
  ]) {
    const f = profile(t, [['userConfig', stored]])
    f.seed()
    assert.throws(() => f.read(), /Invalid protocol/)
  }
  const encrypted = encryptedProfile(t)
  fs.writeFileSync(path.join(encrypted.root, brand.data.dirName, 'Local State'), 'x'.repeat(4 * 1024 * 1024 + 1))
  assert.throws(() => encrypted.read(), /Invalid protocol/)
  assert.equal(encrypted.commands.length, 0)
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
