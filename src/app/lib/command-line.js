const { packInfo, isTest } = require('../common/app-props')
const { findVvFile } = require('../common/vv-file')
const brand = require('../common/brand')
const globalState = require('./glob-state')

let program
if (!isTest && !globalState.get('machineRuntimeRole')) {
  program = require('./command-line-options').createCommandLine({ version: packInfo.version, cli: brand.cliName })
  try {
    program.parse()
  } catch (err) {
    if (err.message.includes('outputHelp')) process.exit(0)
  }
}

exports.initCommandLine = function () {
  if (isTest || globalState.get('machineRuntimeRole')) return false
  return {
    options: program.opts(),
    argv: program.args,
    vvFile: findVvFile(process.argv),
    helpInfo: program.helpInformation()
  }
}
