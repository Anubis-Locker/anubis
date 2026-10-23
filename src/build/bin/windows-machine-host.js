const { execFileSync } = require('node:child_process')
const { existsSync, readFileSync, unlinkSync } = require('node:fs')
const { join, resolve } = require('node:path')

function copyWindowsMachineHost (context, arch, execute = execFileSync) {
  const marker = join(context.appOutDir, 'anubis-machine-install.json')
  if (existsSync(marker)) unlinkSync(marker)
  const destination = join(context.appOutDir, 'anubis-host.exe')
  if (arch !== 'x64') {
    if (existsSync(destination)) unlinkSync(destination)
    return
  }
  const root = resolve(__dirname, '../../..')
  execute(process.env.ANUBIS_GO || 'go', [
    'build', '-trimpath', '-buildvcs=false', '-o', destination, '.'
  ], {
    cwd: join(root, 'native', 'windows-host'),
    env: { ...process.env, GOOS: 'windows', GOARCH: 'amd64', CGO_ENABLED: '0' },
    stdio: 'inherit'
  })
  const image = readFileSync(destination)
  const pe = image.readUInt32LE(0x3c)
  if (image.toString('ascii', 0, 2) !== 'MZ' ||
      image.toString('ascii', pe, pe + 4) !== 'PE\0\0' ||
      image.readUInt16LE(pe + 4) !== 0x8664) {
    throw new Error('Windows machine host must be a freshly built amd64 PE executable')
  }
}

module.exports = { copyWindowsMachineHost }
