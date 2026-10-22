const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { createServer } = require('../../../services/release-api')

const secret = 'unit-webhook-signature-key'
const route = '/github-anubis-api/unit-test'
async function fixture (t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'anubis-release-api-test-'))
  const releaseFile = path.join(root, 'release.json')
  const updateDir = path.join(root, 'update')
  const server = createServer({ secret, route, releaseFile, updateDir })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    await new Promise(resolve => server.close(resolve))
    fs.rmSync(root, { recursive: true, force: true })
  })
  const base = `http://127.0.0.1:${server.address().port}`
  return {
    releaseFile,
    updateDir,
    send: (payload, signature) => {
      const body = typeof payload === 'string' ? payload : JSON.stringify(payload)
      return fetch(base + route, {
        method: 'POST',
        body,
        headers: {
          'x-hub-signature-256': signature === undefined
            ? 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex')
            : signature
        },
        signal: AbortSignal.timeout(5000)
      })
    }
  }
}
const event = {
  action: 'published',
  release: {
    tag_name: 'v5.6.11',
    assets: [{ name: 'anubis.exe', size: 10, browser_download_url: 'https://download.anubis.locker/v5.6.11/anubis.exe' }]
  }
}

test('release API refuses startup without a signature secret and explicit webhook route', () => {
  assert.throws(() => createServer({ secret: '', route }), /WEBHOOK_SECRET/)
  assert.throws(() => createServer({ secret, route: '' }), /RELEASE_PATH/)
})

test('signed published webhook updates both feeds and the version marker before acknowledgement', async t => {
  const f = await fixture(t)
  const response = await f.send(event)
  assert.equal(response.status, 200)
  assert.equal(await response.text(), 'ok')
  assert.deepEqual(JSON.parse(fs.readFileSync(f.releaseFile)), event)
  for (const name of ['anubis-release.json', 'anubis-github-release.json']) {
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.updateDir, 'data', name))).release, event.release)
  }
  assert.equal(fs.readFileSync(path.join(f.updateDir, 'version.html'), 'utf8'), 'v5.6.11\n')
})

test('invalid signatures and malformed signed bodies never change release files', async t => {
  const f = await fixture(t)
  for (const signature of ['', 'sha256=bad', 'sha256=' + '0'.repeat(64)]) {
    assert.equal((await f.send(event, signature)).status, 401)
  }
  for (const body of ['{invalid', 'null', '[]']) {
    assert.equal((await f.send(body)).status, 400)
  }
  assert.equal(fs.existsSync(f.releaseFile), false)
})

test('unpublished events, drafts and prereleases are ignored', async t => {
  const f = await fixture(t)
  for (const payload of [
    { ...event, action: 'created' },
    { ...event, release: { ...event.release, draft: true } },
    { ...event, release: { ...event.release, prerelease: true } }
  ]) {
    assert.equal(await (await f.send(payload)).text(), 'no')
  }
  assert.equal(fs.existsSync(f.releaseFile), false)
})

test('release API returns HTTP 413 above the 25 MiB request limit without persisting the body', async t => {
  const f = await fixture(t)
  const response = await f.send('x'.repeat(25 * 1024 * 1024 + 1))
  assert.equal(response.status, 413)
  assert.equal(await response.text(), 'payload too large')
  assert.equal(fs.existsSync(f.releaseFile), false)
})

test('publication failure returns HTTP 500 and leaves the advertised version unchanged', async t => {
  const f = await fixture(t)
  fs.mkdirSync(f.updateDir)
  fs.mkdirSync(path.join(f.updateDir, '.publish-update.lock'))
  fs.writeFileSync(path.join(f.updateDir, 'version.html'), 'v5.6.10\n')
  const errors = []
  t.mock.method(console, 'error', (...args) => errors.push(args))
  const response = await f.send(event)
  assert.equal(response.status, 500)
  assert.equal(await response.text(), 'publication failed')
  assert.equal(fs.readFileSync(path.join(f.updateDir, 'version.html'), 'utf8'), 'v5.6.10\n')
  assert.equal(errors.length, 1)
})
