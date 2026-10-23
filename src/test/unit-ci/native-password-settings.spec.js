const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { EventEmitter } = require('node:events')
const { createRequire } = require('node:module')
const { pathToFileURL } = require('node:url')

function fixture (execute = async () => ({ committed: true }), onChanged = async () => {}) {
  const file = path.resolve(__dirname, '../../app/lib/native-password-settings.js')
  const module = { exports: {} }
  const calls = []
  const handlers = new Map()
  let window
  class Window extends EventEmitter {
    constructor (options) {
      super()
      this.options = options
      this.webContents = new EventEmitter()
      this.webContents.mainFrame = { url: '' }
      this.webContents.setWindowOpenHandler = handler => { this.openHandler = handler }
      window = this
    }

    async loadFile (file) { this.webContents.mainFrame.url = pathToFileURL(file).href }
    show () { this.shown = true }
    close () {
      let prevented = false
      this.emit('close', { preventDefault () { prevented = true } })
      if (!prevented) this.emit('closed')
    }

    destroy () { this.emit('closed') }
  }
  const nativeRequire = createRequire(file)
  vm.runInThisContext('(function(require,module,exports,__dirname){' + fs.readFileSync(file, 'utf8') + '\n})', { filename: file })(
    name => {
      if (name === 'electron') {
        return {
          BrowserWindow: Window,
          ipcMain: { handle: (name, handler) => handlers.set(name, handler), removeHandler: name => handlers.delete(name) }
        }
      }
      if (name === './native-password-client') {
        return {
          executeNativePassword: async (...args) => { calls.push(args); return execute(...args) }
        }
      }
      return nativeRequire(name)
    }, module, module.exports, path.dirname(file))
  let context = {
    contextId: 'a'.repeat(32),
    identity: { sid: 'S-1-5-18', account: 'NT AUTHORITY\\SYSTEM', pid: 123, sessionId: 0 }
  }
  const options = {
    parent: { isDestroyed: () => false },
    actor: { elevated: true, sid: 'S-1-5-21-1-2-3-1001', sessionId: 2 },
    helper: 'C:\\Program Files\\Anubis\\anubis-host.exe',
    serviceName: 'AnubisHost',
    getContext: () => context,
    onChanged
  }
  return {
    calls,
    handlers,
    options,
    open: () => module.exports.openNativePasswordSettings(options),
    window: () => window,
    event: () => ({ sender: window.webContents, senderFrame: window.webContents.mainFrame }),
    replaceContext: value => { context = value }
  }
}

const input = () => ({ oldPassword: 'old-fixture-password', newPassword: 'new-fixture-password', confirmPassword: 'new-fixture-password' })
const ready = () => new Promise(resolve => setImmediate(resolve))

test('non-elevated or noninteractive UI refuses before credential dialog or helper launch', async () => {
  for (const actor of [
    { elevated: false, sid: 'S-1-5-21-1-2-3-1001', sessionId: 2 },
    { elevated: true, sid: 'S-1-5-18', sessionId: 0 }
  ]) {
    const f = fixture()
    f.options.actor = actor
    assert.deepEqual(await f.open(), { ok: false, code: 'ERR_NATIVE_PASSWORD_ELEVATION_REQUIRED', committed: false })
    assert.equal(f.window(), undefined)
    assert.equal(f.calls.length, 0)
  }
})

test('native dialog binds its own main-frame file origin and rejects Web contents/frames', async () => {
  const f = fixture()
  const opened = f.open()
  await ready()
  const submit = f.handlers.get('native-password-submit')
  for (const event of [
    { sender: {}, senderFrame: {} },
    { sender: f.window().webContents, senderFrame: { url: 'https://untrusted.invalid/' } }
  ]) {
    assert.deepEqual(await submit(event, input()), { ok: false, code: 'ERR_NATIVE_PASSWORD_ADMISSION', committed: false })
  }
  assert.equal(f.calls.length, 0)
  assert.equal(f.window().options.webPreferences.nodeIntegration, false)
  assert.equal(f.window().options.webPreferences.contextIsolation, true)
  assert.equal(f.window().options.webPreferences.sandbox, true)
  assert.equal(f.window().options.webPreferences.devTools, false)
  f.window().close()
  await opened
  assert.equal(f.handlers.size, 0)
})

