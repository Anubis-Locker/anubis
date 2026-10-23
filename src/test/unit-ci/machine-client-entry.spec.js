const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const { EventEmitter } = require('node:events')
const host = require('../../app/lib/windows-host-client')
const { createMachineConnection } = require('../../app/lib/machine-client-connection')

async function fixture (t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'anubis-machine-client-main-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const handlers = new Map()
  const timers = new Map()
  const messages = []
  const requests = []
  const dialogs = []
  const opened = []
  const elevations = []
  const calls = { checks: 0, downloads: 0, preparations: 0, launches: 0, quits: 0 }
  let sessions = [{ id: 2, sid: 'S-1-5-21-111-222-333-1001', account: 'MACHINE\\user', state: 0 }]
  const app = Object.assign(new EventEmitter(), {
    setName () {},
    setPath () {},
    getPath: () => root,
    getVersion: () => '5.6.12',
    requestSingleInstanceLock: () => true,
    releaseSingleInstanceLock () {},
    whenReady: async () => {},
    quit () { calls.quits++ }
  })
  class Contents extends EventEmitter {
    constructor () {
      super()
      this.mainFrame = {}
      this.destroyed = false
      this.session = { webRequest: { onBeforeSendHeaders () {} } }
    }

    send (channel, value) {
      messages.push({ channel, value })
    }

    isDestroyed () { return this.destroyed }
    setWindowOpenHandler () {}
    async loadURL () {}
    async executeJavaScript (script) {
      return vm.runInNewContext(script, {
        window: {
          et: { wsOpened: options.rendererReady !== false },
          store: {
            initLoadingData: options.rendererReady === false,
            ipcOpenTab: tab => { opened.push({ kind: 'tab', tab }) },
            addTabFromCommandLine: (_event, payload) => { opened.push({ kind: 'cli', payload }) }
          }
        }
      })
    }

    close () { this.destroyed = true }
  }
  class Window extends EventEmitter {
    constructor () {
      super()
      this.webContents = new Contents()
      this.contentView = { addChildView () {}, removeChildView () {} }
    }

    isDestroyed () { return false }
    getContentSize () { return [1280, 840] }
    async loadFile () {}
    isMinimized () { return false }
    focus () {}
  }
  class View {
    constructor () { this.webContents = new Contents() }
    setBounds () {}
  }
  const sourceDir = path.resolve(__dirname, '../../app/lib')
  const source = fs.readFileSync(path.join(sourceDir, 'machine-client-entry.js'), 'utf8')
  const output = { exports: {} }
  const dependencies = {
    'node:fs': fs,
    'node:path': path,
    'node:crypto': require('node:crypto'),
    'node:child_process': {
      execFile (_file, args, _options, callback) {
        assert.equal(_file, path.join('C:\\Windows\\System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'))
        elevations.push(Buffer.from(args.at(-1), 'base64').toString('utf16le'))
        callback(options.elevationError ? new Error('Cancelled') : null)
      },
      execFileSync (_helper, args) {
        return JSON.stringify(args[0] === 'identity'
          ? {
              sid: 'S-1-5-21-111-222-333-1001',
              sessionId: 2,
              elevated: options.elevated !== false,
              systemDirectory: 'C:\\Windows\\System32'
            }
          : { valid: true })
      }
    },
    './windows-host-client': {
      ...host,
      readInstallerMarker: () => ({ version: 1, serviceName: options.serviceName || 'AnubisHost' }),
      async requestHost (_helper, _service, request) {
        requests.push(request)
        if (request.operation === 'list-sessions') return sessions
        return {
          contextId: 'a'.repeat(32),
          identity: { ...sessions[0], pid: 1234, sessionId: 2, elevated: true },
          endpoint: { localPort: 40001, privateProof: 'b'.repeat(64) }
        }
      },
      async prepareWindowsUpdate () { calls.preparations++; return 'protected-installer.exe' },
      async launchPreparedWindowsUpdate (file) {
        assert.equal(file, 'protected-installer.exe')
        calls.launches++
        if (options.launchError) throw Object.assign(new Error('launch refused'), { code: 'ERR_HOST_UPDATE_LAUNCH' })
      }
    },
    './machine-host-entry': { cleanRuntimeEnvironment () {} },
    './machine-client-intent': require('../../app/lib/machine-client-intent'),
    './machine-client-connection': {
      createMachineConnection: config => createMachineConnection({
        ...config,
        schedule (callback) { const id = Symbol('timer'); timers.set(id, callback); return id },
        cancel: id => timers.delete(id)
      })
    },
    './machine-client-update': {
      async checkMachineUpdate () {
        calls.checks++
        if (options.check) return options.check()
        return { available: options.available !== false, version: '5.6.13' }
      },
      async installMachineUpdate (update, config) {
        calls.downloads++
        const protectedFile = await config.prepare('user-temp-installer.exe', update)
        await config.launch(protectedFile)
      }
    },
    '../common/brand': { id: 'anubis', cliName: 'anubis', name: 'Anubis-Security-Tool', data: { dirName: 'fixture' } },
    electron: {
      app,
      BrowserWindow: Window,
      WebContentsView: View,
      ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
      shell: { openExternal: async () => {} },
      dialog: {
        async showMessageBox (_win, value) {
          dialogs.push(value)
          if (options.confirm) await options.confirm(value)
          return { response: options.cancel ? 1 : 0 }
        }
      }
    }
  }
  vm.runInNewContext('(function (require, module) {\n' + source + '\n})', {
    __dirname: sourceDir,
    process: {
      argv: [path.join(root, 'anubis.exe'), ...(options.args || [])],
      execPath: path.join(root, 'anubis.exe'),
      env: { SystemRoot: 'C:\\untrusted-environment' },
      cwd: () => root
    },
    AbortController,
    Buffer
  })(name => {
    assert.ok(Object.hasOwn(dependencies, name), 'Unexpected dependency: ' + name)
    return dependencies[name]
  }, output)
  const client = await output.exports.startMachineClient()
  t.after(() => client.win.emit('closed'))
  const event = { sender: client.win.webContents, senderFrame: client.win.webContents.mainFrame }
  return {
    ...client,
    event,
    calls,
    messages,
    requests,
    timers,
    handlers,
    opened,
    dialogs,
    elevations,
    async secondInstance (args, rawArgs) {
      const argv = [path.join(root, 'anubis.exe'), ...args]
      await app.listeners('second-instance')[0]({}, rawArgs || argv, root, { version: 1, argv, cwd: root })
    },
    sessions: values => { sessions = values },
    invoke: (name, ...args) => handlers.get('machine-client-' + name)(event, ...args)
  }
}

