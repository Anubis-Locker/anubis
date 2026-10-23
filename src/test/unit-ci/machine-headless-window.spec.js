const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { EventEmitter } = require('node:events')

function fixture () {
  const state = new Map()
  const calls = { geometry: 0, visible: 0, webview: 0, shortcuts: 0, backend: 0, ipc: 0, managed: 0, hidden: 0 }
  let options
  class Window extends EventEmitter {
    constructor (value) {
      super()
      options = value
      this.webContents = new EventEmitter()
      this.webContents.session = {
        setSpellCheckerDictionaryDownloadURL () {},
        async clearCache () {}
      }
    }

    async loadURL () {
      queueMicrotask(() => this.webContents.emit('dom-ready'))
    }

    hide () { calls.hidden++ }
  }
  const dependencies = {
    electron: { BrowserWindow: Window, screen: {}, app: {} },
    path,
    '../common/runtime-constants': {
      isDev: false,
      isWin: true,
      isMac: false,
      packInfo: { version: 'test' },
      minWindowWidth: 320,
      minWindowHeight: 400
    },
    '../common/default-setting': { useSystemTitleBar: true },
    './window-control': {
      async getWindowSize () {
        calls.geometry++
        return { width: 800, height: 600, x: 10, y: 20 }
      }
    },
    './window-restore': { ensureWindowVisible () { calls.visible++ }, createDisplayRefitter: () => () => {} },
    './on-close': { onClose () {} },
    './ipc': {
      async initAppServer () {
        calls.backend++
        state.set('config', { port: 40001 })
        state.set('serverChild', {})
      },
      initIpc () { calls.ipc++ }
    },
    './key-bind': { disableShortCuts () { calls.shortcuts++ } },
    './lodash.js': { debounce: fn => fn },
    './get-port': async () => 40001,
    './glob-state': state,
    './webview-handler': { init () { calls.webview++ } },
    './title-bar': { getTitleBarOptions: () => ({ frame: true }), windowBackground: '#222' },
    '../common/brand': { name: 'Anubis' },
    '../common/log': {},
    './managed-startup': { startDesktopManaged () { calls.managed++; return {} } }
  }
  const output = { exports: {} }
  const source = fs.readFileSync(path.join(__dirname, '../../app/lib/create-window.js'), 'utf8')
  vm.runInNewContext('(function (require, exports, module) {\n' + source + '\n})', {
    __dirname,
    console
  })(name => {
    assert.ok(Object.hasOwn(dependencies, name), 'Unexpected dependency: ' + name)
    return dependencies[name]
  }, output.exports, output)
  return { create: output.exports.createWindow, state, calls, options: () => options }
}

test('dedicated headless workspace owns its backend without desktop geometry, shortcuts or visible UI', async () => {
  const value = fixture()
  const win = await value.create({}, { headless: true, managed: false })
  const options = value.options()
  assert.equal(options.show, false)
  assert.equal(options.frame, false)
  assert.equal(options.webPreferences.offscreen, true)
  assert.equal(options.webPreferences.backgroundThrottling, false)
  assert.equal(options.webPreferences.devTools, false)
  assert.equal(value.state.get('headlessRuntime'), true)
  assert.equal(value.state.get('systemTitleBar'), false)
  assert.deepEqual(value.calls, {
    geometry: 0, visible: 0, webview: 0, shortcuts: 0, backend: 1, ipc: 1, managed: 0, hidden: 0
  })
  let prevented = 0
  win.emit('close', { preventDefault () { prevented++ } })
  assert.equal(prevented, 1)
  win.emit('show')
  assert.equal(value.calls.hidden, 1)
  value.state.set('machineStopping', true)
  win.emit('close', { preventDefault () { prevented++ } })
  assert.equal(prevented, 1)
})

test('ordinary desktop window retains visible geometry, browser setup and its existing managed lifecycle', async () => {
  const value = fixture()
  await value.create({})
  await new Promise(resolve => setImmediate(resolve))
  const options = value.options()
  assert.equal(options.show, true)
  assert.equal(options.frame, true)
  assert.equal(options.width, 800)
  assert.equal(options.x, 10)
  assert.equal(options.webPreferences.offscreen, undefined)
  assert.equal(options.webPreferences.webviewTag, true)
  assert.equal(value.state.get('headlessRuntime'), false)
  assert.deepEqual(value.calls, {
    geometry: 1, visible: 1, webview: 1, shortcuts: 1, backend: 1, ipc: 1, managed: 1, hidden: 0
  })
})
