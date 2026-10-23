const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')
const { pathToFileURL } = require('node:url')
const babel = createRequire(require.resolve('@vitejs/plugin-react'))('@babel/core')

function extract (name, context) {
  const file = path.resolve(__dirname, '../../app/lib/machine-client-entry.js')
  let selected
  const { code } = babel.transformSync(fs.readFileSync(file, 'utf8'), {
    babelrc: false,
    configFile: false,
    plugins: [({ types: t }) => ({
      visitor: {
        VariableDeclarator (value) {
          if (value.node.id.name === name) selected = value.node.init
        },
        CallExpression (value) {
          const node = value.node
          if (t.isMemberExpression(node.callee) && node.callee.object.name === 'ipcMain' &&
              node.callee.property.name === 'handle' && node.arguments[0]?.value === name) selected = node.arguments[1]
        },
        Program: {
          exit (program) {
            assert.ok(selected)
            program.node.body = [t.expressionStatement(t.assignmentExpression('=',
              t.memberExpression(t.identifier('module'), t.identifier('exports')), selected))]
          }
        }
      }
    })]
  })
  context.module = { exports: {} }
  vm.runInNewContext(code, context)
  return context.module.exports
}

function fixture () {
  const calls = []
  let callback
  let credentialDialogs = 0
  const dirname = path.resolve(__dirname, '../../app/lib')
  const win = { webContents: { mainFrame: { url: pathToFileURL(path.resolve(dirname, '../machine-client.html')).href } } }
  const context = {
    __dirname: dirname,
    path,
    process: { execPath: 'C:\\Protected App\\anubis.exe' },
    Buffer,
    actor: { elevated: false, sid: 'S-1-5-21-1-2-3-1001', sessionId: 2, systemDirectory: 'C:\\Windows\\System32' },
    serviceName: 'AnubisHost',
    instanceData: { version: 1, argv: [], cwd: 'C:\\' },
    helper: 'C:\\Protected App\\anubis-host.exe',
    intents: [],
    intentBusy: false,
    enqueuing: 0,
    elevationPending: false,
    passwordSettingsPending: false,
    win,
    app: {
      releaseSingleInstanceLock () { calls.push({ phase: 'release' }) },
      requestSingleInstanceLock () { calls.push({ phase: 'reclaim' }); return true },
      quit () { calls.push({ phase: 'quit' }) }
    },
    failure: code => ({ ok: false, code }),
    quoteWindowsArgument: value => '"' + value + '"',
    execFile (file, args, options, done) {
      calls.push({ phase: 'spawn', file, args, options })
      callback = done
    },
    dialog: {
      async showMessageBox (parent, options) { calls.push({ phase: 'confirm', options }); return { response: 0 } }
    },
    trusted: event => event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame,
    require (name) {
      if (name === 'node:url') return require(name)
      if (name === './native-password-settings') {
        return {
          async openNativePasswordSettings () { credentialDialogs++; return { ok: true } }
        }
      }
      throw new Error('Unexpected fixture dependency')
    }
  }
  context.elevateClient = extract('elevateClient', context)
  const open = extract('machine-client-password-settings', context)
  return {
    context,
    calls,
    open: () => open({ sender: win.webContents, senderFrame: win.webContents.mainFrame }),
    release: error => callback(error),
    credentialDialogs: () => credentialDialogs
  }
}

test('asInvoker SYSTEM password action explicitly requests UAC before any credential entry and reuses same singleton flow', async () => {
  const f = fixture()
  const pending = f.open()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.credentialDialogs(), 0)
  assert.deepEqual(f.calls.map(value => value.phase), ['confirm', 'release', 'spawn'])
  const spawn = f.calls.find(value => value.phase === 'spawn')
  const script = Buffer.from(spawn.args.at(-1), 'base64').toString('utf16le')
  assert.match(script, /Start-Process/)
  assert.match(script, /-Verb RunAs/)
  assert.match(script, /--anubis-machine-client/)
  assert.match(script, /--anubis-service-name/)
  assert.ok(!script.includes('Password') && !script.includes('password'))
  assert.equal(spawn.options.windowsHide, true)
  assert.equal(spawn.options.shell, false)
  assert.equal(spawn.file, path.join('C:\\Windows\\System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'))
  assert.equal(f.context.passwordSettingsPending, true)
  assert.equal((await f.open()).code, 'ERR_NATIVE_PASSWORD_BUSY')
  f.release(null)
  assert.equal((await pending).ok, true)
  assert.deepEqual(f.calls.map(value => value.phase), ['confirm', 'release', 'spawn', 'quit'])
  assert.equal(f.context.passwordSettingsPending, false)
})

test('cancelled UAC reclaims the existing singleton rather than starting a conflicting client or credential form', async () => {
  const f = fixture()
  const pending = f.open()
  await new Promise(resolve => setImmediate(resolve))
  f.release(new Error('cancelled'))
  assert.equal((await pending).code, 'ERR_HOST_ELEVATION_CANCELLED')
  assert.deepEqual(f.calls.map(value => value.phase), ['confirm', 'release', 'spawn', 'reclaim'])
  assert.equal(f.credentialDialogs(), 0)
  assert.equal(f.context.elevationPending, false)
})

test('password UAC flow never forwards pending connection arguments or credentials', async () => {
  const f = fixture()
  f.context.intents.push({ args: ['--password', 'synthetic-connection-secret'], cwd: 'C:\\fixture' })
  assert.equal((await f.open()).code, 'ERR_NATIVE_PASSWORD_BUSY')
  assert.ok(!f.calls.some(value => value.phase === 'spawn' || value.phase === 'release'))
  assert.equal(f.credentialDialogs(), 0)
})

test('elevation cancellation before UAC leaves singleton and credentials untouched', async () => {
  const f = fixture()
  f.context.dialog.showMessageBox = async () => ({ response: 1 })
  const result = await f.open()
  assert.equal(result.code, 'ERR_NATIVE_PASSWORD_CANCELLED')
  assert.equal(result.committed, false)
  assert.deepEqual(f.calls, [])
  assert.equal(f.credentialDialogs(), 0)
})

test('shell origin mismatch cannot request UAC or open password form even in its own main frame', async () => {
  const f = fixture()
  f.context.win.webContents.mainFrame.url = 'https://fixture.invalid/'
  assert.equal((await f.open()).code, 'ERR_NATIVE_PASSWORD_ADMISSION')
  assert.deepEqual(f.calls, [])
  assert.equal(f.credentialDialogs(), 0)
})

test('existing normal elevation still forwards its single connection intent, but overlapping UAC cannot start', async () => {
  const f = fixture()
  f.context.intents.push({ args: ['fixture-connection'], cwd: 'C:\\fixture' })
  const pending = f.context.elevateClient()
  assert.equal((await f.context.elevateClient()).code, 'ERR_NATIVE_PASSWORD_BUSY')
  const spawn = f.calls.find(value => value.phase === 'spawn')
  const script = Buffer.from(spawn.args.at(-1), 'base64').toString('utf16le')
  assert.match(script, /fixture-connection/)
  assert.match(script, /-WorkingDirectory 'C:\\fixture'/)
  f.release(null)
  assert.equal((await pending).ok, true)
})

test('failed singleton reclamation quits the old instance instead of continuing without its lock', async () => {
  const f = fixture()
  f.context.app.requestSingleInstanceLock = () => false
  const pending = f.context.elevateClient(true)
  f.release(new Error('cancelled'))
  assert.equal((await pending).code, 'ERR_HOST_ELEVATION_CANCELLED')
  assert.equal(f.calls.at(-1).phase, 'quit')
})
