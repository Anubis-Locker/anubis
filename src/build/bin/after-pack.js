const { join } = require('path')
const { copyWindowsTerminalRuntime } = require('./windows-terminal-runtime')
const { copyWindowsMachineHost } = require('./windows-machine-host')

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
  copyWindowsTerminalRuntime(ptyDir, releaseDir, arch)
  copyWindowsMachineHost(context, arch)
}
