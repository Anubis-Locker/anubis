const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')
const babel = createRequire(require.resolve('@vitejs/plugin-react'))('@babel/core')

function register (mode, acknowledge) {
  let selected
  const code = babel.transformSync(fs.readFileSync(path.resolve(__dirname, '../../app/lib/machine-host-entry.js'), 'utf8'), {
    babelrc: false,
    configFile: false,
    plugins: [({ types: t }) => ({
      visitor: {
        IfStatement (value) {
          if (value.node.consequent.body?.some(item => t.isExpressionStatement(item) &&
              t.isAssignmentExpression(item.expression) && item.expression.left.name === 'nativePasswordHandler')) selected = value.node
        },
        Program: {
          exit (value) {
            assert.ok(selected)
            value.node.body = [
              t.variableDeclaration('let', [t.variableDeclarator(t.identifier('nativePasswordHandler'))]),
              selected
            ]
          }
        }
      }
    })]
  }).code
  const calls = []
  const child = {}
  const db = { dbAction () {}, compareAndSetUserConfig () {} }
  let dependencies
  let adapter
  const context = {
    invocation: { mode, contextId: 'a'.repeat(32) },
    helper: 'C:\\Protected App\\anubis-host.exe',
    process: { env: { ANUBIS_MACHINE_CONTEXT_SERVICE: 'AnubisHost' } },
    child,
    globalState: {
      set (...args) { calls.push(args) },
      update (...args) { calls.push(args) }
    },
    require (name) {
      if (name === './db') return db
      if (name === './profile-password') {
        return {
          createProfilePasswordUpdater (value) { dependencies = value; return db.dbAction }
        }
      }
      if (name === './native-password-runtime') {
        return {
          createNativePasswordHandler (value) { adapter = value; return value }
        }
      }
      if (name === './managed-auth-invalidation') {
        return {
          async awaitManagedAuthInvalidation (target, auth) {
            assert.equal(target, child)
            await acknowledge(auth)
          }
        }
      }
      throw new Error('Unexpected registration dependency')
    }
  }
  vm.runInNewContext(code, context)
  return { calls, db, dependencies, adapter }
}

test('actual host registration admits native handler only for canonical SYSTEM, never caller-profile runtime', () => {
  const user = register('user-context', async () => {})
  assert.equal(user.adapter, undefined)
  assert.equal(user.dependencies, undefined)
  const system = register('system', async () => {})
  assert.equal(system.adapter.contextId, 'a'.repeat(32))
  assert.equal(system.adapter.helper, 'C:\\Protected App\\anubis-host.exe')
  assert.equal(system.adapter.serviceName, 'AnubisHost')
  assert.equal(system.dependencies.dbAction, system.db.dbAction)
  assert.equal(system.dependencies.compareAndSetUserConfig, system.db.compareAndSetUserConfig)
  assert.equal(system.adapter.updatePassword, system.db.dbAction)
})

test('actual host invalidation wiring awaits owned-child acknowledgement before refreshing auth cache', async () => {
  let release
  const acknowledged = new Promise(resolve => { release = resolve })
  const system = register('system', () => acknowledged)
  const pending = system.dependencies.invalidateSessions({ hashedPassword: 'b'.repeat(128) })
  assert.equal(system.calls.length, 0)
  release()
  await pending
  assert.equal(system.calls[0][0], 'requireAuth')
  assert.equal(system.calls[0][1], true)
  assert.equal(system.calls[1][0], 'config')
  assert.equal(system.calls[1][1].requireAuth, 'b'.repeat(128))
})

test('actual host invalidation failure never updates cached auth state or fabricates acknowledgement', async () => {
  const system = register('system', async () => { throw new Error('fixture missing ACK') })
  await assert.rejects(system.dependencies.invalidateSessions({ hashedPassword: 'b'.repeat(128) }))
  assert.equal(system.calls.length, 0)
})
