#!/usr/bin/env node
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

function publishUpdate (inputFile, outDir) {
  const raw = JSON.parse(fs.readFileSync(inputFile, 'utf8'))
  const release = raw.release || raw
  if (!release || !/^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(release.tag_name) ||
      release.draft || release.prerelease || !Array.isArray(release.assets) || release.assets.length === 0) {
    throw new Error('A published stable release with downloadable assets is required')
  }
  for (const asset of release.assets) {
    if (typeof asset.name !== 'string' || !asset.name ||
        path.basename(asset.name) !== asset.name || path.win32.basename(asset.name) !== asset.name ||
        /[<>:"/\\|?*]/.test(asset.name) || /[. ]$/.test(asset.name) ||
        Array.from(asset.name).some(char => char.charCodeAt(0) < 32) ||
        !Number.isSafeInteger(asset.size) || asset.size <= 0 ||
        new URL(asset.browser_download_url).protocol !== 'https:') {
      throw new Error('Invalid release asset')
    }
    if (asset.windows_machine_host !== undefined &&
        (asset.windows_machine_host !== 1 || !asset.name.endsWith('-win-x64-installer.exe') ||
        !/^sha256:[a-f0-9]{64}$/i.test(asset.digest))) {
      throw new Error('Invalid Windows machine-host update declaration')
    }
  }
  const dataDir = path.join(outDir, 'data')
  fs.mkdirSync(dataDir, { recursive: true })
  const primary = path.join(dataDir, 'anubis-release.json')
  let previous = {}
  try {
    previous = JSON.parse(fs.readFileSync(primary, 'utf8'))
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  const json = JSON.stringify({ ...previous, release }, null, 2) + '\n'
  const lock = path.join(outDir, '.publish-update.lock')
  fs.mkdirSync(lock)
  function writeAtomic (file, content) {
    const temporary = file + '.' + crypto.randomBytes(8).toString('hex') + '.tmp'
    try {
      fs.writeFileSync(temporary, content, { flag: 'wx', mode: 0o644 })
      fs.renameSync(temporary, file)
    } finally {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary)
    }
  }
  try {
    writeAtomic(primary, json)
    writeAtomic(path.join(dataDir, 'anubis-github-release.json'), json)
    writeAtomic(path.join(outDir, 'version.html'), release.tag_name + '\n')
  } finally {
    fs.rmdirSync(lock)
  }
  return release.tag_name
}

if (require.main === module) {
  try {
    if (!process.argv[2]) throw new Error('Usage: publish-update.js <release.json> [update-directory]')
    const version = publishUpdate(process.argv[2], process.argv[3] || process.env.ANUBIS_UPDATE_DIR || '/var/www/anubis/update')
    console.log(`Published update metadata for ${version}`)
  } catch (error) {
    console.error('Update publication failed:', error.message)
    process.exitCode = 1
  }
}

module.exports = { publishUpdate }
