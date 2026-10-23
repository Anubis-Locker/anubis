const { test } = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')
const { createRuntimeControl } = require('../../app/lib/machine-runtime-control')

async function fixture (t, getEndpoint) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anubis-control-'))
  const contextId = crypto.randomBytes(16).toString('hex')
  const pipe = process.platform === 'win32'
    ? '\\\\.\\pipe\\anubis-unit-' + contextId
    : path.join(dir, 'control')
  const errors = []
  const runtime = createRuntimeControl({
    pipe,
    contextId,
    getEndpoint: getEndpoint || (() => ({ localPort: 40001, privateProof: 'b'.repeat(64), token: 'not-a-response-field' })),
    onError: error => errors.push(error.code)
  })
  t.after(async () => {
    await runtime.close()
    fs.rmSync(dir, { recursive: true })
  })
  await runtime.start()
  return { pipe, contextId, runtime, errors }
}

function exchange (pipe, input) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(pipe, () => socket.write(input))
    let response = ''
    socket.setEncoding('utf8')
    socket.setTimeout(2000, () => socket.destroy(new Error('Control test timed out')))
    socket.on('error', reject)
    socket.on('data', chunk => { response += chunk })
    socket.on('end', () => resolve(JSON.parse(response)))
  })
}

test('private describe response contains only current process/context and loopback endpoint fields', async t => {
  const value = await fixture(t)
  const response = await exchange(value.pipe, '{"version":1,"operation":"describe"}\n')
  assert.deepEqual(response, {
    version: 1,
    ok: true,
    result: {
      pid: process.pid,
      contextId: value.contextId,
      endpoint: { localPort: 40001, privateProof: 'b'.repeat(64) }
    }
  })
  assert.deepEqual(value.errors, [])
})

test('control endpoint rejects command launch, unknown fields, malformed and pipelined requests', async t => {
  const value = await fixture(t)
  for (const input of [
    '{"version":1,"operation":"launch","executable":"cmd.exe"}\n',
    '{"version":1,"operation":"describe","extra":true}\n',
    '{"version":2,"operation":"describe"}\n',
    '[]\n', 'null\n', 'not-json\n',
    '{"version":1,"operation":"describe"}\n{"version":1,"operation":"describe"}\n',
    'x'.repeat(4097)
  ]) {
    assert.deepEqual(await exchange(value.pipe, input), {
      version: 1, ok: false, error: { code: 'ERR_INVALID_REQUEST' }
    })
  }
})

test('unready endpoint fails explicitly without serializing exception details or private input', async t => {
  const value = await fixture(t, () => {
    throw Object.assign(new Error('credential=private https://example/?token=private'), { code: 'EACCES' })
  })
  assert.deepEqual(await exchange(value.pipe, '{"version":1,"operation":"describe"}\n'), {
    version: 1, ok: false, error: { code: 'ERR_ENGINE_NOT_READY' }
  })
  assert.deepEqual(value.errors, ['EACCES'])
})

test('runtime endpoint rejects invalid local ports and transport proofs', async t => {
  let endpoint
  const value = await fixture(t, () => endpoint)
  for (endpoint of [
    undefined,
    { localPort: 0, privateProof: 'b'.repeat(64) },
    { localPort: 65536, privateProof: 'b'.repeat(64) },
    { localPort: 40001, privateProof: 'too-short' }
  ]) {
    assert.equal((await exchange(value.pipe, '{"version":1,"operation":"describe"}\n')).ok, false)
  }
  assert.equal(value.errors.length, 4)
})

test('closing the controller drains owned sockets and is idempotent', async t => {
  const value = await fixture(t)
  const socket = net.connect(value.pipe)
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve)
    socket.once('error', reject)
  })
  const closed = new Promise(resolve => socket.once('close', resolve))
  await value.runtime.close()
  await closed
  await value.runtime.close()
})
