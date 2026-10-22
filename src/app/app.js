/**
 * app entry
 */
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
