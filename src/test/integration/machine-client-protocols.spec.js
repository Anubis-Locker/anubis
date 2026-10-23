const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { DatabaseSync } = require('node:sqlite')

test('separate Electron product and client profiles preserve encrypted protocol preferences without sharing Chromium state', {
  skip: process.platform !== 'win32' || process.env.ANUBIS_PROTOCOLS_E2E !== '1',
  timeout: 180000
}, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'anubis-protocol-context-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 }))
  const appData = path.join(root, 'app-data')
  const product = path.join(appData, 'anubis')
  const client = path.join(appData, 'anubis-client')
  const data = path.join(product, 'users', 'default_user', 'electerm_data.db')
  const worker = path.join(root, 'worker.cjs')
  const payload = path.join(root, 'encrypted-fixtures.json')
  const helper = path.resolve(__dirname, '../../app/lib/machine-client-protocols.js')
  const wrapper = path.resolve(__dirname, '../../app/lib/safe-storage.js')
  const systemDirectory = path.win32.join(process.env.SystemRoot, 'System32')
  for (const dir of [product, client, path.dirname(data)]) fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(worker, `
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict')
const {app,safeStorage}=require('electron')
const input=JSON.parse(fs.readFileSync(process.argv.find(value=>value.endsWith('.case.json')),'utf8'))
app.setName('anubis')
app.setPath('appData',input.appData)
app.setPath('userData',input.profile)
app.setPath('sessionData',input.profile)
app.setPath('crashDumps',input.scratch)
app.setPath('temp',input.scratch)
app.setAppLogsPath(input.scratch)
app.disableHardwareAcceleration()
const hash=value=>crypto.createHash('sha256').update(value).digest('hex')
app.whenReady().then(()=>{
 assert.equal(safeStorage.isEncryptionAvailable(),true)
 let result={pid:process.pid}
 if(input.mode==='produce'){
  const {safeEncrypt}=require(${JSON.stringify(wrapper)})
  const values={false:{deepLinkAutoRegister:false},true:{deepLinkAutoRegister:true},default:{}}
  fs.writeFileSync(input.payload,JSON.stringify(Object.fromEntries(Object.entries(values).map(([name,value])=>[name,'enc:'+safeEncrypt(JSON.stringify(value))]))))
 }else if(input.mode==='prime'){
  result.wrongKeyCipher='enc:v2:safe:'+safeStorage.encryptString(JSON.stringify({deepLinkAutoRegister:false})).toString('base64')
 }else{
  const own=safeStorage.encryptString('disposable client crypto')
  const local=path.join(input.profile,'Local State')
  const before=fs.readFileSync(local)
  const nativeProduct=()=>{
   if(!input.cipher)return null
   try{safeStorage.decryptString(Buffer.from(input.cipher.slice('enc:v2:safe:'.length),'base64'));return true}catch{return false}
  }
  result.nativeProductBefore=nativeProduct()
  const paths={userData:app.getPath('userData'),sessionData:app.getPath('sessionData')}
  try{
   result.value=require(${JSON.stringify(helper)}).readDeepLinkAutoRegister(input.appData,'anubis',input.systemDirectory)
   result.ok=true
  }catch(error){result.ok=false;result.code=error.code||null;result.error=error.name}
  result.nativeProductAfter=nativeProduct()
  result.ownCryptoUnchanged=safeStorage.decryptString(own)==='disposable client crypto'
  result.localStateUnchanged=hash(before)===hash(fs.readFileSync(local))
  result.pathsUnchanged=paths.userData===app.getPath('userData')&&paths.sessionData===app.getPath('sessionData')
  result.userData=app.getPath('userData')
  result.sessionData=app.getPath('sessionData')
 }
 fs.writeFileSync(input.output,JSON.stringify(result))
 app.quit()
}).catch(error=>{fs.writeFileSync(input.output,JSON.stringify({fatal:error.name,code:error.code||null}));app.exit(1)})
`)
  const env = { ...process.env }
  for (const key of Object.keys(env)) {
    if (['electron_run_as_node', 'node_options', 'node_path', 'anubis_managed_admin_token',
      'data_path', 'anubis_machine_context_service'].includes(key.toLowerCase())) delete env[key]
  }
  let generation = 0
  const pids = new Set()
  function run (mode, cipher) {
    const scratch = path.join(root, 'process-' + ++generation)
    fs.mkdirSync(scratch)
    const input = {
      mode,
      cipher,
      appData,
      profile: mode === 'produce' ? product : client,
      systemDirectory,
      scratch,
      payload,
      output: path.join(scratch, 'result.json')
    }
    const file = path.join(scratch, 'input.case.json')
    fs.writeFileSync(file, JSON.stringify(input))
    const child = spawnSync(require('electron'), [worker, file], {
      cwd: scratch, env, windowsHide: true, timeout: 20000, maxBuffer: 1024 * 1024
    })
    assert.equal(child.status, 0, 'Disposable Electron worker failed: ' + (child.error?.code || child.status))
    const result = JSON.parse(fs.readFileSync(input.output, 'utf8'))
    assert.equal(result.fatal, undefined)
    pids.add(result.pid)
    return result
  }
  run('produce')
  const values = JSON.parse(fs.readFileSync(payload, 'utf8'))
  const wrongKeyCipher = run('prime').wrongKeyCipher
  const productState = path.join(product, 'Local State')
  const originalState = fs.readFileSync(productState)
  const stateValue = JSON.parse(originalState)
  assert.notEqual(stateValue.os_crypt.encrypted_key, JSON.parse(fs.readFileSync(path.join(client, 'Local State'))).os_crypt.encrypted_key)
  const initial = new DatabaseSync(data)
  initial.exec('CREATE TABLE data (_id TEXT PRIMARY KEY, data TEXT)')
  initial.close()
  function setRecord (value) {
    const db = new DatabaseSync(data)
    try {
      db.exec('DELETE FROM data')
      if (value !== undefined) db.prepare('INSERT INTO data VALUES (?, ?)').run('userConfig', value)
    } finally { db.close() }
  }
  function check (value, expected, nativeReadable = false) {
    setRecord(value)
    const dbBefore = fs.readFileSync(data)
    const stateBefore = fs.existsSync(productState) ? fs.readFileSync(productState) : null
    const result = run('read', value)
    assert.equal(result.ok, expected !== 'error')
    if (expected !== 'error') assert.equal(result.value, expected)
    assert.equal(result.ownCryptoUnchanged, true)
    assert.equal(result.localStateUnchanged, true)
    assert.equal(result.pathsUnchanged, true)
    assert.equal(result.userData, client)
    assert.equal(result.sessionData, client)
    if (value) {
      assert.equal(result.nativeProductBefore, nativeReadable)
      assert.equal(result.nativeProductAfter, nativeReadable)
    }
    assert.deepEqual(fs.readFileSync(data), dbBefore)
    if (stateBefore) assert.deepEqual(fs.readFileSync(productState), stateBefore)
    else assert.equal(fs.existsSync(productState), false)
    assert.deepEqual(fs.readdirSync(path.dirname(data)), ['electerm_data.db'])
    return result
  }
  for (const [name, expected] of [['false', false], ['true', true], ['default', true]]) {
    await t.test('real cross-process encrypted ' + name + ' uses caller key without changing client crypto context', () => {
      check(values[name], expected)
    })
  }
  await t.test('authenticated framing rejects tampering and ciphertext encrypted by another profile key', () => {
    const bytes = Buffer.from(values.false.slice('enc:v2:safe:'.length), 'base64')
    bytes[bytes.length - 1] ^= 1
    check('enc:v2:safe:' + bytes.toString('base64'), 'error')
    check(wrongKeyCipher, 'error', true)
  })
  await t.test('missing Local State and invalid DPAPI-wrapped key fail closed without creating or replacing a key', () => {
    const held = productState + '.held'
    fs.renameSync(productState, held)
    try { check(values.false, 'error') } finally { fs.renameSync(held, productState) }
    fs.writeFileSync(productState, JSON.stringify({
      ...stateValue,
      os_crypt: { ...stateValue.os_crypt, encrypted_key: Buffer.from('DPAPIinvalid-native-blob').toString('base64') }
    }))
    try {
      assert.equal(check(values.false, 'error').code, 'ERR_MACHINE_PROTOCOL_CONFIG')
    } finally { fs.writeFileSync(productState, originalState) }
  })
  await t.test('absent record defaults on without any product Local State key', () => {
    const held = productState + '.held'
    fs.renameSync(productState, held)
    try { check(undefined, true) } finally { fs.renameSync(held, productState) }
  })
  assert.deepEqual(fs.readFileSync(productState), originalState)
  t.diagnostic('Independent Electron launches: ' + generation + ', observed PIDs: ' + pids.size + '; client userData/sessionData and both profile states preserved')
})
