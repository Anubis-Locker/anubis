const { copyFileSync, mkdirSync, statSync } = require('fs')
const { join } = require('path')

module.exports = async function afterPack (context) {
  if (context.electronPlatformName !== 'win32') {
    return
  }
  const { Arch } = require('builder-util')
  const arch = Arch[context.arch]
  const ptyDir = join(context.packager.info.appDir, 'node_modules', 'node-pty')
  const releaseDir = join(
    context.appOutDir, 'resources', 'app.asar.unpacked',
    'node_modules', 'node-pty', 'build', 'Release'
  )
  // Rebuild places conpty.node in build/Release, which takes precedence over
  // prebuilds. Its companion DLL and console host must be next to that module.
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
  for (const file of files) {
    copyFileSync(join(sourceDir, file), join(destination, file))
  }
}