test('only the trusted toolbar can check/install updates and a confirmed protected launch closes the GUI', async t => {
  const f = await fixture(t)
  assert.equal((await f.handlers.get('machine-client-update')({ sender: {} })).code, 'ERR_HOST_CLIENT_ORIGIN')
  assert.equal(f.calls.checks, 0)
  const result = await f.invoke('update', { url: 'https://untrusted.invalid/payload.exe' })
  assert.equal(result.ok, true)
  assert.equal(result.phase, 'launched')
  assert.deepEqual(f.calls, { checks: 1, downloads: 1, preparations: 1, launches: 1, quits: 1 })
})

test('no-update, declined update, non-elevated caller, QA edition and installer launch failure never close the GUI', async t => {
  for (const options of [
    { available: false }, { cancel: true }, { elevated: false },
    { serviceName: 'AnubisHost-QA-installer-7e66c0f5' }, { launchError: true }
  ]) {
    const f = await fixture(t, options)
    const result = await f.invoke('update')
    assert.equal(f.calls.quits, 0)
    if (options.launchError) {
      assert.equal(result.code, 'ERR_HOST_UPDATE_LAUNCH')
    } else {
      assert.equal(f.calls.downloads, 0)
    }
  }
})

test('duplicate update requests are rejected while a feed check is in flight', async t => {
  let release
  const f = await fixture(t, { check: () => new Promise(resolve => { release = resolve }) })
  const first = f.invoke('update')
  assert.equal((await f.invoke('update')).code, 'ERR_HOST_UPDATE_BUSY')
  release({ available: false })
  assert.equal((await first).phase, 'current')
})

test('user reconnect pins actual WTS SID and refuses a reused session before launch-context', async t => {
  const f = await fixture(t)
  assert.equal((await f.invoke('list')).ok, true)
  assert.equal((await f.invoke('connect', { target: 'user', sessionId: 2 })).ok, true)
  const launched = f.requests.filter(value => value.operation === 'launch-context').length
  f.sessions([{ id: 2, sid: 'S-1-5-21-999-888-777-1001', account: 'MACHINE\\different-user', state: 0 }])
  const [id, callback] = f.timers.entries().next().value
  f.timers.delete(id)
  await callback()
  assert.equal(f.requests.filter(value => value.operation === 'launch-context').length, launched)
  assert.equal(f.getContext(), null)
  assert.equal(f.messages.at(-1).value.code, 'ERR_HOST_CONTEXT_IDENTITY')
  assert.equal(f.timers.size, 0)
})

