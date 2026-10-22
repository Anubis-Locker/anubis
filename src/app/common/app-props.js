/**
 * app path
 */
const { app } = require('electron')
const { resolve } = require('path')
const constants = require('./runtime-constants')
const installSrc = require('../lib/install-src')

function getDataPath () {
  const defaultValue = {
    appPath: app.getPath('appData'),
    isPortable: false
  }
  if (!constants.isWin) {
    return defaultValue
  }
  const dirName = require('./brand').data.dirName
  const exePath = require('path').dirname(app.getPath('exe'))
  const p = exePath + '\\' + dirName
  if (
    installSrc === 'win-x64-portable.tar.gz' ||
    require('fs').existsSync(
      p
    )
  ) {
    return {
      appPath: exePath,
      exePath,
      isPortable: true
    }
  }
  return {
    ...defaultValue,
    exePath
  }
}

const dataPath = getDataPath()
// first start: copy legacy data (never deleted) before any db/key file is opened
const brandData = require('./brand').data
const migration = require('../lib/migrate-legacy-data').migrateLegacyData({
  appPath: dataPath.appPath,
  dirName: brandData.dirName,
  legacyDataDirs: brandData.legacyDataDirs
})
if (migration.error) {
  throw new Error(`Legacy data migration failed (${migration.from}): ${migration.error}`)
}
if (migration.migrated) {
  console.log(`migrated legacy data ${migration.from} -> ${migration.to}`)
}

module.exports = {
  ...dataPath,
  sshKeysPath: resolve(
    app.getPath('home'),
    '.ssh'
  ),
  ...constants
}
