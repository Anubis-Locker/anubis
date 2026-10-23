const fs = require('node:fs')
const path = require('node:path')
const defaultUserName = require('../common/default-user-name')

function readDeepLinkAutoRegister (appData, dirName, decrypt) {
  const file = path.join(appData, dirName, 'users', defaultUserName, 'electerm_data.db')
  try {
    fs.statSync(file)
  } catch (error) {
    if (error.code === 'ENOENT') return true
    throw error
  }
  const { DatabaseSync } = require('node:sqlite')
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    const row = db.prepare('SELECT data FROM data WHERE _id = ?').get('userConfig')
    if (!row) return true
    const value = row.data.startsWith('enc:') ? decrypt(row.data.slice(4)) : row.data
    const config = JSON.parse(value)
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
      throw Object.assign(new Error('Invalid protocol registration configuration'), { code: 'ERR_MACHINE_PROTOCOL_CONFIG' })
    }
    return config.deepLinkAutoRegister !== false
  } finally {
    db.close()
  }
}

module.exports = { readDeepLinkAutoRegister }
