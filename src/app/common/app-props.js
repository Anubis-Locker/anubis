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
try {
  const brandData = require('./brand').data
  const res = require('../lib/migrate-legacy-data').migrateLegacyData({
    appPath: dataPath.appPath,
    dirName: brandData.dirName,
    legacyDataDirs: brandData.legacyDataDirs
  })
  if (res.migrated) {
    console.log(`migrated legacy data ${res.from} -> ${res.to}`)
  } else if (res.error) {
    console.error('legacy data migration failed:', res.error)
  }
} catch (e) {
  console.error('legacy data migration failed:', e.message)
}

module.exports = {
  ...dataPath,
  sshKeysPath: resolve(
    app.getPath('home'),
    '.ssh'
  ),
  ...constants
}
