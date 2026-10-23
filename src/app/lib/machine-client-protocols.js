const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { execFileSync } = require('node:child_process')
const defaultUserName = require('../common/default-user-name')
const maxConfigLength = 4 * 1024 * 1024

const unprotectScript = `
$ErrorActionPreference = 'Stop'
$key = $null
try {
  Add-Type -AssemblyName 'System.Security, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b03f5f7f11d50a3a'
  $wrapped = [Convert]::FromBase64String([Console]::In.ReadToEnd())
  $key = [System.Security.Cryptography.ProtectedData]::Unprotect($wrapped, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
  if ($key.Length -ne 32) { throw 'Invalid key' }
  [Console]::Out.Write([Convert]::ToBase64String($key))
} catch {
  [Console]::Error.Write('ERR_MACHINE_PROTOCOL_DPAPI')
  exit 1
} finally {
  if ($null -ne $key) { [Array]::Clear($key, 0, $key.Length) }
}
`

function invalidConfig () {
  return Object.assign(new Error('Invalid protocol registration configuration'), { code: 'ERR_MACHINE_PROTOCOL_CONFIG' })
}

function decodeBase64 (value) {
  if (typeof value !== 'string' || !value || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw invalidConfig()
  const bytes = Buffer.from(value, 'base64')
  if (bytes.toString('base64') !== value) {
    bytes.fill(0)
    throw invalidConfig()
  }
  return bytes
}

function decryptProfileConfig (value, profile, systemDirectory) {
  if (!value.startsWith('v2:safe:')) return value
  if (typeof systemDirectory !== 'string' || !path.win32.isAbsolute(systemDirectory)) throw invalidConfig()
  const cipher = decodeBase64(value.slice('v2:safe:'.length))
  if (cipher.length < 31 || cipher.subarray(0, 3).toString() !== 'v10') throw invalidConfig()
  const fd = fs.openSync(path.join(profile, 'Local State'), 'r')
  let state
  try {
    const size = fs.fstatSync(fd).size
    if (size > maxConfigLength) throw invalidConfig()
    const bytes = Buffer.alloc(size + 1)
    let total = 0
    while (total < bytes.length) {
      const count = fs.readSync(fd, bytes, total, bytes.length - total, null)
      if (!count) break
      total += count
    }
    if (total > size) throw invalidConfig()
    state = JSON.parse(bytes.subarray(0, total).toString('utf8'))
  } finally {
    fs.closeSync(fd)
  }
  const wrapped = decodeBase64(state.os_crypt?.encrypted_key)
  if (wrapped.length <= 5 || wrapped.length > 16384 || wrapped.subarray(0, 5).toString() !== 'DPAPI') throw invalidConfig()
  let output
  let key
  let plaintext
  let pending
  let tail
  try {
    try {
      output = execFileSync(path.win32.join(systemDirectory, 'WindowsPowerShell', 'v1.0', 'powershell.exe'), [
        '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(unprotectScript, 'utf16le').toString('base64')
      ], {
        input: wrapped.subarray(5).toString('base64'),
        windowsHide: true,
        timeout: 10000,
        maxBuffer: 4096,
        stdio: ['pipe', 'pipe', 'pipe']
      })
    } catch (error) {
      if (Buffer.isBuffer(error.stdout)) error.stdout.fill(0)
      if (Buffer.isBuffer(error.stderr)) error.stderr.fill(0)
      throw invalidConfig()
    }
    key = decodeBase64(output.toString('utf8'))
    if (key.length !== 32) throw invalidConfig()
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, cipher.subarray(3, 15))
    decipher.setAuthTag(cipher.subarray(-16))
    pending = decipher.update(cipher.subarray(15, -16))
    tail = decipher.final()
    plaintext = Buffer.concat([pending, tail])
    return plaintext.toString('utf8')
  } finally {
    output?.fill(0)
    key?.fill(0)
    plaintext?.fill(0)
    pending?.fill(0)
    tail?.fill(0)
  }
}

function readDeepLinkAutoRegister (appData, dirName, systemDirectory) {
  const profile = path.join(appData, dirName)
  const file = path.join(profile, 'users', defaultUserName, 'electerm_data.db')
  try {
    fs.statSync(file)
  } catch (error) {
    if (error.code === 'ENOENT') return true
    throw error
  }
  const { DatabaseSync } = require('node:sqlite')
  const db = new DatabaseSync(file, { readOnly: true })
  let row
  try {
    row = db.prepare('SELECT CASE WHEN length(CAST(data AS BLOB)) <= ? THEN data END AS data FROM data WHERE _id = ?')
      .get(maxConfigLength, 'userConfig')
  } finally {
    db.close()
  }
  if (!row) return true
  if (typeof row.data !== 'string' || Buffer.byteLength(row.data, 'utf8') > maxConfigLength) throw invalidConfig()
  const value = row.data.startsWith('enc:') ? decryptProfileConfig(row.data.slice(4), profile, systemDirectory) : row.data
  const config = JSON.parse(value)
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw invalidConfig()
  return config.deepLinkAutoRegister !== false
}

module.exports = { readDeepLinkAutoRegister }
