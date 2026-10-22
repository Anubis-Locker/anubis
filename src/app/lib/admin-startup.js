/**
 * Start-up defaults and admin policy that need the electron main process:
 *  - force admin values into the persisted user config
 *  - launch at OS login (default on, see admin-policy autoStartOnLogin)
 *  - register deep-link protocol handlers (default on, user can opt out)
 */

const { app } = require('electron')
const { isDeepStrictEqual } = require('util')
const { dbAction } = require('./db')
const { userConfigId } = require('../common/constants')
const { getDbConfig } = require('./get-config')
const { applyAdminPolicy } = require('../common/admin-policy')
const { registerDeepLink } = require('./deep-link')
const log = require('../common/log')

function applyLoginItem (enabled) {
  // an unpackaged run would register the bare electron binary
  if (!app.isPackaged || typeof app.setLoginItemSettings !== 'function') {
    return
  }
  try {
    app.setLoginItemSettings({
      openAtLogin: !!enabled,
      args: ['--autohide']
    })
  } catch (e) {
    log.error('setLoginItemSettings failed', e)
  }
}

async function applyStartupPolicy () {
  const userConfig = await getDbConfig()
  const hasUserConfig = Object.keys(userConfig).length > 0
  const forced = applyAdminPolicy(userConfig)
  if (hasUserConfig && !isDeepStrictEqual(forced, userConfig)) {
    await dbAction('data', 'update', { _id: userConfigId }, {
      ...forced,
      _id: userConfigId
    }, { upsert: true })
    log.info('admin policy values restored in user config')
  }
  applyLoginItem(forced.autoStartOnLogin)
  if (userConfig.deepLinkAutoRegister !== false) {
    try {
      registerDeepLink()
    } catch (e) {
      log.error('registerDeepLink failed', e)
    }
  }
  return forced
}

module.exports = {
  applyStartupPolicy,
  applyLoginItem
}
