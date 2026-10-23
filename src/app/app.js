/**
 * app entry
 */
if (process.argv.some(arg => ['--anubis-machine-host', '--anubis-context-worker'].includes(arg))) {
  startMachineRuntime()
} else {
  startDesktop()
}

function startMachineRuntime () {
  try {
    const invocation = require('./lib/machine-runtime-contract').parseMachineInvocation(process.argv.slice(1))
    require('./lib/machine-host-entry').startMachineHost(invocation).catch(() => {
      process.stderr.write('Machine runtime initialization failed\n')
      require('electron').app.exit(1)
    })
  } catch {
    process.stderr.write('Invalid machine runtime invocation\n')
    require('electron').app.exit(1)
  }
}

function startDesktop () {
  const { app: electronApp } = require('electron')
  const path = require('path')
  const marker = path.join(path.dirname(process.execPath), 'anubis-machine-install.json')
  const machineInstalled = process.platform === 'win32' && require('fs').existsSync(marker)
  if (process.platform === 'win32' &&
      (process.argv.includes('--anubis-machine-client') ||
      (!process.argv.includes('--standalone') && machineInstalled))) {
    require('./lib/machine-client-entry').startMachineClient().catch(() => {
      require('electron').dialog.showErrorBox('Anubis-Security-Tool', 'Windows machine client initialization failed. Check the protected installation and service.')
      electronApp.exit(1)
    })
    return
  }
  if (machineInstalled) process.env.ANUBIS_ADMIN_MANAGED_ENABLED = '0'
  const { dialog } = require('electron')
  const log = require('./common/log')
  const { createApp } = require('./lib/create-app')
  const globalState = require('./lib/glob-state')
  const brand = require('./common/brand')

  globalState.set('initTime', Date.now())

  log.debug(brand.id + ' start')

  // createApp() is async, so anything thrown inside it (a failed require, an
  // unreadable config, a bad platform integration) used to surface only as an
  // UnhandledPromiseRejection while the app silently never opened a window.
  // Fail loudly instead, so the next one of these is diagnosable from the message.
  const app = createApp().catch((err) => {
    log.error('Failed to start ' + brand.name + ':', err)
    try {
      dialog.showErrorBox(
        brand.name,
      `Failed to start ${brand.name}:\n\n${err?.stack || err}`
      )
    } catch (_) {}
    process.exit(1)
  })
  globalState.set('app', app)
}
