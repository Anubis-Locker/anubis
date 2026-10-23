const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const vm = require('node:vm')
const shell = require('shelljs')
const { createRequire } = require('node:module')
const babel = createRequire(require.resolve('@vitejs/plugin-react'))('@babel/core')

test('actual package-preparation copy stages every new native dialog/preload/runtime file byte-for-byte without a build', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'anubis-native-staging-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const source = path.resolve(__dirname, '../../app')
  fs.mkdirSync(path.join(root, 'work'))
  const files = [
    ['lib', 'profile-password.js'],
    ['lib', 'managed-auth-invalidation.js'],
    ['lib', 'native-password-client.js'],
    ['lib', 'native-password-runtime.js'],
    ['lib', 'native-password-settings.js'],
    ['preload', 'native-password.js'],
    ['native-password.html'],
    ['native-password-ui.js']
  ]
  for (const parts of files) {
    const destination = path.join(root, 'src', 'app', ...parts)
    fs.mkdirSync(path.dirname(destination), { recursive: true })
    fs.copyFileSync(path.join(source, ...parts), destination)
  }
  let selected
  const { code } = babel.transformSync(fs.readFileSync(path.resolve(__dirname, '../../build/bin/prepare.js'), 'utf8'), {
    babelrc: false,
    configFile: false,
    plugins: [() => ({
      visitor: {
        ExpressionStatement (value) {
          const node = value.node.expression
          if (node.type === 'CallExpression' && node.callee.name === 'cp' &&
              node.arguments[1]?.value === 'src/app') selected = value.node
        },
        Program: {
          exit (value) {
            assert.ok(selected)
            value.node.body = [selected]
          }
        }
      }
    })]
  })
  vm.runInNewContext(code, {
    cp (flags, from, to) {
      const result = shell.cp(flags, path.resolve(root, from), path.resolve(root, to))
      assert.equal(result.code, 0)
    }
  })
  for (const parts of files) {
    assert.deepEqual(fs.readFileSync(path.join(root, 'work', 'app', ...parts)), fs.readFileSync(path.join(source, ...parts)))
  }
})
