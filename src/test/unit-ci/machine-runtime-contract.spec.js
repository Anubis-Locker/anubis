const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const {
  parseMachineInvocation, writeSupervisorFile, writeReady, writeStartupFailure
} = require('../../app/lib/machine-runtime-contract')

const contextId = 'a'.repeat(32)
const run = `C:\\ProgramData\\Anubis\\runs\\${contextId}`
const invocation = [
  '--anubis-machine-host',
  '--anubis-data-dir', 'C:\\ProgramData\\Anubis\\system-profile',
  '--anubis-context-id', contextId,
  '--anubis-ready-file', run + '\\ready.json',
  '--anubis-stop-file', run + '\\stop',
  '--anubis-error-file', run + '\\error.json',
  '--anubis-control-pipe', '\\\\.\\pipe\\anubis-' + contextId
]

function withValue (flag, value) {
  const args = [...invocation]
  args[args.indexOf(flag) + 1] = value
  return args
}

function fixture (t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anubis-machine-contract-'))
  t.after(() => fs.rmSync(dir, { recursive: true }))
  const readyFile = path.join(dir, 'ready.json')
  const errorFile = path.join(dir, 'error.json')
  fs.writeFileSync(readyFile, 'precreated-supervisor-file-with-previous-content')
  fs.writeFileSync(errorFile, '')
  return { dir, readyFile, errorFile, contextId }
}

test('ordinary desktop invocation is not converted into a machine runtime', () => {
  assert.equal(parseMachineInvocation([], 'win32'), null)
  assert.equal(parseMachineInvocation(['--new-window', '--server-port', '40000'], 'win32'), null)
})

test('machine contract preserves persistent data separately from per-launch control files', () => {
  const result = parseMachineInvocation(invocation, 'win32')
  assert.equal(result.mode, 'system')
  assert.equal(result.contextId, contextId)
  assert.equal(result.dataDir, 'C:\\ProgramData\\Anubis\\system-profile')
  assert.equal(result.readyFile, run + '\\ready.json')
  assert.equal(Object.isFrozen(result), true)
  const worker = [...invocation]
  worker[0] = '--anubis-context-worker'
  assert.equal(parseMachineInvocation(worker, 'win32').mode, 'user-context')
})

test('machine contract rejects incomplete, conflicting and command-shaped input', () => {
  for (const args of [
    invocation.slice(0, -2),
    [...invocation, '--anubis-context-worker'],
    [...invocation, '--anubis-data-dir', 'C:\\another'],
    [...invocation, '--executable', 'cmd.exe'],
    withValue('--anubis-context-id', '../context'),
    withValue('--anubis-context-id', 'A'.repeat(32)),
    withValue('--anubis-control-pipe', '\\\\server\\pipe\\anubis'),
    withValue('--anubis-control-pipe', '\\\\.\\pipe\\anubis\\nested'),
    withValue('--anubis-ready-file', run + '\\stop'),
    withValue('--anubis-error-file', 'C:\\elsewhere\\error.json')
  ]) {
    assert.throws(() => parseMachineInvocation(args, 'win32'), { code: 'ERR_MACHINE_RUNTIME_CONTRACT' })
  }
  assert.throws(() => parseMachineInvocation(invocation, 'linux'), /requires Windows/)
})

test('machine contract rejects UNC, relative, traversal and alternate-stream paths', () => {
  for (const value of [
    '\\\\server\\share\\profile', 'C:relative', '\\profile',
    'C:\\safe\\..\\unsafe', 'C:\\safe\\file:stream', 'C:\\safe\\trailing.',
    'C:\\safe\\trailing ', 'C:\\safe\\nul\u0000', 'C:\\safe\\wild*'
  ]) {
    assert.throws(() => parseMachineInvocation(withValue('--anubis-data-dir', value), 'win32'),
      { code: 'ERR_MACHINE_RUNTIME_CONTRACT' })
  }
})

test('ready status replaces precreated file contents in place without private endpoint data', t => {
  const value = fixture(t)
  const before = fs.statSync(value.readyFile)
  writeReady({ ...value, privateProof: 'never-serialize', localPort: 12345 })
  const after = fs.statSync(value.readyFile)
  assert.equal(after.ino, before.ino)
  assert.equal(after.dev, before.dev)
  assert.deepEqual(JSON.parse(fs.readFileSync(value.readyFile, 'utf8')), {
    version: 1, pid: process.pid, contextId
  })
})

test('status writer refuses missing files, directories and multiple-link targets', t => {
  const value = fixture(t)
  assert.throws(() => writeSupervisorFile(path.join(value.dir, 'missing.json'), {}), { code: 'ENOENT' })
  assert.throws(() => writeSupervisorFile(value.dir, {}), /precreated regular file/)
  const link = path.join(value.dir, 'linked.json')
  fs.linkSync(value.readyFile, link)
  assert.throws(() => writeSupervisorFile(link, {}), /precreated regular file/)
  assert.equal(fs.readFileSync(value.readyFile, 'utf8'), 'precreated-supervisor-file-with-previous-content')
})

test('startup error contains only bounded phase/code and no exception messages or credentials', t => {
  const value = fixture(t)
  const error = Object.assign(new Error('password=secret https://example/?token=secret'), {
    code: 'EACCES', stack: 'private-stack', cause: { token: 'private-token' }
  })
  writeStartupFailure(value, 'engine', error)
  assert.deepEqual(JSON.parse(fs.readFileSync(value.errorFile, 'utf8')), {
    version: 1, pid: process.pid, contextId, phase: 'engine', code: 'EACCES'
  })
  error.code = 'SECRET=https://example/'
  writeStartupFailure(value, 'bootstrap', error)
  assert.equal(JSON.parse(fs.readFileSync(value.errorFile, 'utf8')).code, 'ERR_MACHINE_RUNTIME_START')
  error.code = 'UPPERCASE_CREDENTIAL_MUST_NOT_BE_A_CODE'
  writeStartupFailure(value, 'bootstrap', error)
  assert.equal(JSON.parse(fs.readFileSync(value.errorFile, 'utf8')).code, 'ERR_MACHINE_RUNTIME_START')
  assert.throws(() => writeStartupFailure(value, 'password=secret', error), /Invalid machine runtime startup phase/)
})
