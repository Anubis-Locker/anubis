const { randomUUID } = require('node:crypto')

function isWebsiteUrl (value) {
  try {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol)
  } catch {
    return false
  }
}

function setupEmbeddedWebsites ({ contents, app, ipcMain, session }) {
  const guests = new Set()
  const challenges = new Map()
  const partitions = new Map()
  const trusted = event => !contents.isDestroyed() &&
    event.sender === contents && event.senderFrame === contents.mainFrame
  const emit = value => {
    if (!contents.isDestroyed()) contents.send('anubis-website-auth', value)
  }
  const finish = (id, username, password) => {
    const challenge = challenges.get(id)
    if (!challenge) return
    challenges.delete(id)
    clearTimeout(challenge.timer)
    if (username === undefined && password === undefined) challenge.callback()
    else challenge.callback(username, password)
  }
  const allocate = event => {
    if (!trusted(event)) throw new Error('Untrusted website host')
    if (partitions.size >= 32) throw new Error('Too many embedded websites')
    const partition = 'anubis-website-' + randomUUID()
    const isolated = session.fromPartition(partition)
    isolated.setPermissionRequestHandler((_contents, _permission, done) => done(false))
    isolated.setPermissionCheckHandler(() => false)
    isolated.webRequest.onBeforeSendHeaders((details, done) => {
      const headers = { ...details.requestHeaders }
      for (const name of Object.keys(headers)) {
        if (name.toLowerCase() === 'x-anubis-managed-transport') delete headers[name]
      }
      done({ requestHeaders: headers })
    })
    partitions.set(partition, { session: isolated, attached: false })
    return partition
  }
  const release = (event, partition) => {
    if (!trusted(event)) throw new Error('Untrusted website host')
    if (typeof partition !== 'string') throw new Error('Invalid website partition')
    const entry = partitions.get(partition)
    if (!entry) return
    partitions.delete(partition)
    for (const guest of guests) {
      if (guest.session === entry.session && !guest.isDestroyed()) guest.close()
    }
    entry.session.webRequest.onBeforeSendHeaders(null)
  }
  const auth = (event, value) => {
    if (!trusted(event)) throw new Error('Untrusted website host')
    if (!value || typeof value.id !== 'string' ||
        typeof value.username !== 'string' || typeof value.password !== 'string' ||
        value.username.length > 4096 || value.password.length > 4096) {
      throw new Error('Invalid website authentication response')
    }
    if (!challenges.has(value.id)) throw new Error('Website authentication request expired')
    if (!value.username && !value.password) finish(value.id)
    else finish(value.id, value.username, value.password)
  }
  const channel = 'anubis-website'
  ipcMain.handle(channel + '-allocate', allocate)
  ipcMain.handle(channel + '-release', release)
  ipcMain.handle(channel + '-auth', auth)
  const attach = (event, preferences, params) => {
    const entry = partitions.get(params.partition)
    if (!entry || entry.attached || !isWebsiteUrl(params.src)) {
      event.preventDefault()
      return
    }
    entry.attached = true
    delete preferences.preload
    delete preferences.preloadURL
    Object.assign(preferences, {
      partition: params.partition,
      session: entry.session,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      nodeIntegrationInWorker: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      devTools: false,
      enableRemoteModule: false,
      additionalArguments: []
    })
  }
  const attached = (_event, guest) => {
    const pair = [...partitions].find(([, value]) => value.session === guest.session)
    const entry = pair?.[1]
    if (!entry || guest.session === contents.session) {
      guest.close()
      return
    }
    guests.add(guest)
    const navigate = (event, url) => {
      if (!isWebsiteUrl(url)) event.preventDefault()
    }
    guest.on('will-navigate', navigate)
    guest.on('will-redirect', navigate)
    guest.setWindowOpenHandler(({ url }) => {
      if (isWebsiteUrl(url)) {
        guest.loadURL(url).catch(error => {
          if (error.code === 'ERR_ABORTED' || error.errno === -3) return
          if (!contents.isDestroyed()) {
            contents.send('anubis-website-error', { partition: pair[0], code: error.code || 'ERR_WEBSITE_LOAD' })
          }
        })
      }
      return { action: 'deny' }
    })
    guest.once('destroyed', () => {
      guests.delete(guest)
      partitions.delete(pair[0])
      entry.session.webRequest.onBeforeSendHeaders(null)
      for (const [id, challenge] of challenges) {
        if (challenge.guest === guest) finish(id)
      }
    })
  }
  const login = (event, guest, _request, authInfo, callback) => {
    if (!guests.has(guest)) return
    event.preventDefault()
    const id = randomUUID()
    const partition = [...partitions].find(([, entry]) => entry.session === guest.session)?.[0]
    const timer = setTimeout(() => { finish(id); emit({ id, partition, cancelled: true }) }, 60000)
    challenges.set(id, { guest, callback, timer })
    emit({ id, partition, host: authInfo.host, realm: authInfo.realm, isProxy: authInfo.isProxy })
  }
  contents.on('will-attach-webview', attach)
  contents.on('did-attach-webview', attached)
  app.on('login', login)
  return () => {
    contents.removeListener('will-attach-webview', attach)
    contents.removeListener('did-attach-webview', attached)
    app.removeListener('login', login)
    ipcMain.removeHandler(channel + '-allocate')
    ipcMain.removeHandler(channel + '-release')
    ipcMain.removeHandler(channel + '-auth')
    for (const id of challenges.keys()) finish(id)
    for (const guest of guests) if (!guest.isDestroyed()) guest.close()
    for (const entry of partitions.values()) entry.session.webRequest.onBeforeSendHeaders(null)
    partitions.clear()
  }
}

module.exports = { setupEmbeddedWebsites, isWebsiteUrl }
