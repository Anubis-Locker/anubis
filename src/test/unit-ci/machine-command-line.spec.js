const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

test('machine runtime selectors never reach ordinary SSH/URL command-line parsing', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../../app/lib/command-line.js'), 'utf8')
  for (const role of ['system', 'user-context']) {
    const output = { exports: {} }
    const dependencies = {
      '../common/app-props': { packInfo: { version: 'test' }, isTest: false },
      '../common/vv-file': { findVvFile () { assert.fail('Machine arguments are not connection files') } },
      '../common/brand': { cliName: 'anubis' },
      './glob-state': { get: key => key === 'machineRuntimeRole' && role }
    }
    vm.runInNewContext('(function (require, exports) {\n' + source + '\n})', {
      process: { argv: ['anubis.exe', '--anubis-context-id', 'a'.repeat(32)] }
    })(name => {
      assert.ok(Object.hasOwn(dependencies, name), 'Machine startup unexpectedly loaded ' + name)
      return dependencies[name]
    }, output.exports)
    assert.equal(output.exports.initCommandLine(), false)
  }
})