test('cold and second-instance links stay private and require explicit confirmation in the selected Windows account', async t => {
  const f = await fixture(t, { args: ['ssh://alice:synthetic-ticket@example.invalid'] })
  assert.equal(f.opened.length, 0)
  assert.equal((await f.invoke('intent')).code, 'ERR_HOST_INTENT_CONTEXT')
  assert.equal((await f.handlers.get('machine-client-intent')({ sender: {} })).code, 'ERR_HOST_CLIENT_ORIGIN')
  await f.invoke('list')
  await f.invoke('connect', { target: 'user', sessionId: 2 })
  assert.equal((await f.invoke('intent')).phase, 'opened')
  assert.equal(f.opened[0].payload.argv[0], 'ssh://alice:synthetic-ticket@example.invalid')
  assert.match(f.dialogs.at(-1).detail, /S-1-5-21-111-222-333-1001, session 2/)
  assert.equal(JSON.stringify(f.messages).includes('synthetic-ticket'), false)
  assert.equal(JSON.stringify(f.dialogs).includes('synthetic-ticket'), false)
  await f.secondInstance(['vnc://127.0.0.1:5902'], ['anubis.exe', '--chromium-added-flag=1'])
  assert.equal((await f.invoke('list')).pending, 1)
  assert.equal((await f.invoke('intent')).phase, 'opened')
  assert.equal(f.opened.length, 2)
  assert.equal((await f.invoke('list')).pending, 0)
})

test('locked views and declined requests do not open a connection or start another account', async t => {
  for (const options of [{ rendererReady: false }, { cancel: true }]) {
    const f = await fixture(t, { ...options, args: ['vnc://127.0.0.1:5902'] })
    await f.invoke('list')
    await f.invoke('connect', { target: 'user', sessionId: 2 })
    const result = await f.invoke('intent')
    assert.equal(f.opened.length, 0)
    assert.equal(f.requests.filter(request => request.operation === 'launch-context').length, 1)
    assert.equal(options.cancel ? result.phase : result.code,
      options.cancel ? 'cancelled' : 'ERR_HOST_INTENT_LOGIN')
    assert.equal((await f.invoke('list')).pending, options.cancel ? 0 : 1)
    await f.invoke('intent-clear')
    assert.equal((await f.invoke('list')).pending, 0)
  }
})

test('a context replacement during the native connection prompt never receives the old request', async t => {
  const f = await fixture(t, {
    args: ['ssh://alice@example.invalid'],
    confirm: async () => {
      await f.invoke('connect', { target: 'user', sessionId: 2 })
    }
  })
  await f.invoke('list')
  await f.invoke('connect', { target: 'user', sessionId: 2 })
  assert.equal((await f.invoke('intent')).code, 'ERR_HOST_CONTEXT_REPLACED')
  assert.equal(f.opened.length, 0)
  assert.equal((await f.invoke('list')).pending, 1)
})

test('UAC forwards a single original request using quoted arguments, retains cancelled requests and refuses ambiguous batches', async t => {
  const args = ['ssh://alice@example.invalid', '--title', 'quoted "title" with spaces\\']
  const f = await fixture(t, { args, elevated: false })
  assert.equal((await f.invoke('elevate')).ok, true)
  assert.equal(f.elevations.length, 1)
  assert.match(f.elevations[0], /-Verb RunAs/)
  assert.match(f.elevations[0], /-WorkingDirectory/)
  const argumentText = f.elevations[0].match(/-ArgumentList '((?:''|[^'])*)'/)[1].replace(/''/g, "'")
  assert.equal(argumentText, ['--anubis-machine-client', '--anubis-service-name', 'AnubisHost', ...args]
    .map(require('../../app/lib/machine-client-intent').quoteWindowsArgument).join(' '))
  assert.equal(f.calls.quits, 1)
  const cancelled = await fixture(t, { args, elevated: false, elevationError: true })
  assert.equal((await cancelled.invoke('elevate')).code, 'ERR_HOST_ELEVATION_CANCELLED')
  assert.equal((await cancelled.invoke('list')).pending, 1)
  assert.equal(cancelled.calls.quits, 0)
  await cancelled.secondInstance(['vnc://127.0.0.1:5902'])
  assert.equal((await cancelled.invoke('elevate')).code, 'ERR_HOST_INTENT_MULTIPLE')
  assert.equal(cancelled.elevations.length, 1)
})
