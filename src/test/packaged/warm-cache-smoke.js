const { test } = require('node:test')
const assert = require('node:assert/strict')
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, dirname, resolve } = require('node:path')
const http = require('node:http')
const asar = require('@electron/asar')
const { _electron: electron } = require('playwright')
const { snapshotWindowsProtocols } = require('../integration/lib/windows-protocol-fixture')
const { checkRendererNavigation } = require('./lib/renderer-navigation')

test('same-version reinstall replaces cached entry modules without losing user data', {
  skip: process.platform !== 'win32',
  timeout: 150000
}, async t => {
  const executablePath = resolve(process.env.ANUBIS_SMOKE_EXE || join('dist', 'win-unpacked', 'anubis.exe'))
  const archive = join(dirname(executablePath), 'resources', 'app.asar')
  const version = JSON.parse(asar.extractFile(archive, 'package.json')).version
  const entryPath = `/js/electerm-${version}.js`
  const entry = asar.extractFile(archive, join('assets', 'js', `electerm-${version}.js`)).toString()
  const stale = entry
    .replaceAll(/info-modal-[^"'`/]+\.js/g, `info-modal-${version}-OLD_BUILD.js`)
    .replaceAll(/tab-quick-commands-[^"'`/]+\.js/g, `tab-quick-commands-${version}-OLD_BUILD.js`)
  assert.notEqual(stale, entry, 'fixture must change real lazy-module references')
  const root = mkdtempSync(join(tmpdir(), 'anubis-warm-cache-'))
  const profile = join(root, 'profile')
  const env = {
    ...process.env,
    NODE_ENV: 'production',
    NODE_TEST: '',
    DATA_PATH: join(root, 'data'),
    ANUBIS_ADMIN_AUTOSTART: '0',
    ANUBIS_ADMIN_ERROR_REPORT: '0'
  }
  const protocols = snapshotWindowsProtocols(root, [root, executablePath])
  const errors = []
  let app
  let requests = 0
  const server = http.createServer((req, res) => {
    if (req.url === entryPath) {
      requests++
      res.writeHead(200, {
        'Content-Type': 'text/javascript',
        'Cache-Control': 'public, max-age=31536000'
      })
      res.end(stale)
    } else {
      res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' })
      res.end('<!doctype html><title>Old-build HTTP cache fixture</title>')
    }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const origin = `http://127.0.0.1:${port}`
  const closeServer = async () => {
    if (server.listening) await new Promise(resolve => server.close(resolve))
  }
  const closeApp = async () => {
    if (!app) return
    const current = app
    app = null
    await current.close()
  }
  t.after(async () => {
    if (errors.length) console.error('Renderer errors:', errors)
    try {
      await closeApp()
      await closeServer()
    } finally {
      protocols.restore()
      rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
    }
  })
  async function launchApp () {
    app = await electron.launch({
      executablePath,
      args: [`--user-data-dir=${profile}`, '--server-port', String(port)],
      env,
      timeout: 45000
    })
    const capture = page => {
      page.on('pageerror', error => errors.push(error.message))
      page.on('requestfailed', request => errors.push(`${request.url()}: ${request.failure()?.errorText}`))
      page.on('console', message => {
        if (message.type() === 'error') errors.push(message.text())
      })
    }
    app.on('window', capture)
    const page = await app.firstWindow()
    capture(page)
    await page.waitForFunction(() => window.store?.configLoaded)
    assert.equal(new URL(page.url()).origin, origin)
    return page
  }
  await closeServer()
  let page = await launchApp()
  await page.evaluate(async () => {
    await window.pre.runGlobalAsync('dbAction', 'bookmarks', 'insert', {
      _id: 'warm-cache-bookmark',
      title: 'Existing user bookmark',
      password: 'existing-user-secret',
      type: 'local'
    })
  })
  await closeApp()

  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve))
  const seedFile = join(root, 'seed.js')
  writeFileSync(seedFile, `
    const { app, BrowserWindow } = require('electron')
    app.whenReady().then(async () => {
      const win = new BrowserWindow()
      await win.webContents.session.clearCache()
      await win.loadURL(${JSON.stringify(origin)})
    })
  `)
  app = await electron.launch({
    executablePath: require('electron'),
    args: [seedFile, `--user-data-dir=${profile}`],
    env,
    timeout: 45000
  })
  page = await app.firstWindow()
  await page.waitForFunction(() => document.title === 'Old-build HTTP cache fixture')
  const contents = await page.evaluate(async path => [
    await (await fetch(path)).text(),
    await (await fetch(path)).text()
  ], entryPath)
  assert.ok(contents.every(text => text.includes('OLD_BUILD')))
  assert.equal(requests, 1, 'the old entry must actually be served from Chromium HTTP cache')
  await app.evaluate(async ({ session }, url) => {
    await session.defaultSession.cookies.set({
      url,
      name: 'preserve-session',
      value: 'yes',
      expirationDate: Math.floor(Date.now() / 1000) + 3600
    })
    await session.defaultSession.cookies.flushStore()
    session.defaultSession.flushStorageData()
  }, origin)
  await closeApp()
  await closeServer()

  page = await launchApp()
  const saved = await page.evaluate(() => window.pre.runGlobalAsync(
    'dbAction', 'bookmarks', 'findOne', { _id: 'warm-cache-bookmark' }
  ))
  assert.equal(saved.title, 'Existing user bookmark')
  assert.equal(saved.password, 'existing-user-secret')
  const cookies = await app.evaluate(({ session }, url) => session.defaultSession.cookies.get({ url }), origin)
  assert.equal(cookies.find(cookie => cookie.name === 'preserve-session')?.value, 'yes')
  await checkRendererNavigation(page, t)
  assert.deepEqual(errors, [], 'cached entry must not request modules removed by the new build')
})
