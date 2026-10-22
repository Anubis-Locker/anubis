/**
 * one-time copy of a legacy data folder (e.g. the upstream `electerm` one)
 * into the branded data folder on first start.
 * Never deletes or modifies the legacy folder.
 * Legacy names come from brand.data.legacyDataDirs ([] disables it).
 */

const fs = require('fs')
const path = require('path')

function hasData (dir) {
  try {
    return fs.existsSync(dir) && fs.readdirSync(dir).length > 0
  } catch (e) {
    return false
  }
}

/**
 * @param {object} opts
 * @param {string} opts.appPath base folder holding the data folders
 *   (Win %APPDATA%, mac ~/Library/Application Support, linux ~/.config)
 * @param {string} opts.dirName new data folder name
 * @param {string[]} opts.legacyDataDirs legacy folder names
 * @param {object} [opts.env] defaults to process.env
 * @returns {{migrated: boolean, from?: string, to?: string, error?: string}}
 */
function migrateLegacyData ({
  appPath,
  dirName,
  legacyDataDirs = [],
  env = process.env
}) {
  // an explicit DATA_PATH means the user manages the location
  if (env.DATA_PATH || !appPath || !dirName || !legacyDataDirs.length) {
    return { migrated: false }
  }
  const target = path.resolve(appPath, dirName)
  if (hasData(target)) {
    return { migrated: false }
  }
  for (const name of legacyDataDirs) {
    const from = path.resolve(appPath, name)
    if (from === target || !hasData(from)) {
      continue
    }
    try {
      fs.mkdirSync(target, { recursive: true })
      fs.cpSync(from, target, { recursive: true, force: false, errorOnExist: false })
      return { migrated: true, from, to: target }
    } catch (e) {
      return { migrated: false, from, to: target, error: e.message }
    }
  }
  return { migrated: false }
}

module.exports = {
  migrateLegacyData
}