test('local dialog does not substitute the current user profile or stale SYSTEM generation', async () => {
  const f = fixture()
  const opened = f.open()
  await ready()
  f.replaceContext({ contextId: 'b'.repeat(32), identity: { sid: 'S-1-5-21-1-2-3-1001', sessionId: 2, pid: 456 } })
  const result = await f.handlers.get('native-password-submit')(f.event(), input())
  assert.equal(result.ok, false)
  assert.equal(f.calls.length, 0)
  f.window().close()
  await opened
})

test('only selected SYSTEM context goes to native helper and successful save clears transient input', async () => {
  let refreshes = 0
  const f = fixture(undefined, async () => { refreshes++ })
  const opened = f.open()
  await ready()
  const values = input()
  const result = await f.handlers.get('native-password-submit')(f.event(), values)
  assert.deepEqual(result, { ok: true, committed: true })
  assert.equal(refreshes, 1)
  assert.equal(f.calls.length, 1)
  assert.equal(f.calls[0][2].target, 'system')
  assert.equal(f.calls[0][2].contextId, 'a'.repeat(32))
  assert.equal(values.oldPassword, undefined)
  assert.equal(values.newPassword, undefined)
  assert.equal(values.confirmPassword, undefined)
  f.window().close()
  assert.deepEqual(await opened, { ok: true, committed: true })
})

test('refresh failure after committed update stays committed, never a false rollback', async () => {
  const f = fixture(undefined, async () => { throw new Error('refresh detail') })
  const opened = f.open()
  await ready()
  const result = await f.handlers.get('native-password-submit')(f.event(), input())
  assert.deepEqual(result, { ok: false, code: 'ERR_NATIVE_PASSWORD_COMMITTED_REFRESH_FAILED', committed: true })
  f.window().close()
  assert.deepEqual(await opened, result)
})

test('lost native outcome remains terminal and cannot resubmit or claim no commit', async () => {
  const f = fixture(async () => { throw Object.assign(new Error('private detail'), { code: 'ERR_NATIVE_PASSWORD_OUTCOME_UNKNOWN' }) })
  const opened = f.open()
  await ready()
  const submit = f.handlers.get('native-password-submit')
  const result = await submit(f.event(), input())
  assert.deepEqual(result, { ok: false, code: 'ERR_NATIVE_PASSWORD_OUTCOME_UNKNOWN' })
  assert.equal((await submit(f.event(), input())).code, 'ERR_NATIVE_PASSWORD_BUSY')
  assert.equal(f.calls.length, 1)
  f.window().close()
  await opened
})

test('actual credential UI script clears fields before IPC, never stores passwords or retries unknown outcome', async () => {
  const elements = new Map()
  const selector = name => {
    if (!elements.has(name)) {
      elements.set(name, {
        value: '',
        disabled: false,
        textContent: '',
        listeners: {},
        addEventListener (event, handler) { this.listeners[event] = handler }
      })
    }
    return elements.get(name)
  }
  let calls = 0
  const context = {
    document: { querySelector: selector },
    window: {
      nativePasswordSettings: {
        async submit (values) {
          calls++
          assert.equal(selector('#old-password').value, '')
          assert.equal(selector('#new-password').value, '')
          assert.equal(selector('#confirm-password').value, '')
          assert.equal(values.oldPassword, 'old-fixture-password')
          return { ok: false, code: 'ERR_NATIVE_PASSWORD_OUTCOME_UNKNOWN' }
        },
        close () {}
      }
    }
  }
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../../app/native-password-ui.js'), 'utf8'), context)
  selector('#old-password').value = 'old-fixture-password'
  selector('#new-password').value = selector('#confirm-password').value = 'new-fixture-password'
  const submit = selector('#password-form').listeners.submit
  await submit({ preventDefault () {} })
  assert.equal(selector('#submit').disabled, true)
  assert.equal(selector('#close').disabled, false)
  assert.match(selector('#status').textContent, /Do not retry automatically/)
  await submit({ preventDefault () {} })
  assert.equal(calls, 1)
})
