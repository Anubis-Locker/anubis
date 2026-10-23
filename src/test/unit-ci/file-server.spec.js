const { describe, it, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const express = require('express')
const initFileServer = require('../../app/lib/file-server')

describe('desktop renderer asset cache policy', () => {
  let root
  let server
  let origin
  before(async () => {
    root = mkdtempSync(join(tmpdir(), 'anubis-assets-'))
    for (const dir of ['js', 'chunk', 'css']) mkdirSync(join(root, dir))
    writeFileSync(join(root, 'index.html'), '<!doctype html><title>Current build</title>')
    writeFileSync(join(root, 'js', 'basic-5.6.10.js'), 'export const build = "current"')
    writeFileSync(join(root, 'chunk', 'info-modal-5.6.10-current.js'), 'export default "current"')
    writeFileSync(join(root, 'css', 'style-5.6.10.css'), 'body { color: white }')
    const app = express()
    initFileServer(app, root)
    server = app.listen(0, '127.0.0.1')
    await new Promise(resolve => server.once('listening', resolve))
    origin = `http://127.0.0.1:${server.address().port}`
  })
  after(async () => {
    if (server) await new Promise(resolve => server.close(resolve))
    if (root) rmSync(root, { recursive: true, force: true })
  })
  for (const url of [
    '/index.html?v=5.6.10',
    '/js/basic-5.6.10.js',
    '/chunk/info-modal-5.6.10-current.js',
    '/css/style-5.6.10.css'
  ]) {
    it(`does not persist ${url} between builds`, async () => {
      const response = await fetch(origin + url)
      assert.equal(response.status, 200)
      assert.equal(response.headers.get('cache-control'), 'no-store')
      assert.equal(response.headers.get('etag'), null)
      assert.equal(response.headers.get('last-modified'), null)
      assert.ok((await response.text()).length)
    })
  }
  it('returns the current entry when an older build supplied conditional cache headers', async () => {
    const response = await fetch(origin + '/js/basic-5.6.10.js', {
      headers: {
        'If-None-Match': '"old-build"',
        'If-Modified-Since': 'Wed, 21 Oct 2037 07:28:00 GMT'
      }
    })
    assert.equal(response.status, 200)
    assert.equal(await response.text(), 'export const build = "current"')
  })
  it('serves temporary stylesheet requests as uncached CSS', async () => {
    const response = await fetch(origin + '/css/_temp_theme.css')
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type'), /^text\/css/)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.equal(await response.text(), '')
  })
  it('does not replace a missing chunk with a successful HTML response', async () => {
    const response = await fetch(origin + '/chunk/info-modal-5.6.10-old.js')
    assert.equal(response.status, 404)
    assert.equal(response.headers.get('cache-control'), 'no-store')
  })
})
