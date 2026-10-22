/**
 * Admin-level policy (see fork/docs/ADMIN-VS-USER.md).
 *
 * Values are fixed at build time (brand.config.js) or by environment
 * variables ANUBIS_ADMIN_* present at (first) start. They are forced into the
 * user config on every start, on every config read and on every config save,
 * so editing them through the UI, the IPC API or the config file has no
 * lasting effect. Secrets (MCP token) are never in brand.config.js: they are
 * generated on first start and kept in userData.
 *
 * Keep ADMIN_LOCKABLE_KEYS in sync with src/client/common/admin-policy.js
 * (checked by the unit test admin-policy.spec.js).
 */

const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const brand = require('./brand')

const ADMIN_LOCKABLE_KEYS = [
  'syncSetting.cloudApiUrl',
  'baseURLAI',
  'apiPathAI',
  'authHeaderNameAI',
  'enableGlobalProxy',
  'proxy',
  'checkUpdateOnStart',
  'mcpServerEnabled',
  'errorReportEnabled',
  'errorReportUrl',
  'autoStartOnLogin'
]

const MCP_TOKEN_FILE = 'admin-mcp-token'

function envBool (v, fallback) {
  if (v === undefined || v === '') {
    return fallback
  }
  return !['0', 'false', 'no', 'off'].includes(String(v).trim().toLowerCase())
}

function envStr (v, fallback) {
  return v === undefined || v === '' ? fallback : String(v).trim()
}

function apiBase () {
  return brand.domains.api || `https://api.${new URL(brand.domains.site).hostname}`
}

/**
 * @returns {{ values: object, locked: string[] }}
 *   values: dotted key -> forced value; locked: keys hidden/read-only in UI
 */
function getAdminPolicy (env = process.env) {
  const values = {
    'syncSetting.cloudApiUrl': envStr(env.ANUBIS_ADMIN_SYNC_API, brand.sync.cloudApi),
    baseURLAI: envStr(env.ANUBIS_ADMIN_AI_BASE_URL, brand.ai.baseURL),
    apiPathAI: '/chat/completions',
    authHeaderNameAI: 'Authorization: Bearer',
    checkUpdateOnStart: envBool(env.ANUBIS_ADMIN_UPDATE_ENABLED, brand.update.enabled),
    mcpServerEnabled: envBool(env.ANUBIS_ADMIN_MCP_ENABLED, true),
    errorReportEnabled: envBool(env.ANUBIS_ADMIN_ERROR_REPORT, false),
    errorReportUrl: envStr(env.ANUBIS_ADMIN_ERROR_REPORT_URL, `${apiBase()}/api/errors`),
    autoStartOnLogin: envBool(env.ANUBIS_ADMIN_AUTOSTART, true)
  }
  const locked = Object.keys(values)
  // proxy is enforced only when the admin provides one
  const proxy = envStr(env.ANUBIS_ADMIN_PROXY, '')
  if (proxy) {
    values.enableGlobalProxy = true
    values.proxy = proxy
    locked.push('enableGlobalProxy', 'proxy')
  }
  // autostart is admin-locked unless the admin explicitly lets the user opt out
  if (envBool(env.ANUBIS_ADMIN_AUTOSTART_USER_CAN_DISABLE, false)) {
    locked.splice(locked.indexOf('autoStartOnLogin'), 1)
  }
  return { values, locked }
}

function setPath (obj, dotted, value) {
  const parts = dotted.split('.')
  let cur = obj
  for (let i = 0; i < parts.length - 1; i++) {
    if (!cur[parts[i]] || typeof cur[parts[i]] !== 'object') {
      cur[parts[i]] = {}
    }
    cur = cur[parts[i]]
  }
  cur[parts[parts.length - 1]] = value
}

function hasPath (obj, dotted) {
  const parts = dotted.split('.')
  let cur = obj
  for (const p of parts) {
    if (!cur || typeof cur !== 'object' || !(p in cur)) {
      return false
    }
    cur = cur[p]
  }
  return true
}

/**
 * Returns a copy of `config` with admin values forced in.
 * Keys that the user may change (unlocked) are only defaulted when absent.
 * partial=true: config is a partial update, so a nested key is forced only
 * when its parent object is present (avoids clobbering the whole parent).
 */
function applyAdminPolicy (config, { partial = false, env = process.env } = {}) {
  const { values, locked } = getAdminPolicy(env)
  const res = { ...config }
  for (const key of Object.keys(values)) {
    const isNested = key.includes('.')
    const root = key.split('.')[0]
    if (!locked.includes(key)) {
      if (!partial && !hasPath(res, key)) {
        setPath(res, key, values[key])
      }
      continue
    }
    if (isNested) {
      if (partial && !(root in res)) {
        continue
      }
      res[root] = { ...(res[root] || {}) }
    }
    setPath(res, key, values[key])
  }
  return res
}

function getAdminLockedKeys (env = process.env) {
  return getAdminPolicy(env).locked
}

/**
 * Per-installation MCP token, created on first call. Stored in userData
 * (owner-only on POSIX), never in source.
 */
function ensureMcpToken (dir) {
  const file = path.join(dir, MCP_TOKEN_FILE)
  try {
    const existing = fs.readFileSync(file, 'utf8').trim()
    if (existing.length >= 32) {
      return existing
    }
  } catch (e) {}
  const token = crypto.randomBytes(32).toString('hex')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(file, token, { mode: 0o600 })
  return token
}

function getUserDataDir () {
  return require('electron').app.getPath('userData')
}

function getMcpToken () {
  return ensureMcpToken(getUserDataDir())
}

module.exports = {
  ADMIN_LOCKABLE_KEYS,
  MCP_TOKEN_FILE,
  getAdminPolicy,
  getAdminLockedKeys,
  applyAdminPolicy,
  ensureMcpToken,
  getMcpToken
}
