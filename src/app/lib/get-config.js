const { dbAction } = require('./db')
const defaultSetting = require('../common/config-default')
const getPort = require('./get-port')
const { userConfigId, userNoEncryptConfigId } = require('../common/constants')
const generate = require('../common/uid')
const globalState = require('./glob-state')
const { applyAdminPolicy, getAdminLockedKeys } = require('../common/admin-policy')

exports.getConfig = async (inited) => {
  const userConfig = await dbAction('data', 'findOne', {
    _id: userConfigId
  }) || {}
  const requireAuth = userConfig.hashedPassword
  delete userConfig._id
  delete userConfig.host
  delete userConfig.terminalTypes
  delete userConfig.tokenElecterm
  delete userConfig.hashedPassword
  delete userConfig.salt
  const port = inited
    ? globalState.get('config').port
    : await getPort()
  const config = applyAdminPolicy({
    ...defaultSetting,
    ...userConfig,
    syncSetting: {
      ...defaultSetting.syncSetting,
      ...userConfig.syncSetting
    }
  })
  Object.assign(config, {
    requireAuth,
    port,
    tokenElecterm: inited ? globalState.get('config').tokenElecterm : generate(),
    adminLockedKeys: getAdminLockedKeys()
  })
  return {
    userConfig,
    config
  }
}

exports.getDbConfig = async () => {
  const userConfig = await dbAction('data', 'findOne', {
    _id: userConfigId
  }) || {}
  return userConfig
}

exports.getUserConfigNoEnc = async () => {
  const userConfig = await dbAction('data', 'findOne', {
    _id: userNoEncryptConfigId
  }) || {}
  return userConfig
}
