const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

async function fixture (answer) {
  const window = {}
  const invokes = []
  const elements = new Map()
  const app = path.resolve(__dirname, '../../app')
  vm.runInNewContext(fs.readFileSync(path.join(app, 'preload', 'machine-client.js'), 'utf8'), {
    require (name) {
      assert.equal(name, 'electron')
      return {
        contextBridge: { exposeInMainWorld (key, value) { window[key] = value } },
        ipcRenderer: {
          on () {},
          async invoke (...args) {
            invokes.push(args)
            return args[0] === 'machine-client-list' ? { ok: false, code: 'FIXTURE_NO_CONNECT' } : answer
          }
        }
      }
    }
  })
  vm.runInNewContext(fs.readFileSync(path.join(app, 'machine-client-ui.js'), 'utf8'), {
    window,
    document: {
      querySelector (id) {
        if (!elements.has(id)) {
          elements.set(id, {
            disabled: false,
            addEventListener (name, handler) { this[name] = handler }
          })
        }
        return elements.get(id)
      }
    }
  })
  await new Promise(resolve => setImmediate(resolve))
  return { invokes, elements }
}

test('actual native shell button/preload sends only a local password-settings intent, never credentials', async () => {
  const f = await fixture({ ok: true })
  const button = f.elements.get('#system-password')
  await button.click()
  const invocation = f.invokes.find(value => value[0] === 'machine-client-password-settings')
  assert.equal(invocation.length, 1)
  assert.equal(button.disabled, false)
  assert.match(f.elements.get('#password-status').textContent, /after restart/)
})

test('actual native shell never labels committed invalidation failure as successful save or permits automatic retry', async () => {
  const f = await fixture({ ok: false, committed: true, code: 'ERR_NATIVE_PASSWORD_COMMITTED_INVALIDATION_FAILED' })
  await f.elements.get('#system-password').click()
  assert.match(f.elements.get('#password-status').textContent, /Do not repeat/)
  assert.match(f.elements.get('#password-status').textContent, /COMMITTED_INVALIDATION_FAILED/)
  assert.equal(f.invokes.filter(value => value[0] === 'machine-client-password-settings').length, 1)
})
