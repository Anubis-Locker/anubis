const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { migrateLegacyData } = require('../../app/lib/migrate-legacy-data')

function setup () {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'brand-migrate-'))
  const legacy = path.join(base, 'electerm', 'users', 'default_user')
  fs.mkdirSync(legacy, { recursive: true })
  fs.writeFileSync(path.join(legacy, 'electerm_data.db'), 'legacy')
  return base
}

test('copies legacy data when new dir is empty and keeps the legacy dir', () => {
  const base = setup()
  const res = migrateLegacyData({
    appPath: base, dirName: 'anubis', legacyDataDirs: ['electerm'], env: {}
  })
  assert.equal(res.migrated, true)
  const copied = path.join(base, 'anubis', 'users', 'default_user', 'electerm_data.db')
  assert.equal(fs.readFileSync(copied, 'utf8'), 'legacy')
  assert.ok(fs.existsSync(path.join(base, 'electerm', 'users', 'default_user', 'electerm_data.db')))
  fs.rmSync(base, { recursive: true, force: true })
})

test('does nothing when new dir already has data', () => {
  const base = setup()
  fs.mkdirSync(path.join(base, 'anubis'))
  fs.writeFileSync(path.join(base, 'anubis', 'x'), '1')
  const res = migrateLegacyData({
    appPath: base, dirName: 'anubis', legacyDataDirs: ['electerm'], env: {}
  })
  assert.equal(res.migrated, false)
  assert.equal(fs.existsSync(path.join(base, 'anubis', 'users')), false)
  fs.rmSync(base, { recursive: true, force: true })
})

test('respects DATA_PATH and empty flag', () => {
  const base = setup()
  assert.equal(migrateLegacyData({
    appPath: base, dirName: 'anubis', legacyDataDirs: ['electerm'], env: { DATA_PATH: '/x' }
  }).migrated, false)
  assert.equal(migrateLegacyData({
    appPath: base, dirName: 'anubis', legacyDataDirs: [], env: {}
  }).migrated, false)
  assert.equal(fs.existsSync(path.join(base, 'anubis')), false)
  fs.rmSync(base, { recursive: true, force: true })
})
