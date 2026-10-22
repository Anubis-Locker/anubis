const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const policy = require('../../app/common/admin-policy')
const brand = require('../../common/brand.config')

describe('admin-policy (main process)', () => {
  it('forces admin values over user values', () => {
    const res = policy.applyAdminPolicy({
      baseURLAI: 'https://evil.example/v1',
      apiPathAI: '/x',
      checkUpdateOnStart: false,
      mcpServerEnabled: false,
      autoStartOnLogin: false,
      fontSize: 20,
      syncSetting: { cloudApiUrl: 'https://evil.example', autoSync: false }
    }, { env: {} })
    assert.equal(res.baseURLAI, brand.ai.baseURL)
    assert.equal(res.apiPathAI, '/chat/completions')
    assert.equal(res.checkUpdateOnStart, true)
    assert.equal(res.mcpServerEnabled, true)
    assert.equal(res.autoStartOnLogin, true)
    assert.equal(res.syncSetting.cloudApiUrl, brand.sync.cloudApi)
    // user level settings are untouched
    assert.equal(res.fontSize, 20)
    assert.equal(res.syncSetting.autoSync, false)
  })

  it('partial updates do not create nested parents', () => {
    const res = policy.applyAdminPolicy({ fontSize: 12 }, { partial: true, env: {} })
    assert.equal(res.syncSetting, undefined)
    assert.equal(res.baseURLAI, brand.ai.baseURL)
  })

  it('error report url points to api subdomain and is on by default', () => {
    const { values } = policy.getAdminPolicy({})
    assert.equal(values.errorReportUrl, `${brand.domains.api}/api/report`)
    assert.equal(values.errorReportEnabled, true)
    assert.equal(policy.getAdminPolicy({ ANUBIS_ADMIN_ERROR_REPORT: '0' }).values.errorReportEnabled, false)
  })

  it('env overrides are applied', () => {
    const { values, locked } = policy.getAdminPolicy({
      ANUBIS_ADMIN_SYNC_API: 'https://s.example/api/sync',
      ANUBIS_ADMIN_PROXY: 'socks5://10.0.0.1:1080'
    })
    assert.equal(values['syncSetting.cloudApiUrl'], 'https://s.example/api/sync')
    assert.ok(locked.includes('proxy'))
    assert.equal(values.enableGlobalProxy, true)
  })

  it('proxy is not locked without admin proxy', () => {
    assert.ok(!policy.getAdminLockedKeys({}).includes('proxy'))
  })

  it('autostart is user-editable only when admin allows it', () => {
    assert.ok(policy.getAdminLockedKeys({}).includes('autoStartOnLogin'))
    const locked = policy.getAdminLockedKeys({ ANUBIS_ADMIN_AUTOSTART_USER_CAN_DISABLE: '1' })
    assert.ok(!locked.includes('autoStartOnLogin'))
    const res = policy.applyAdminPolicy({ autoStartOnLogin: false }, {
      env: { ANUBIS_ADMIN_AUTOSTART_USER_CAN_DISABLE: '1' }
    })
    assert.equal(res.autoStartOnLogin, false)
  })

  it('mcp token is generated once and persisted', () => {
    const dir = path.join(__dirname, 'tmp-mcp-' + process.pid + '-' + Date.now())
    try {
      const t1 = policy.ensureMcpToken(dir)
      assert.match(t1, /^[0-9a-f]{64}$/)
      assert.equal(policy.ensureMcpToken(dir), t1)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('client and main lockable key lists match', async () => {
    const client = await import('../../client/common/admin-policy.js')
    assert.deepEqual(client.ADMIN_LOCKABLE_KEYS, policy.ADMIN_LOCKABLE_KEYS)
    assert.ok(client.isAdminLocked('baseURLAI', { adminLockedKeys: ['baseURLAI'] }))
    assert.ok(!client.isAdminLocked('fontSize', { adminLockedKeys: ['baseURLAI'] }))
  })

  it('default config uses brand ai endpoint and own sync server', () => {
    const cfg = require('../../app/common/config-default')
    assert.equal(cfg.baseURLAI, brand.ai.baseURL)
    assert.equal(cfg.syncSetting.cloudApiUrl, brand.sync.cloudApi)
    assert.equal(cfg.syncSetting.autoSync, true)
    assert.equal(cfg.autoStartOnLogin, true)
  })
})
