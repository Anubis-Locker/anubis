/**
 * Stable per-installation id, used only to group this app's own error/update
 * reports on our management API (api.anubis.locker). Generated once and
 * cached in userData; contains no user-identifying information.
 */

const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

const INSTALL_ID_FILE = 'install-id'

function ensureInstallId (dir) {
  const file = path.join(dir, INSTALL_ID_FILE)
  const read = () => {
    const id = fs.readFileSync(file, 'utf8').trim()
    if (!/^[a-zA-Z0-9-]{16,128}$/.test(id)) {
      throw new Error(`Invalid installation id in ${file}`)
    }
    return id
  }
  try {
    return read()
  } catch (e) {
    if (e.code !== 'ENOENT') throw e
  }
  const id = crypto.randomUUID()
  fs.mkdirSync(dir, { recursive: true })
  try {
    fs.writeFileSync(file, id, { flag: 'wx', mode: 0o600 })
  } catch (e) {
    if (e.code === 'EEXIST') return read()
    throw e
  }
  return id
}

function getInstallId () {
  return ensureInstallId(require('electron').app.getPath('userData'))
}

module.exports = {
  INSTALL_ID_FILE,
  ensureInstallId,
  getInstallId
}
