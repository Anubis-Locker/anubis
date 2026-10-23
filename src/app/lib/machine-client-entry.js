const fs = require('node:fs')
const path = require('node:path')
const { execFileSync, execFile } = require('node:child_process')
const {
  serviceNameFromArgs, readInstallerMarker, requestHost, prepareWindowsUpdate,
  launchPreparedWindowsUpdate, discardPreparedWindowsUpdate, validateDescriptor, isContextUrl
} = require('./windows-host-client')
const { cleanRuntimeEnvironment } = require('./machine-host-entry')
const { createMachineConnection } = require('./machine-client-connection')
const { checkMachineUpdate, installMachineUpdate } = require('./machine-client-update')
const { parseMachineIntent, connectionArguments, intentScript, describeIntent, quoteWindowsArgument } = require('./machine-client-intent')

async function startMachineClient () {
  const { app, BrowserWindow, WebContentsView, ipcMain, shell, dialog } = require('electron')
  cleanRuntimeEnvironment(process.env)
  const installDir = path.dirname(process.execPath)
  const helper = path.join(installDir, 'anubis-host.exe')
  const execute = args => JSON.parse(execFileSync(helper, args, {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 10000,
    maxBuffer: 32768,
    stdio: ['ignore', 'pipe', 'pipe']
  }))
  const validated = execute(['validate-install', '--install-dir', installDir,
    '--runtime-relative-path', path.basename(process.execPath)])
  if (validated.valid !== true) throw new Error('Protected Windows installation is required')
  const serviceName = serviceNameFromArgs(process.argv, readInstallerMarker(installDir))
  const actor = execute(['identity'])
  if (actor.sid === 'S-1-5-18' || actor.sessionId === 0) throw new Error('The GUI must run in an interactive user session')
  if (typeof actor.systemDirectory !== 'string' || !path.win32.isAbsolute(actor.systemDirectory)) {
    throw new Error('Native Windows system directory is required')
  }
  const brand = require('../common/brand')
  app.setName(brand.id)
  const clientDir = brand.data.dirName + '-client' + (serviceName === 'AnubisHost' ? '' : '-' + serviceName)
  const userData = path.join(app.getPath('appData'), clientDir)
  fs.mkdirSync(userData, { recursive: true })
  app.setPath('userData', userData)
  const instanceData = { version: 1, argv: process.argv, cwd: process.cwd() }
  if (!app.requestSingleInstanceLock(instanceData)) {
    app.quit()
    return
  }
  const earlyRequests = []
  let earlyOverflow = false
  let receiveSecondInstance = (argv, cwd) => {
    if (earlyRequests.length < 8) earlyRequests.push({ argv, cwd })
    else earlyOverflow = true
  }
  app.on('second-instance', (_event, argv, cwd, data) => {
    if (data?.version === 1 && Array.isArray(data.argv) && typeof data.cwd === 'string') {
      return receiveSecondInstance(data.argv, data.cwd)
    }
    return receiveSecondInstance(argv, cwd)
  })
  await app.whenReady()
  const win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 900,
    minHeight: 600,
    title: brand.name,
    backgroundColor: '#17191d',
    webPreferences: {
      preload: path.resolve(__dirname, '../preload/machine-client.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  let view
  let sessions = []
  let updateController
  const intents = []
  let intentBusy = false
  let enqueuing = 0
  let enqueueChain = Promise.resolve()
  let lastIntentCode
  const lifecycle = new AbortController()
  const failure = code => ({ ok: false, code, elevationRequired: !actor.elevated })
  const send = value => {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send('machine-client-state', value)
  }
  const clearView = () => {
    if (!view) return
    const previous = view
    view = null
    if (!win.isDestroyed()) win.contentView.removeChildView(previous)
    if (!previous.webContents.isDestroyed()) {
      previous.webContents.session.webRequest.onBeforeSendHeaders(null)
      previous.webContents.close({ waitForBeforeUnload: false })
    }
  }
  const fit = () => {
    if (!view) return
    const [width, height] = win.getContentSize()
    view.setBounds({ x: 0, y: 52, width, height: Math.max(1, height - 52) })
  }
  const trusted = event => event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame
  const intentState = value => {
    lastIntentCode = value.code
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send('machine-client-intent-state', { pending: intents.length, ...value })
    }
  }
  const appendIntent = async (argv, cwd) => {
    try {
      if (serviceNameFromArgs(argv, { version: 1, serviceName }) !== serviceName) {
        throw Object.assign(new Error('Different service'), { code: 'ERR_HOST_SERVICE_NAME' })
      }
      if (intents.length >= 8) throw Object.assign(new Error('Too many requests'), { code: 'ERR_HOST_INTENT_LIMIT' })
      const args = connectionArguments(argv.slice(1))
      const intent = await parseMachineIntent(args, cwd, { version: app.getVersion(), cli: brand.cliName })
      if (intent && !lifecycle.signal.aborted) intents.push({ intent, args, cwd })
      intentState({})
    } catch (error) {
      intentState({ code: error.code?.startsWith('ERR_HOST_INTENT_') ? error.code : 'ERR_HOST_INTENT_ARGUMENTS' })
    }
  }
  const enqueue = (argv, cwd) => {
    if (intents.length + enqueuing >= 8) {
      intentState({ code: 'ERR_HOST_INTENT_LIMIT' })
      return Promise.resolve()
    }
    enqueuing++
    const result = enqueueChain.then(() => appendIntent(argv, cwd))
      .finally(() => { enqueuing-- })
    enqueueChain = result
    return result
  }
  ipcMain.handle('machine-client-intent-clear', event => {
    if (!trusted(event)) return failure('ERR_HOST_CLIENT_ORIGIN')
    if (intentBusy) return failure('ERR_HOST_INTENT_BUSY')
    intents.length = 0
    intentState({})
    return { ok: true }
  })
  ipcMain.handle('machine-client-intent', async event => {
    if (!trusted(event)) return failure('ERR_HOST_CLIENT_ORIGIN')
    if (intentBusy) return failure('ERR_HOST_INTENT_BUSY')
    if (!intents.length) return failure('ERR_HOST_INTENT_EMPTY')
    intentBusy = true
    try {
      const { intent } = intents[0]
      if (intent.kind === 'help') {
        await dialog.showMessageBox(win, { type: 'info', message: brand.name, detail: intent.text })
      } else {
        const current = connection.getContext()
        const selectedView = view
        if (!current || !selectedView) return failure('ERR_HOST_INTENT_CONTEXT')
        const ready = await selectedView.webContents.executeJavaScript(
          'Boolean(window.store && !window.store.initLoadingData && window.et?.wsOpened)')
        if (!ready) return failure('ERR_HOST_INTENT_LOGIN')
        const { account, sid, sessionId } = current.identity
        const { response } = await dialog.showMessageBox(win, {
          type: 'question',
          buttons: ['Open connection', 'Cancel'],
          defaultId: 1,
          cancelId: 1,
          message: 'Open the requested connection in ' + account + '?',
          detail: 'Destination: ' + describeIntent(intent) + '\nWindows identity: ' + sid + ', session ' + sessionId +
            '. External connection parameters and credentials will be sent to this workspace, not the account that opened the link or file.' +
            (intent.warningCount
              ? '\nThe SPICE file has ' + intent.warningCount + ' parser warning(s). Invalid or unsupported options may be ignored; short-lived tickets can expire while awaiting confirmation.'
              : '')
        })
        if (response !== 0) {
          intents.shift()
          intentState({ phase: 'cancelled' })
          return { ok: true, phase: 'cancelled' }
        }
        if (view !== selectedView || connection.getContext()?.contextId !== current.contextId) {
          return failure('ERR_HOST_CONTEXT_REPLACED')
        }
        if (!await selectedView.webContents.executeJavaScript(intentScript(intent))) {
          return failure('ERR_HOST_INTENT_LOGIN')
        }
      }
      intents.shift()
      intentState({ phase: 'opened' })
      return { ok: true, phase: 'opened' }
    } catch {
      return failure('ERR_HOST_INTENT_FAILED')
    } finally {
      intentBusy = false
    }
  })
  const updateState = state => {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send('machine-client-update-state', state)
  }
  ipcMain.handle('machine-client-update', async event => {
    if (!trusted(event)) return failure('ERR_HOST_CLIENT_ORIGIN')
    if (!actor.elevated) return failure('ERR_HOST_UPDATE_ELEVATION')
    if (updateController) return failure('ERR_HOST_UPDATE_BUSY')
    updateController = new AbortController()
    try {
      updateState({ phase: 'checking' })
      const update = await checkMachineUpdate(brand, app.getVersion())
      if (win.isDestroyed()) return failure('ERR_HOST_CONTEXT_REPLACED')
      if (!update.available) return { ok: true, phase: 'current' }
      if (serviceName !== 'AnubisHost') return failure('ERR_HOST_UPDATE_QA_EDITION')
      const { response } = await dialog.showMessageBox(win, {
        type: 'question',
        buttons: ['Install update', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        message: 'Install Anubis-Security-Tool ' + update.version + '?',
        detail: 'The GUI will close after the installer starts. The installer will restart the machine service and preserve machine and Windows-user profiles.'
      })
      if (response !== 0) return { ok: true, phase: 'cancelled' }
      await installMachineUpdate(update, {
        tempDir: app.getPath('temp'),
        prepare: (file, update) => prepareWindowsUpdate(helper, serviceName, file, update),
        discard: file => discardPreparedWindowsUpdate(file, serviceName),
        launch: launchPreparedWindowsUpdate,
        notify: updateState,
        signal: updateController.signal
      })
      app.quit()
      return { ok: true, phase: 'launched' }
    } catch (error) {
      const allowed = ['METADATA', 'VERSION', 'COMPATIBILITY', 'INTEGRITY', 'URL', 'DISABLED',
        'DOWNLOAD', 'PREPARE', 'LAUNCH', 'CLEANUP'].map(code => 'ERR_HOST_UPDATE_' + code)
      return failure(allowed.includes(error.code) ? error.code : 'ERR_HOST_UPDATE_FAILED')
    } finally {
      updateController = null
    }
  })
  ipcMain.handle('machine-client-list', async event => {
    if (!trusted(event)) return failure('ERR_HOST_CLIENT_ORIGIN')
    try {
      const values = await requestHost(helper, serviceName, { version: 1, operation: 'list-sessions' }, { signal: lifecycle.signal })
      if (!Array.isArray(values)) return failure('ERR_HOST_RESPONSE')
      sessions = values.filter(value => Number.isInteger(value.id) && value.id > 0 &&
        [0, 4].includes(value.state) && typeof value.account === 'string' && typeof value.sid === 'string')
      return {
        ok: true,
        pending: intents.length,
        intentCode: lastIntentCode,
        sessions: sessions.map(({ id, account, sid, error }) => ({ id, account, sid, error: !!error }))
      }
    } catch (error) {
      return failure(error.code === 'ERR_HOST_RESPONSE' ? error.code : 'ERR_HOST_UNAVAILABLE')
    }
  })
  const connection = createMachineConnection({
    async resolve ({ target, user }, signal) {
      if (user) {
        const values = await requestHost(helper, serviceName, { version: 1, operation: 'list-sessions' }, { signal })
        if (!Array.isArray(values) || !values.some(value => value.id === user.id &&
            value.sid === user.sid && [0, 4].includes(value.state) && !value.error)) {
          throw Object.assign(new Error('Selected Windows session has changed'), { code: 'ERR_HOST_CONTEXT_IDENTITY' })
        }
      }
      return validateDescriptor(await requestHost(helper, serviceName, {
        version: 1,
        operation: 'launch-context',
        target: target.target,
        ...(user ? { sessionId: user.id } : {})
      }, { signal }), target, user?.sid)
    },
    async attach (selected) {
      const next = new WebContentsView({
        webPreferences: {
          partition: 'anubis-context-' + selected.contextId + '-' + require('node:crypto').randomUUID(),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          devTools: false
        }
      })
      view = next
      win.contentView.addChildView(next)
      fit()
      next.webContents.session.webRequest.onBeforeSendHeaders((details, done) => {
        const headers = { ...details.requestHeaders }
        for (const name of Object.keys(headers)) {
          if (name.toLowerCase() === 'x-anubis-managed-transport') delete headers[name]
        }
        if (isContextUrl(details.url, selected.endpoint.localPort)) {
          headers['x-anubis-managed-transport'] = selected.endpoint.privateProof
        }
        done({ requestHeaders: headers })
      })
      const external = url => {
        if (/^https?:\/\//i.test(url)) {
          shell.openExternal(url).catch(() => send(failure('ERR_HOST_EXTERNAL_LINK')))
        }
      }
      next.webContents.setWindowOpenHandler(({ url }) => {
        external(url)
        return { action: 'deny' }
      })
      next.webContents.on('will-navigate', (event, url) => {
        if (!isContextUrl(url, selected.endpoint.localPort)) {
          event.preventDefault()
          external(url)
        }
      })
      next.webContents.on('render-process-gone', () => {
        if (view === next) {
          connection.invalidate()
          send(failure('ERR_HOST_CLIENT_RENDERER'))
        }
      })
      await next.webContents.loadURL(`http://127.0.0.1:${selected.endpoint.localPort}/`)
      if (view !== next) throw new Error('Selected Windows context was replaced')
    },
    clear: clearView,
    notify: value => send(value.ok ? value : { ...failure(value.code), reconnecting: value.reconnecting })
  })
  ipcMain.handle('machine-client-connect', async (event, target) => {
    if (!trusted(event)) return failure('ERR_HOST_CLIENT_ORIGIN')
    const user = target?.target === 'user' && sessions.find(value => value.id === target.sessionId && !value.error)
    if (!target || !['system', 'user'].includes(target.target) ||
        Object.keys(target).some(key => !['target', 'sessionId'].includes(key)) ||
        (target.target === 'user' && !user)) return failure('ERR_HOST_CONTEXT_SELECTION')
    const result = await connection.select({ target: { ...target }, user: user && { ...user } })
    return result.ok ? result : { ...failure(result.code), reconnecting: result.reconnecting }
  })
  ipcMain.handle('machine-client-elevate', async event => {
    if (!trusted(event)) return failure('ERR_HOST_CLIENT_ORIGIN')
    if (actor.elevated) return failure('ERR_HOST_ALREADY_ELEVATED')
    if (intentBusy || enqueuing) return failure('ERR_HOST_INTENT_BUSY')
    if (intents.length > 1) return failure('ERR_HOST_INTENT_MULTIPLE')
    const quote = value => "'" + value.replace(/'/g, "''") + "'"
    const args = ['--anubis-machine-client', '--anubis-service-name', serviceName, ...(intents[0]?.args || [])]
      .map(quoteWindowsArgument).join(' ')
    if (args.length > 30000) return failure('ERR_HOST_INTENT_ARGUMENTS')
    const script = '$ErrorActionPreference=\'Stop\'; Start-Process -FilePath ' + quote(process.execPath) +
      ' -Verb RunAs -ArgumentList ' + quote(args) +
      (intents[0] ? ' -WorkingDirectory ' + quote(intents[0].cwd) : '')
    app.releaseSingleInstanceLock()
    try {
      await new Promise((resolve, reject) => {
        execFile(path.join(actor.systemDirectory, 'WindowsPowerShell', 'v1.0', 'powershell.exe'), [
          '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')
        ], { windowsHide: true, timeout: 120000 }, error => error ? reject(error) : resolve())
      })
      app.quit()
      return { ok: true }
    } catch {
      if (!app.requestSingleInstanceLock(instanceData)) app.quit()
      return failure('ERR_HOST_ELEVATION_CANCELLED')
    }
  })
  win.on('resize', fit)
  win.on('closed', () => {
    updateController?.abort()
    lifecycle.abort()
    intents.length = 0
    connection.dispose()
  })
  receiveSecondInstance = (argv, cwd) => {
    if (win.isMinimized()) win.restore()
    win.focus()
    return enqueue(argv, cwd)
  }
  app.on('window-all-closed', () => app.quit())
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  await enqueue(process.argv, process.cwd())
  for (const request of earlyRequests) await enqueue(request.argv, request.cwd)
  await win.loadFile(path.resolve(__dirname, '../machine-client.html'))
  if (earlyOverflow) intentState({ code: 'ERR_HOST_INTENT_LIMIT' })
  return { win, getContext: connection.getContext }
}

module.exports = { startMachineClient }
