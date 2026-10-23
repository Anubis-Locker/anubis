#!/usr/bin/env node
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

async function prepareRelease (input, output, version) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version || '')) {
    throw new Error('A valid release version is required')
  }
  const suffixes = [
    'win-x64-installer.exe', 'win-x64-portable.tar.gz', 'win-x64.tar.gz',
    'linux-amd64.deb', 'linux-x64.tar.gz', 'linux-x86_64.AppImage',
    'mac-x64.dmg', 'mac-arm64.dmg'
  ]
  const required = suffixes.map(suffix => `anubis-${version}-${suffix}`)
  const allowed = new Set(required.flatMap(name => [name, `${name}.blockmap`]))
  const found = new Map()
  function walk (directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name)
      if (entry.isSymbolicLink()) throw new Error('Release artifacts must not contain symbolic links')
      if (entry.isDirectory()) walk(file)
      else if (entry.isFile() && allowed.has(entry.name)) {
        if (found.has(entry.name)) throw new Error(`Duplicate release artifact: ${entry.name}`)
        if (fs.statSync(file).size === 0) throw new Error(`Empty release artifact: ${entry.name}`)
        found.set(entry.name, file)
      }
    }
  }
  walk(input)
  for (const name of required) {
    if (!found.has(name)) throw new Error(`Missing release artifact: ${name}`)
  }
  fs.mkdirSync(output)
  const checksums = []
  for (const name of [...found.keys()].sort()) {
    const source = found.get(name)
    const destination = path.join(output, name)
    fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL)
    const hash = crypto.createHash('sha256')
    for await (const chunk of fs.createReadStream(destination)) hash.update(chunk)
    checksums.push(`${hash.digest('hex')}  ${name}`)
  }
  fs.writeFileSync(path.join(output, 'SHA256SUMS'), checksums.join('\n') + '\n', { flag: 'wx' })
  return checksums.length
}

if (require.main === module) {
  prepareRelease(...process.argv.slice(2)).then(count => {
    console.log(`Prepared ${count} release artifacts and SHA256SUMS`)
  }).catch(error => {
    console.error('Release preparation failed:', error.message)
    process.exitCode = 1
  })
}

module.exports = { prepareRelease }
