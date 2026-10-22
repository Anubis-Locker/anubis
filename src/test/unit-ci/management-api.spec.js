const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createServer } = require('../../../services/management-api')

async function fixture (t, options = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'anubis-management-test-'))
  const adminToken = 'unit-management-test-token'
  const server = createServer({ dataDir, adminToken, ...options })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  t.after(async () => {
    await new Promise(resolve => server.close(resolve))
    fs.rmSync(dataDir, { recursive: true, force: true })
  })
  return {
    dataDir,
    server,
    admin: { authorization: `Bearer ${adminToken}` },
    request: (route, options = {}) => fetch(base + route, { signal: AbortSignal.timeout(5000), ...options }),
    report: body => fetch(base + '/api/report', {
      method: 'POST',
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000)
    })
  }
}

test('management acknowledgements identify reports that are actually persisted', async t => {
  const f = await fixture(t)
  const response = await f.report({ installId: 'qa-persisted-install', type: 'error', message: 'fixture error' })
  assert.equal(response.status, 200)
  const ack = await response.json()
  assert.equal(ack.ok, true)
  const stored = JSON.parse(fs.readFileSync(path.join(f.dataDir, 'reports.jsonl'), 'utf8'))
  assert.equal(stored.id, ack.id)
  assert.equal(stored.message, 'fixture error')
  assert.equal(stored.installId, 'qa-persisted-install')
  assert.equal((await f.request('/health')).status, 200)
})

test('management requires the administrator token for install lists and report history', async t => {
  const f = await fixture(t)
  for (const route of ['/api/installs', '/api/reports']) {
    assert.equal((await f.request(route)).status, 401)
    assert.equal((await f.request(route, { headers: { authorization: 'Bearer incorrect' } })).status, 401)
    assert.equal((await f.request(route, { headers: f.admin })).status, 200)
  }
})

test('missing administrator configuration never exposes report history', async t => {
  const f = await fixture(t, { adminToken: '' })
  for (const route of ['/api/installs', '/api/reports']) {
    assert.equal((await f.request(route, { headers: { authorization: 'Bearer ' } })).status, 401)
  }
  assert.equal((await f.report({ installId: 'qa-reporting-still-works' })).status, 200)
})

test('management lists one latest state per installation and retains full history', async t => {
  const f = await fixture(t)
  t.mock.method(Date, 'now', () => 1792700000000)
  const original = await (await f.report({ installId: 'qa-install-one', version: '1' })).json()
  const latest = await (await f.report({ installId: 'qa-install-one', version: '2' })).json()
  await f.report({ installId: 'qa-install-two', version: '1' })
  const installs = await (await f.request('/api/installs', { headers: f.admin })).json()
  assert.equal(installs.installs.length, 2)
  assert.equal(installs.installs.find(item => item.installId === 'qa-install-one').id, latest.id)
  const history = await (await f.request('/api/reports', { headers: f.admin })).json()
  assert.equal(history.reports.length, 3)
  assert.ok(history.reports.some(item => item.id === original.id))
  assert.equal((await (await f.request('/api/reports?limit=1', { headers: f.admin })).json()).reports.length, 1)
})

test('management rejects malformed reports and invalid history limits', async t => {
  const f = await fixture(t)
  for (const payload of [null, [], {}, { installId: [] }, { installId: ' ' }, { installId: 'a'.repeat(129) }]) {
    assert.equal((await f.report(payload)).status, 400)
  }
  assert.equal((await f.request('/api/report', { method: 'POST', body: '{bad' })).status, 400)
  for (const limit of ['', '0', '-1', '2.5', '2001', 'invalid']) {
    assert.equal((await f.request('/api/reports?limit=' + limit, { headers: f.admin })).status, 400)
  }
  assert.equal((await f.request('/unknown')).status, 404)
})

test('management rejects oversized reports without recording a success', async t => {
  const f = await fixture(t)
  const response = await f.report({ installId: 'qa-oversized', message: 'x'.repeat(1024 * 1024) })
  assert.equal(response.status, 413)
  assert.equal(fs.readFileSync(path.join(f.dataDir, 'reports.jsonl'), 'utf8'), '')
})

test('storage failures are logged and do not acknowledge lost reports', async t => {
  const f = await fixture(t)
  const errors = []
  t.mock.method(console, 'error', (...args) => errors.push(args))
  const file = path.join(f.dataDir, 'reports.jsonl')
  fs.unlinkSync(file)
  fs.mkdirSync(file)
  const response = await f.report({ installId: 'qa-storage-failure' })
  assert.equal(response.status, 500)
  assert.equal((await response.json()).ok, undefined)
  assert.equal(errors.length, 1)
})

test('corrupt persisted history is reported rather than silently hidden', async t => {
  const f = await fixture(t)
  const errors = []
  t.mock.method(console, 'error', (...args) => errors.push(args))
  fs.writeFileSync(path.join(f.dataDir, 'reports.jsonl'), '{corrupt\n')
  const response = await f.request('/api/reports', { headers: f.admin })
  assert.equal(response.status, 500)
  assert.equal(errors.length, 1)
})
