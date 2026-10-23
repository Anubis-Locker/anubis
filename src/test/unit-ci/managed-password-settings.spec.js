const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')
const rendererRequire = createRequire(require.resolve('@vitejs/plugin-react'))
const babel = rendererRequire('@babel/core')
const { createBrowserRpc } = require('../../app/lib/managed-browser-rpc')

function fixture (runGlobalAsync, requireAuth = true) {
  const source = fs.readFileSync(path.join(__dirname, '../../client/components/setting-panel/setting-common.jsx'), 'utf8')
  const { code } = babel.transformSync(source, {
    babelrc: false,
    configFile: false,
    parserOpts: { plugins: ['jsx'] },
    plugins: [({ types: t }) => ({
      visitor: {
        Program (program) {
          const declaration = program.node.body.find(node => t.isExportDefaultDeclaration(node)).declaration
          const handler = declaration.body.body.find(node => node.key?.name === 'handleLoginSubmit')
          assert.ok(t.isArrowFunctionExpression(handler.value) && handler.value.async)
          program.node.body = [
            t.expressionStatement(t.assignmentExpression('=',
              t.memberExpression(t.identifier('module'), t.identifier('exports')),
              t.functionExpression(null, handler.value.params, handler.value.body, false, true)))
          ]
        }
      }
    })]
  })
  const notifications = []
  const window = { pre: { runGlobalAsync, requireAuth } }
  const context = {
    module: { exports: {} },
    window,
    delay: async () => {},
    e: key => key,
    message: {
      success: value => notifications.push({ success: value }),
      error: value => notifications.push({ error: value })
    }
  }
  vm.runInNewContext(code, context)
  const instance = {
    submitting: false,
    state: { loginPass: 'new-profile-password', submittingPass: false, placeholderLogin: '********' },
    setState (update, callback) {
      Object.assign(this.state, update)
      callback?.()
    }
  }
  return {
    instance,
    window,
    notifications,
    submit: () => context.module.exports.call(instance)
  }
}

test('actual Settings handler reports forbidden browser password changes and remains retryable', async () => {
  let passwordWrites = 0
  const rpc = createBrowserRpc({
    functions: { setPassword: async () => { passwordWrites++; return true } },
    getConfig: () => ({}),
    getPassword: async () => ({ hashedPassword: 'existing-profile-hash' }),
    constants: () => ({}),
    init: async () => ({ config: {} })
  })
  const f = fixture((name, ...args) => rpc(name, args))
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.doesNotReject(f.submit())
    assert.equal(f.instance.submitting, false)
    assert.equal(f.instance.state.submittingPass, false)
    assert.equal(f.instance.state.loginPass, 'new-profile-password')
    assert.equal(f.window.pre.requireAuth, true)
  }
  assert.equal(passwordWrites, 0)
  assert.equal(f.notifications.length, 2)
  assert.ok(f.notifications.every(value => /Unsupported managed browser function: setPassword/.test(value.error)))
})

test('successful native password changes retain their existing behavior', async () => {
  const calls = []
  const f = fixture(async (...args) => { calls.push(args); return true }, false)
  await f.submit()
  assert.deepEqual(calls, [['setPassword', 'new-profile-password']])
  assert.equal(f.window.pre.requireAuth, true)
  assert.equal(f.instance.state.loginPass, '********')
  assert.equal(f.instance.state.placeholderLogin, '********')
  assert.equal(f.instance.submitting, false)
  assert.equal(f.instance.state.submittingPass, false)
  assert.deepEqual(f.notifications, [{ success: 'OK' }])
})

test('native password removal updates authentication only after success', async () => {
  const f = fixture(async () => true)
  f.instance.state.loginPass = ''
  await f.submit()
  assert.equal(f.window.pre.requireAuth, false)
  assert.equal(f.instance.state.loginPass, '')
  assert.equal(f.instance.state.placeholderLogin, 'notSet')
  assert.equal(f.instance.submitting, false)
})

test('negative or malformed native results report failure without changing authentication', async () => {
  for (const result of [false, undefined, null, { ok: true }]) {
    const f = fixture(async () => result)
    await f.submit()
    assert.equal(f.window.pre.requireAuth, true)
    assert.equal(f.instance.state.loginPass, 'new-profile-password')
    assert.equal(f.instance.submitting, false)
    assert.equal(f.instance.state.submittingPass, false)
    assert.deepEqual(f.notifications, [{ error: 'Failed to update the login password' }])
  }
})

test('an in-flight request still prevents duplicate submissions', async () => {
  let release
  let calls = 0
  const pending = new Promise(resolve => { release = resolve })
  const f = fixture(async () => { calls++; return pending })
  const first = f.submit()
  await f.submit()
  assert.equal(calls, 1)
  assert.equal(f.instance.submitting, true)
  release(true)
  await first
  assert.equal(f.instance.submitting, false)
})
