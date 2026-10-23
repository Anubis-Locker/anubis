const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const source = fs.readFileSync(path.join(__dirname, '../../client/components/sftp/sftp-entry.jsx'), 'utf8')
const method = /initFtpData = async \(\) => \{([\s\S]*?)\r?\n {2}\}\r?\n\r?\n {2}directions =/.exec(source)
assert.ok(method, 'FTP initializer must remain covered when the component is refactored')

function initializer (createTerm, handleErr = () => {}) {
  return vm.runInNewContext(`(async function () {${method[1]}\n})`, {
    createTerm, handleErr, clone: value => ({ ...value })
  })
}

test('FTP renderer preserves the child session ID needed by managed routing', async () => {
  const calls = []
  const tab = { id: 'ftp-tab', type: 'ftp', host: '127.0.0.1', username: 'fixture' }
  let requested
  const component = {
    props: { tab },
    initData (...args) { calls.push(args) }
  }
  await initializer(async options => {
    requested = options
    return { pid: 'ftp-child-session', port: 12345 }
  }).call(component)
  assert.equal(requested.uid, tab.id)
  assert.equal(requested.tabId, tab.id)
  assert.equal(requested.termType, 'ftp')
  assert.equal(component.type, 'ftp')
  assert.equal(calls.length, 1)
  assert.equal(calls[0][0], 'ftp-child-session')
  assert.equal(calls[0][1], 12345)
})

test('FTP renderer does not open a file channel after session creation fails', async () => {
  const errors = []
  let initialized = false
  await initializer(async () => {
    throw new Error('fixture creation failure')
  }, error => errors.push(error)).call({
    props: { tab: { id: 'ftp-tab' } },
    initData () { initialized = true }
  })
  assert.equal(initialized, false)
  assert.equal(errors.length, 1)
  assert.equal(errors[0].message, 'fixture creation failure')
})
