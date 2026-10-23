const { copyFileSync, mkdirSync, statSync } = require('fs')
const { join } = require('path')

function copyWindowsTerminalRuntime (ptyDir, releaseDir, arch) {
  statSync(join(releaseDir, 'conpty.node'))
  const sourceDir = join(ptyDir, 'prebuilds', `win32-${arch}`, 'conpty')
  const files = ['conpty.dll', 'OpenConsole.exe']
  for (const file of files) {
    if (statSync(join(sourceDir, file)).size === 0) {
      throw new Error(`Empty Windows terminal runtime: ${join(sourceDir, file)}`)
    }
  }
  const destination = join(releaseDir, 'conpty')
  mkdirSync(destination, { recursive: true })
  for (const file of files) copyFileSync(join(sourceDir, file), join(destination, file))
}

module.exports = { copyWindowsTerminalRuntime }
