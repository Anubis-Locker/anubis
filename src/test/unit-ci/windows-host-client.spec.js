const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const { EventEmitter } = require('node:events')
const {
  serviceNameFromArgs, readInstallerMarker, validateDescriptor, isContextUrl, publicContext
} = require('../../app/lib/windows-host-client')

function descriptor () {
  return {
    contextId: 'a'.repeat(32),
    identity: { pid: 1234, sid: 'S-1-5-18', sessionId: 0, account: 'NT AUTHORITY\\SYSTEM', elevated: true },
    endpoint: { localPort: 40001, privateProof: 'b'.repeat(64) }
  }
}

test('GUI selects only the production service or explicit isolated QA namespace', () => {
  assert.equal(serviceNameFromArgs([]), 'AnubisHost')
  assert.equal(serviceNameFromArgs(['--anubis-service-name', 'AnubisHost-QA-abc123']), 'AnubisHost-QA-abc123')
  for (const args of [
    ['--anubis-service-name'], ['--anubis-service-name', 'another-service'],
    ['--anubis-service-name', 'AnubisHost', '--anubis-service-name', 'AnubisHost-QA-other']
  ]) assert.throws(() => serviceNameFromArgs(args))
})

test('installer marker selects its exact service and rejects unsupported or oversized configuration', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anubis-client-marker-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'anubis-machine-install.json')
  assert.equal(readInstallerMarker(dir), null)
  const marker = { version: 1, serviceName: 'AnubisHost-QA-installer-7e66c0f5' }
  fs.writeFileSync(file, JSON.stringify(marker))
  assert.deepEqual(readInstallerMarker(dir), marker)
  assert.equal(serviceNameFromArgs([], marker), marker.serviceName)
  assert.equal(serviceNameFromArgs(['--anubis-service-name', 'AnubisHost'], marker), 'AnubisHost')
  for (const value of [
    'null', '[]', '{}', '{', JSON.stringify({ ...marker, version: 2 }),
    JSON.stringify({ ...marker, serviceName: 'another-service' }),
    JSON.stringify({ ...marker, executable: 'untrusted.exe' }),
    ' '.repeat(1025)
  ]) {
    fs.writeFileSync(file, value)
    assert.throws(() => readInstallerMarker(dir), { code: 'ERR_HOST_INSTALL_MARKER' })
  }
})

test('GUI validates actual SYSTEM/user descriptor identity rather than trusting a selected label', () => {
  const value = descriptor()
  value.identity.extraSecret = value.endpoint.privateProof
  assert.equal(validateDescriptor(value, { target: 'system' }), value)
  value.identity.sid = 'S-1-5-21-111-222-333-1001'
  value.identity.account = 'MACHINE\\user'
  value.identity.sessionId = 2
  assert.throws(() => validateDescriptor(value, { target: 'system' }))
  assert.equal(validateDescriptor(value, { target: 'user', sessionId: 2 }, value.identity.sid), value)
  assert.throws(() => validateDescriptor(value, { target: 'user', sessionId: 3 }, value.identity.sid))
  assert.throws(() => validateDescriptor(value, { target: 'user', sessionId: 2 }, 'S-1-5-21-999-888-777-1001'))
})

test('GUI never publishes private endpoint/proof into toolbar renderer state', () => {
  const value = descriptor()
  value.identity.extraSecret = value.endpoint.privateProof
  const result = publicContext(value)
  assert.deepEqual(Object.keys(result).sort(), ['contextId', 'identity'])
  assert.equal(JSON.stringify(result).includes(value.endpoint.privateProof), false)
  assert.equal(JSON.stringify(result).includes('endpoint'), false)
})

test('transport proof matches only exact loopback HTTP/WebSocket origin, not redirects or URL credentials', () => {
  assert.equal(isContextUrl('http://127.0.0.1:40001/', 40001), true)
  assert.equal(isContextUrl('ws://127.0.0.1:40001/common/s', 40001), true)
  for (const url of [
    'http://example.com:40001/', 'http://127.0.0.1:40002/', 'http://127.0.0.1.example.com:40001/',
    'http://user:password@127.0.0.1:40001/', 'file:///C:/private', 'https://127.0.0.1:40001/'
  ]) assert.equal(isContextUrl(url, 40001), false)
})

function updateFixture (result, failed = false) {
  const calls = []
  const child = new EventEmitter()
  child.pid = 1234
  child.unref = () => { calls.push('unref') }
  const output = { exports: {} }
  const dependencies = {
    'node:fs': fs,
    'node:path': path,
    'node:child_process': {
      execFile (file, args, options, callback) {
        calls.push({ file, args, options })
        callback(failed ? new Error('native error') : null, JSON.stringify(result))
      },
      spawn (file, args, options) {
        calls.push({ file, args, options })
        queueMicrotask(() => child.emit(failed ? 'error' : 'spawn', failed ? new Error('not executable') : undefined))
        return child
      }
    }
  }
  const source = fs.readFileSync(path.resolve(__dirname, '../../app/lib/windows-host-client.js'), 'utf8')
  vm.runInNewContext('(function (require, module) {\n' + source + '\n})')(
    name => dependencies[name], output)
  return { ...output.exports, calls }
}

test('native prepared update result must match exact checksum/size and scoped protected filename', async () => {
  const update = { sha256: 'a'.repeat(64), size: 123 }
  const value = {
    ...update,
    path: 'C:\\ProgramData\\Anubis\\Host\\AnubisHost\\updates\\' + 'b'.repeat(32) + '\\installer.exe'
  }
  const f = updateFixture(value)
  assert.equal(await f.prepareWindowsUpdate('helper.exe', 'AnubisHost', 'temp.exe', update), value.path)
  assert.deepEqual(Array.from(f.calls[0].args), [
    'prepare-update', '--name', 'AnubisHost', '--source-file', 'temp.exe',
    '--sha256', update.sha256, '--size', '123'
  ])
  for (const invalid of [
    { ...value, size: 124 }, { ...value, sha256: 'c'.repeat(64) },
    { ...value, path: 'C:\\user-temp\\installer.exe' },
    { ...value, path: value.path.replace('AnubisHost\\', 'AnubisHost-QA-other\\') },
    { ...value, path: value.path.replace('b'.repeat(32), '..') },
    { ...value, path: value.path + ':alternate-stream' }
  ]) {
    const fixture = updateFixture(invalid)
    await assert.rejects(fixture.prepareWindowsUpdate('helper.exe', 'AnubisHost', 'temp.exe', update), {
      code: 'ERR_HOST_UPDATE_PREPARE'
    })
  }
})

test('elevated machine GUI launches the protected installer directly without PATH, shell or PowerShell', async () => {
  const f = updateFixture(null)
  assert.equal(await f.launchPreparedWindowsUpdate('C:\\protected\\installer.exe'), 1234)
  assert.equal(f.calls[0].file, 'C:\\protected\\installer.exe')
  assert.equal(f.calls[0].options.shell, false)
  assert.equal(f.calls[0].options.detached, true)
  assert.equal(f.calls[0].options.stdio, 'ignore')
  assert.ok(f.calls.includes('unref'))
  await assert.rejects(updateFixture(null, true).launchPreparedWindowsUpdate('C:\\protected\\installer.exe'), {
    code: 'ERR_HOST_UPDATE_LAUNCH'
  })
})
