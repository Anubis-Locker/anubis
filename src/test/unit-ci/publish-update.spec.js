const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { publishUpdate } = require('../../../services/publish-update')

function fixture (t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'anubis-publish-test-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const input = path.join(root, 'release.json')
  const output = path.join(root, 'update')
  const release = {
    tag_name: 'v5.6.11',
    assets: [{ name: 'anubis-installer.exe', size: 32, browser_download_url: 'https://download.anubis.locker/v5.6.11/anubis-installer.exe' }]
  }
  return { input, output, release, save: value => fs.writeFileSync(input, JSON.stringify(value)) }
}

test('publishes both client feed names and version marker while preserving feed metadata', t => {
  const f = fixture(t)
  fs.mkdirSync(path.join(f.output, 'data'), { recursive: true })
  fs.writeFileSync(path.join(f.output, 'data', 'anubis-release.json'), JSON.stringify({ starCount: 42, androidVersion: 'v1.0.0' }))
  f.save({ action: 'published', release: f.release })
  assert.equal(publishUpdate(f.input, f.output), 'v5.6.11')
  const primary = fs.readFileSync(path.join(f.output, 'data', 'anubis-release.json'), 'utf8')
  assert.equal(primary, fs.readFileSync(path.join(f.output, 'data', 'anubis-github-release.json'), 'utf8'))
  assert.equal(JSON.parse(primary).release.tag_name, 'v5.6.11')
  assert.equal(JSON.parse(primary).starCount, 42)
  assert.equal(JSON.parse(primary).androidVersion, 'v1.0.0')
  assert.equal(fs.readFileSync(path.join(f.output, 'version.html'), 'utf8'), 'v5.6.11\n')
  assert.deepEqual(fs.readdirSync(f.output).sort(), ['data', 'version.html'])
})

test('rejects draft, prerelease, empty and invalid assets before modifying the update marker', t => {
  const f = fixture(t)
  for (const release of [
    { ...f.release, draft: true },
    { ...f.release, prerelease: true },
    { ...f.release, assets: [] },
    { ...f.release, tag_name: 'invalid' },
    { ...f.release, assets: [{ ...f.release.assets[0], size: 0 }] },
    { ...f.release, assets: [{ ...f.release.assets[0], browser_download_url: 'http://example.invalid/asset' }] },
    { ...f.release, assets: [{ ...f.release.assets[0], name: '..\\escape.exe' }] }
  ]) {
    f.save(release)
    assert.throws(() => publishUpdate(f.input, f.output))
    assert.equal(fs.existsSync(path.join(f.output, 'version.html')), false)
  }
})

test('does not overwrite malformed existing metadata or a concurrently locked feed', t => {
  const f = fixture(t)
  f.save(f.release)
  fs.mkdirSync(path.join(f.output, 'data'), { recursive: true })
  const primary = path.join(f.output, 'data', 'anubis-release.json')
  fs.writeFileSync(primary, '{corrupt')
  assert.throws(() => publishUpdate(f.input, f.output), /JSON/)
  assert.equal(fs.readFileSync(primary, 'utf8'), '{corrupt')
  fs.writeFileSync(primary, '{}')
  fs.mkdirSync(path.join(f.output, '.publish-update.lock'))
  assert.throws(() => publishUpdate(f.input, f.output))
  assert.equal(fs.readFileSync(primary, 'utf8'), '{}')
})

test('machine-host promotion requires an installer and its verified SHA256 declaration', t => {
  const f = fixture(t)
  const asset = {
    ...f.release.assets[0],
    name: 'anubis-5.6.11-win-x64-installer.exe',
    windows_machine_host: 1,
    digest: 'sha256:' + 'a'.repeat(64)
  }
  for (const invalid of [
    { ...asset, digest: null },
    { ...asset, windows_machine_host: true },
    { ...asset, name: 'anubis-5.6.11-win-x64.tar.gz' }
  ]) {
    f.save({ ...f.release, assets: [invalid] })
    assert.throws(() => publishUpdate(f.input, f.output), /machine-host/)
    assert.equal(fs.existsSync(path.join(f.output, 'version.html')), false)
  }
  f.save({ ...f.release, assets: [asset] })
  publishUpdate(f.input, f.output)
  const published = JSON.parse(fs.readFileSync(path.join(f.output, 'data', 'anubis-release.json'), 'utf8'))
  assert.equal(published.release.assets[0].windows_machine_host, 1)
  assert.equal(published.release.assets[0].digest, asset.digest)
})
