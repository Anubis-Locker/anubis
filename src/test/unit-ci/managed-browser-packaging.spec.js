const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { stageBrowserAssets } = require('../../build/bin/browser-assets')

test('browser package staging preserves all lazy chunks fonts wasm and icons outside dependency cleanup', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'anubis-browser-package-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const source = path.join(root, 'node_modules', 'browser-package', 'assets')
  const destination = path.join(root, 'browser-assets')
  const assets = [
    'js/basic-5.6.11.js', 'js/electerm-5.6.11.js', 'js/worker-5.6.11.js',
    'css/style-5.6.11.css', 'chunk/terminal-lazy.js',
    'assets/terminal-font.woff2', 'assets/rdp.wasm',
    'icons/file.svg', 'images/logo.png'
  ]
  for (const [index, entry] of assets.entries()) {
    const file = path.join(source, entry)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, Buffer.from([index, 255, 0, 127]))
  }
  fs.mkdirSync(destination)
  fs.writeFileSync(path.join(destination, 'stale-chunk.js'), 'old version')
  stageBrowserAssets({ source, destination, version: '5.6.11' })
  assert.equal(fs.existsSync(path.join(destination, 'stale-chunk.js')), false)
  fs.rmSync(path.join(root, 'node_modules'), { recursive: true })
  for (const [index, entry] of assets.entries()) {
    assert.deepEqual(fs.readFileSync(path.join(destination, entry)), Buffer.from([index, 255, 0, 127]))
  }
})

test('incomplete browser packages fail staging before replacing an existing working tree', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'anubis-browser-package-bad-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const source = path.join(root, 'missing-assets')
  const destination = path.join(root, 'browser-assets')
  fs.mkdirSync(destination)
  fs.writeFileSync(path.join(destination, 'working.js'), 'current')
  assert.throws(() => stageBrowserAssets({ source, destination, version: '5.6.11' }))
  assert.equal(fs.readFileSync(path.join(destination, 'working.js'), 'utf8'), 'current')
})
