const { createManagedRuntime } = require('./managed-access')

function startDesktopManaged ({
  app,
  child,
  port,
  header,
  globalState,
  log,
  createAgent,
  env = process.env
}) {
  let agent
  let stopping
  let quitAllowed = false
  const onStatus = (status) => {
    const visible = {
      id: status.id,
      status: status.status,
      fingerprint: status.fingerprint,
      url: status.url,
      error: status.error
    }
    globalState.set('managedConnectivity', visible)
    log.info('Managed connectivity:', visible.status, visible.error || '')
    const win = globalState.get('win')
    if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send('managed-connectivity', visible)
    }
  }
  const stop = () => {
    if (!stopping) {
      stopping = Promise.resolve().then(() => agent?.stop())
      stopping.catch(error => log.warn('Managed connectivity shutdown failed:', error.message))
    }
    return stopping
  }
  if (['0', 'false', 'off'].includes(String(env.ANUBIS_ADMIN_MANAGED_ENABLED).toLowerCase())) {
    onStatus({ status: 'disabled' })
    return { stop }
  }
  try {
    agent = createManagedRuntime({
      createAgent: createAgent || require('@ai-security-tool/managed-access').createAgent,
      userData: app.getPath('userData'),
      port,
      header,
      version: app.getVersion(),
      onStatus,
      env
    })
    agent.start()
  } catch (error) {
    onStatus({ status: 'offline', error: error.message })
    log.error('Managed connectivity failed to start:', error.message)
  }
  child.once('exit', stop)
  app.on('before-quit', event => {
    if (quitAllowed) return
    event.preventDefault()
    const timer = setTimeout(() => {
      log.warn('Managed connectivity shutdown exceeded 5 seconds')
      quitAllowed = true
      app.quit()
    }, 5000)
    stop().catch(() => {}).finally(() => {
      clearTimeout(timer)
      if (!quitAllowed) {
        quitAllowed = true
        app.quit()
      }
    })
  })
  return { stop }
}

module.exports = { startDesktopManaged }
