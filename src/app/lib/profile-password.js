const crypto = require('node:crypto')
const { promisify } = require('node:util')

const pbkdf2 = promisify(crypto.pbkdf2)
const MAX_LENGTH = 4096

function failure (code, committed = false) {
  return Object.assign(new Error('Native profile password update failed'), { code, committed })
}

function passwordState (config) {
  if (config !== null && (!config || typeof config !== 'object' || Array.isArray(config))) {
    throw failure('ERR_NATIVE_PASSWORD_PROFILE_UNAVAILABLE')
  }
  const { salt, hashedPassword } = config || {}
  if ((salt === undefined && hashedPassword === undefined) ||
      (salt === '' && hashedPassword === '')) return 'unset'
  if (typeof salt !== 'string' || !salt.length || salt.length > MAX_LENGTH ||
      typeof hashedPassword !== 'string' || !/^[a-f0-9]{128}$/i.test(hashedPassword)) {
    throw failure('ERR_NATIVE_PASSWORD_PROFILE_UNAVAILABLE')
  }
  return 'set'
}

async function verifyProfilePassword (password, config) {
  if (typeof password !== 'string' || password.length > MAX_LENGTH) {
    throw failure('ERR_NATIVE_PASSWORD_INVALID_INPUT')
  }
  if (passwordState(config) === 'unset') return password === ''
  const actual = await pbkdf2(password, config.salt, 1000, 64, 'sha512')
  return crypto.timingSafeEqual(actual, Buffer.from(config.hashedPassword, 'hex'))
}

// This core performs no OS authorization and is not an RPC or control-pipe API.
// Only the native admission owner may invoke it after authenticating redemption.
function createProfilePasswordUpdater ({ dbAction, compareAndSetUserConfig, invalidateSessions }) {
  if (typeof dbAction !== 'function' || typeof compareAndSetUserConfig !== 'function' ||
      typeof invalidateSessions !== 'function') {
    throw new TypeError('Native profile updates require transactional storage and session invalidation')
  }
  let pending = Promise.resolve()
  async function update (input) {
    if (!input || typeof input !== 'object' || Array.isArray(input) ||
        Object.keys(input).sort().join(',') !== 'newPassword,oldPassword' ||
        typeof input.oldPassword !== 'string' || input.oldPassword.length > MAX_LENGTH ||
        typeof input.newPassword !== 'string' || !input.newPassword.length ||
        input.newPassword.length > MAX_LENGTH) {
      throw failure('ERR_NATIVE_PASSWORD_INVALID_INPUT')
    }
    let config
    try {
      config = await dbAction('data', 'findOne', { _id: 'userConfig' })
    } catch {
      throw failure('ERR_NATIVE_PASSWORD_PROFILE_UNAVAILABLE')
    }
    if (!await verifyProfilePassword(input.oldPassword, config)) {
      throw failure('ERR_NATIVE_PASSWORD_OLD_PASSWORD')
    }
    const salt = crypto.randomBytes(16).toString('hex')
    const hash = await pbkdf2(input.newPassword, salt, 1000, 64, 'sha512')
    const replacement = { ...config, _id: 'userConfig', salt, hashedPassword: hash.toString('hex') }
    let changed
    try {
      changed = await compareAndSetUserConfig(config, replacement)
    } catch (error) {
      throw failure(error.code === 'ERR_PROFILE_DATA_UNAVAILABLE'
        ? 'ERR_NATIVE_PASSWORD_PROFILE_UNAVAILABLE'
        : 'ERR_NATIVE_PASSWORD_STORAGE')
    }
    if (changed !== true) throw failure('ERR_NATIVE_PASSWORD_CONFLICT')
    try {
      await invalidateSessions({ hashedPassword: replacement.hashedPassword })
    } catch {
      throw failure('ERR_NATIVE_PASSWORD_COMMITTED_INVALIDATION_FAILED', true)
    }
    return { committed: true }
  }
  return input => {
    const request = input && typeof input === 'object' && !Array.isArray(input) ? { ...input } : input
    const result = pending.then(() => update(request))
    pending = result.catch(() => {})
    return result
  }
}

module.exports = { createProfilePasswordUpdater, verifyProfilePassword }
