const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const closeForUpgrade = require('../../app/lib/upgrade-close')

function fixture () {
  const state = { closeAction: '', win: null }
  const events = []
  const win = {
    isDestroyed: () => false,
    close: () => events.push({ action: 'close', closeAction: state.closeAction })
  }
  state.win = win
  return {
    state,
    events,
    win,
    globalState: {
      get: key => state[key],
      set: (key, value) => { state[key] = value }
    }
  }
}

test('Windows installer launch requests normal close with exit confirmation enabled', () => {
  const f = fixture()
  f.state.config = { confirmBeforeExit: true }
  closeForUpgrade({ upgradeInstallerLaunched: true }, true, f.globalState)
  assert.deepEqual(f.events, [{ action: 'close', closeAction: 'closeApp' }])
  assert.equal(f.state.config.confirmBeforeExit, true)
  assert.equal(f.state.win, f.win)
})

test('ignores other worker messages, unsuccessful launch and other platforms', () => {
  const f = fixture()
  for (const message of [undefined, null, {}, { showFileInFolder: 'installer.exe' }, { upgradeInstallerLaunched: false }, { upgradeInstallerLaunched: 'true' }]) {
    closeForUpgrade(message, true, f.globalState)
  }
  closeForUpgrade({ upgradeInstallerLaunched: true }, false, f.globalState)
  assert.deepEqual(f.events, [])
  assert.equal(f.state.closeAction, '')
})

test('does not close a missing or destroyed window', () => {
  const f = fixture()
  f.state.win = null
  closeForUpgrade({ upgradeInstallerLaunched: true }, true, f.globalState)
  f.state.win = f.win
  f.win.isDestroyed = () => true
  closeForUpgrade({ upgradeInstallerLaunched: true }, true, f.globalState)
  assert.deepEqual(f.events, [])
})

test('production onClose can veto update closure without stopping the worker', async () => {
  const f = fixture()
  f.state.config = { confirmBeforeExit: true }
  f.state.childPid = 123
  let prevented = 0
  let pending
  f.win.webContents = { send: (...args) => f.events.push(args) }
  const module = { exports: {} }
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../../app/lib/on-close.js'), 'utf8'), {
    exports: module.exports,
    require: name => ({
      './db': { dbAction: assert.fail },
      '../common/log': { debug: assert.fail },
      './glob-state': f.globalState
    })[name],
    process: { kill: assert.fail, on: assert.fail },
    clearTimeout: assert.fail
  })
  f.win.close = () => {
    pending = module.exports.onClose({ preventDefault: () => { prevented++ } })
  }
  closeForUpgrade({ upgradeInstallerLaunched: true }, true, f.globalState)
  await pending
  assert.equal(prevented, 1)
  assert.deepEqual(f.events, [['confirm-exit', 'closeApp']])
  assert.equal(f.state.win, f.win)
  assert.equal(f.state.childPid, 123)
  assert.equal(f.state.config.confirmBeforeExit, true)
})
