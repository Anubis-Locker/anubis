const { spawnSync } = require('node:child_process')
const { join } = require('node:path')

const schemes = ['anubis', 'ssh', 'telnet', 'vnc', 'rdp', 'spice', 'serial', 'ftp']

function commandFor (key) {
  const result = spawnSync('reg.exe', ['query', key + '\\shell\\open\\command', '/ve'], { encoding: 'utf8' })
  if (result.error) throw result.error
  if (result.status === 1) return null
  if (result.status !== 0) throw new Error(result.stderr || 'Cannot query protocol registration')
  return result.stdout.match(/REG_(?:EXPAND_)?SZ\s+(.+)/)?.[1]?.trim() || null
}

function runRegistry (args) {
  const result = spawnSync('reg.exe', args, { encoding: 'utf8' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(result.stderr || `Registry operation failed: ${args[0]}`)
}

function snapshotWindowsProtocols (dir, ownedPaths) {
  if (process.platform !== 'win32') return { restore () {} }
  const snapshots = schemes.map(scheme => {
    const key = 'HKCU\\Software\\Classes\\' + scheme
    const file = join(dir, scheme + '.reg')
    const query = spawnSync('reg.exe', ['query', key], { encoding: 'utf8' })
    if (query.error) throw query.error
    if (![0, 1].includes(query.status)) throw new Error(query.stderr || 'Cannot snapshot protocol registration')
    const exists = query.status === 0
    if (exists) runRegistry(['export', key, file, '/y'])
    return { key, file, exists, command: commandFor(key) }
  })
  return {
    restore () {
      for (const snapshot of snapshots) {
        const command = commandFor(snapshot.key)
        if (command === snapshot.command) continue
        const owned = ownedPaths.some(path => command?.toLowerCase().includes(path.toLowerCase()))
        if (!owned) throw new Error(`Protocol registration changed outside the acceptance test: ${snapshot.key}`)
        runRegistry(['delete', snapshot.key, '/f'])
        if (snapshot.exists) runRegistry(['import', snapshot.file])
      }
    }
  }
}

module.exports = { snapshotWindowsProtocols }
