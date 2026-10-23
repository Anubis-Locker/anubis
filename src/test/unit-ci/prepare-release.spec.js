const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')
const { prepareRelease } = require('../../../services/prepare-release')

function fixture (t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'anubis-release-artifacts-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const source = path.join(root, 'source')
  const nested = path.join(source, 'linux-deb-tar', 'dist12345')
  fs.mkdirSync(nested, { recursive: true })
  const suffixes = [
    'win-x64-installer.exe', 'win-x64-portable.tar.gz', 'win-x64.tar.gz',
    'linux-amd64.deb', 'linux-x64.tar.gz', 'linux-x86_64.AppImage',
    'mac-x64.dmg', 'mac-arm64.dmg'
  ]
  const names = suffixes.map(suffix => `anubis-5.6.11-${suffix}`)
  for (const name of names) fs.writeFileSync(path.join(nested, name), `fixture:${name}`)
  return { source, nested, names, output: path.join(root, 'prepared') }
}

test('flattens every supported platform artifact and hashes the exact attached bytes', async t => {
  const f = fixture(t)
  assert.equal(await prepareRelease(f.source, f.output, '5.6.11'), 8)
  assert.deepEqual(fs.readdirSync(f.output).sort(), ['SHA256SUMS', ...f.names].sort())
  const lines = fs.readFileSync(path.join(f.output, 'SHA256SUMS'), 'utf8').trim().split('\n')
  assert.equal(lines.length, 8)
  for (const line of lines) {
    const [digest, name] = line.split('  ')
    assert.equal(digest, crypto.createHash('sha256').update(fs.readFileSync(path.join(f.output, name))).digest('hex'))
    assert.equal(fs.readFileSync(path.join(f.output, name), 'utf8'), `fixture:${name}`)
  }
})

test('rejects incomplete, empty and ambiguous builds before creating a publish directory', async t => {
  const f = fixture(t)
  const name = f.names[0]
  const source = path.join(f.nested, name)
  fs.unlinkSync(source)
  await assert.rejects(prepareRelease(f.source, f.output, '5.6.11'), /Missing release artifact/)
  fs.writeFileSync(source, '')
  await assert.rejects(prepareRelease(f.source, f.output, '5.6.11'), /Empty release artifact/)
  fs.writeFileSync(source, 'restored')
  fs.copyFileSync(source, path.join(f.source, name))
  await assert.rejects(prepareRelease(f.source, f.output, '5.6.11'), /Duplicate release artifact/)
  await assert.rejects(prepareRelease(f.source, f.output, '../escape'), /valid release version/)
  assert.equal(fs.existsSync(f.output), false)
})
