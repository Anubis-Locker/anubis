const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const { once } = require('node:events')
const { pathToFileURL } = require('node:url')
const { _electron: electron } = require('playwright')

async function waitUntil (predicate, message, timeout = 15000) {
  const end = Date.now() + timeout
  while (!await predicate()) {
    if (Date.now() >= end) throw new Error(message)
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}

test('machine GUI embeds isolated native websites rather than restricted remote iframes', {
  skip: process.env.ANUBIS_WEBSITE_E2E !== '1',
  timeout: 180000
}, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'anubis-website-'))
  const dist = path.join(root, 'dist')
  const entry = path.join(root, 'entry.jsx')
  const profile = path.join(root, 'profile')
  fs.mkdirSync(profile)
  fs.symlinkSync(path.resolve('node_modules'), path.join(root, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
  const component = path.resolve(__dirname, '../../client/components/web/web-session.jsx')
  fs.writeFileSync(entry, `
import React from 'react'
import { createRoot } from 'react-dom/client'
import WebSession from ${JSON.stringify(component)}
const root = createRoot(document.getElementById('app'))
let generation = 0
window.setWebsite = url => root.render(<WebSession key={++generation} tab={{url, title:'Website fixture'}} reloadTab={tab=>window.setWebsite(tab.url)}/>)
window.closeWebsite = () => root.render(null)
window.setWebsite(window.initialWebsite)
`)
  let desktop = null
  const servers = []
  const errors = []
  const requests = []
  t.after(async () => {
    try {
      if (desktop) await desktop.close()
    } finally {
      for (const server of servers) {
        server.closeAllConnections()
        await new Promise(resolve => server.close(resolve))
      }
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
    }
  })
  const { build } = await import('vite')
  const react = (await import('@vitejs/plugin-react')).default
  await build({
    root,
    configFile: false,
    plugins: [react()],
    logLevel: 'silent',
    build: {
      outDir: dist,
      minify: false,
      rollupOptions: {
        input: entry,
        output: { entryFileNames: 'entry.js', assetFileNames: '[name][extname]' }
      }
    }
  })
  const site = '<!doctype html><html><head><title>Native website fixture</title></head><body><h1 id="site">Native website fixture</h1>' +
    '<button id="popup" onclick="window.open(\'/popup\',\'_blank\')">Open popup</button></body></html>'
  async function listen (handler) {
    const server = http.createServer(handler)
    servers.push(server)
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    return `http://127.0.0.1:${server.address().port}`
  }
  const external = await listen((req, res) => {
    requests.push({ url: req.url, headers: req.headers })
    if (req.url === '/auth' && req.headers.authorization !== 'Basic ' + Buffer.from('website-user:website-password').toString('base64')) {
      res.writeHead(401, { 'www-authenticate': 'Basic realm="Website fixture"' })
      return res.end('Authentication required')
    }
    res.writeHead(200, { 'content-type': 'text/html', 'x-frame-options': 'SAMEORIGIN' })
    res.end(req.url === '/with-frame'
      ? site.replace('</body>', `<iframe src="${workspace}/site"></iframe></body>`)
      : site)
  })
  const styles = fs.readdirSync(dist).filter(file => file.endsWith('.css'))
  const workspace = await listen((req, res) => {
    if (req.url === '/site') {
      requests.push({ url: 'workspace-site', headers: req.headers })
      res.writeHead(200, { 'content-type': 'text/html', 'x-frame-options': 'SAMEORIGIN' })
      return res.end(site)
    }
    if (req.url === '/entry.js' || styles.some(file => req.url === '/' + file)) {
      const file = req.url.slice(1)
      res.writeHead(200, { 'content-type': file.endsWith('.css') ? 'text/css' : 'text/javascript' })
      return res.end(fs.readFileSync(path.join(dist, file)))
    }
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(`<!doctype html><html><head>${styles.map(file => `<link rel="stylesheet" href="/${file}">`).join('')}
<style>html,body,#app{height:100%;margin:0}.web-session-wrap{height:100%;display:flex;flex-direction:column}.web-session-content{flex:1;min-height:0}webview{display:flex}</style>
<script>window.translate=x=>x;window.et={isWebApp:true};window.api={};window.openLink=url=>window.opened=url;window.initialWebsite=${JSON.stringify(external + '/xfo')};</script></head>
<body><div id="app"></div><script type="module" src="/entry.js"></script></body></html>`)
  })
  const helper = path.resolve(__dirname, '../../app/lib/embedded-website.js')
  const preload = path.resolve(__dirname, '../../app/preload/embedded-website.js')
  const main = path.join(root, 'main.cjs')
  fs.writeFileSync(main, `
const {app,BrowserWindow,WebContentsView,ipcMain,session}=require('electron')
app.setPath('userData',${JSON.stringify(profile)})
app.whenReady().then(async()=>{
 const win=new BrowserWindow({width:1100,height:800,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}})
 const host=new WebContentsView({webPreferences:{partition:'website-workspace-fixture',preload:${JSON.stringify(preload)},sandbox:true,contextIsolation:true,nodeIntegration:false,webviewTag:true}})
 global.fixture={win,host,guests:[],responses:[]}
 win.contentView.addChildView(host);host.setBounds({x:0,y:0,width:1100,height:760})
 const dispose=require(${JSON.stringify(helper)}).setupEmbeddedWebsites({contents:host.webContents,app,ipcMain,session})
 host.webContents.on('did-attach-webview',(_event,guest)=>{
  global.fixture.guests.push(guest)
  guest.on('did-navigate',(_event,url,status)=>global.fixture.responses.push({id:guest.id,url,status}))
 })
 win.on('closed',()=>{dispose();if(!host.webContents.isDestroyed())host.webContents.close({waitForBeforeUnload:false})})
 host.webContents.session.webRequest.onBeforeSendHeaders((details,done)=>done({requestHeaders:{...details.requestHeaders,'x-anubis-managed-transport':'fixture-private-proof'}}))
 await host.webContents.session.cookies.set({url:${JSON.stringify(workspace)},name:'workspace_cookie',value:'fixture-private-cookie'})
 await win.loadURL('data:text/html,<title>Website test wrapper</title>')
 await host.webContents.loadURL(${JSON.stringify(workspace)})
 await host.webContents.executeJavaScript("localStorage.setItem('tokenElecterm','fixture-private-jwt')")
})
app.on('window-all-closed',()=>app.quit())
`)
  const env = { ...process.env }
  for (const key of Object.keys(env)) {
    if (['ANUBIS_MANAGED_ADMIN_TOKEN', 'ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS'].includes(key.toUpperCase())) delete env[key]
  }
  desktop = await electron.launch({ executablePath: path.resolve('node_modules/electron/dist/electron.exe'), args: [main], env })
  await desktop.firstWindow({ timeout: 15000 })
  let page
  await waitUntil(() => {
    page = desktop.context().pages().find(page => page.url().startsWith(workspace))
    return !!page
  }, 'Workspace renderer did not load')
  page.on('pageerror', error => errors.push(error.message))
  const guestValue = script => desktop.evaluate(async (_electron, script) => {
    const guest = global.fixture.guests.findLast(guest => !guest.isDestroyed())
    if (!guest) throw new Error('No active website guest')
    return guest.executeJavaScript(script, true)
  }, script)
  const loaded = url => waitUntil(() => desktop.evaluate((_electron, url) => {
    const guest = global.fixture.guests.findLast(guest => !guest.isDestroyed())
    return !!guest && !guest.isLoading() && guest.getURL() === url
  }, url), 'Website did not finish navigation to ' + new URL(url).pathname)
  await loaded(external + '/xfo')
  await t.test('real shared renderer uses native top-level guest despite SAMEORIGIN and keeps managed Web semantics', async () => {
    assert.equal(await page.evaluate(() => window.et.isWebApp), true)
    assert.equal(await page.evaluate(() => window.anubisWebsite.version), 1)
    assert.equal(await page.locator('webview').count(), 1)
    assert.equal(await page.evaluate(() => document.querySelectorAll('iframe').length), 0)
    assert.equal(await guestValue("document.querySelector('#site').textContent"), 'Native website fixture')
    assert.equal(await guestValue('window.top === window'), true)
    const state = await desktop.evaluate(() => {
      const guest = global.fixture.guests.findLast(guest => !guest.isDestroyed())
      const preferences = guest.getLastWebPreferences()
      return {
        isolated: guest.session !== global.fixture.host.webContents.session,
        sandbox: preferences.sandbox,
        contextIsolation: preferences.contextIsolation,
        nodeIntegration: preferences.nodeIntegration,
        webSecurity: preferences.webSecurity,
        hasPreload: !!preferences.preload
      }
    })
    assert.deepEqual(state, { isolated: true, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, hasPreload: false })
  })
  await t.test('website never receives workspace transport header, cookies, local JWT or role bridges, even at the same origin', async () => {
    assert.equal(await page.evaluate(() => window.localStorage.getItem('tokenElecterm')), 'fixture-private-jwt')
    assert.equal(await page.evaluate(() => document.cookie.includes('workspace_cookie=fixture-private-cookie')), true)
    const request = requests.find(request => request.url === '/xfo')
    assert.equal(request.headers['x-anubis-managed-transport'], undefined)
    assert.equal(request.headers.cookie, undefined)
    assert.equal(request.headers.token, undefined)
    assert.equal(request.headers.authorization, undefined)
    assert.deepEqual(await guestValue('[typeof require,typeof process,typeof window.anubisHost,typeof window.anubisWebsite,typeof window.api]'),
      Array(5).fill('undefined'))
    await guestValue("fetch('/headers',{headers:{'X-Anubis-Managed-Transport':'spoofed'}}).then(r=>r.text())")
    assert.equal(requests.find(request => request.url === '/headers').headers['x-anubis-managed-transport'], undefined)
    await page.evaluate(url => window.setWebsite(url), workspace + '/site')
    await loaded(workspace + '/site')
    assert.equal(await guestValue("localStorage.getItem('tokenElecterm')"), null)
    assert.equal(await guestValue("document.cookie.includes('workspace_cookie')"), false)
    assert.equal(requests.find(request => request.url === 'workspace-site').headers['x-anubis-managed-transport'], undefined)
  })
  await t.test('native HTTP authentication uses the actual shared modal and session-scoped Electron challenge', async () => {
    await page.evaluate(url => window.setWebsite(url), external + '/auth')
    await page.getByText('Authentication Required', { exact: true }).waitFor()
    await page.getByPlaceholder('Username', { exact: true }).fill('website-user')
    await page.getByPlaceholder('Password', { exact: true }).fill('website-password')
    await page.getByRole('button', { name: 'Login', exact: true }).click()
    await loaded(external + '/auth')
    assert.equal(await guestValue("document.querySelector('#site').textContent"), 'Native website fixture')
    await page.getByText('Authentication Required', { exact: true }).waitFor({ state: 'hidden' })
    const guestId = await desktop.evaluate(() => global.fixture.guests.findLast(guest => !guest.isDestroyed()).id)
    await guestValue("localStorage.setItem('website-reload','preserved')")
    await page.getByRole('img', { name: 'reload', exact: true }).click()
    await loaded(external + '/auth')
    assert.equal(await desktop.evaluate(() => global.fixture.guests.findLast(guest => !guest.isDestroyed()).id), guestId)
    assert.equal(await guestValue("localStorage.getItem('website-reload')"), 'preserved')
  })
  await t.test('zoom, same-guest new-window navigation, and invalid-protocol refusal preserve in-app browsing', async () => {
    await page.evaluate(url => window.setWebsite(url), external + '/xfo')
    await loaded(external + '/xfo')
    await page.getByRole('img', { name: 'ellipsis', exact: true }).click()
    await page.getByRole('img', { name: 'plus-circle', exact: true }).click()
    assert.equal(await desktop.evaluate(() => global.fixture.guests.findLast(guest => !guest.isDestroyed()).getZoomFactor()), 1.25)
    await guestValue("document.querySelector('#popup').click()")
    await loaded(external + '/popup')
    assert.equal(await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1)
    await guestValue("try { location.href='file:///C:/Windows/win.ini' } catch (error) { error.name }")
    assert.equal(await desktop.evaluate(() => global.fixture.guests.findLast(guest => !guest.isDestroyed()).getURL()), external + '/popup')
  })
  await t.test('blocked child frames do not hide a working website and main navigation errors are shown explicitly', async () => {
    await page.evaluate(url => window.setWebsite(url), external + '/with-frame')
    await loaded(external + '/with-frame')
    assert.equal(await page.getByRole('alert').count(), 0)
    assert.equal(await page.locator('webview').isVisible(), true)
    await page.evaluate(() => window.setWebsite('http://127.0.0.1:1/failure'))
    await page.getByRole('alert').waitFor()
    assert.ok((await page.getByRole('alert').innerText()).includes('Website could not be loaded'))
    await page.evaluate(url => window.setWebsite(url), external + '/xfo')
    await loaded(external + '/xfo')
    assert.equal(await page.getByRole('alert').count(), 0)
  })
  await t.test('malicious preload, partition and webpreferences attributes cannot escape native guest policy', async () => {
    await page.evaluate(() => window.closeWebsite())
    await waitUntil(() => desktop.evaluate(() => global.fixture.guests.every(guest => guest.isDestroyed())), 'Unmount did not close guests')
    const partition = await page.evaluate(() => window.anubisWebsite.allocate())
    await page.evaluate(({ partition, url, preload }) => {
      const guest = document.createElement('webview')
      guest.src = url
      guest.setAttribute('partition', partition)
      guest.setAttribute('preload', preload)
      guest.setAttribute('allowpopups', '')
      guest.setAttribute('webpreferences', 'nodeIntegration=yes,nodeIntegrationInSubFrames=yes,contextIsolation=no,sandbox=no,webSecurity=no')
      document.body.appendChild(guest)
    }, { partition, url: external + '/attack', preload: pathToFileURL(path.resolve(__dirname, '../../app/preload/machine-client.js')).href })
    await loaded(external + '/attack')
    assert.deepEqual(await guestValue('[typeof require,typeof process,typeof window.anubisHost,typeof window.anubisWebsite]'),
      Array(4).fill('undefined'))
    assert.equal(await desktop.evaluate(() => global.fixture.guests.findLast(guest => !guest.isDestroyed()).getLastWebPreferences().webSecurity), true)
    await page.evaluate(async partition => {
      document.querySelector('webview').remove()
      await window.anubisWebsite.release(partition)
    }, partition)
    for (const partition of ['website-workspace-fixture', 'persist:privileged-workspace']) {
      await page.evaluate(partition => {
        const guest = document.createElement('webview')
        guest.setAttribute('partition', partition)
        guest.src = window.location.origin + '/site'
        document.body.appendChild(guest)
      }, partition)
      await new Promise(resolve => setTimeout(resolve, 200))
      assert.equal(await desktop.evaluate(() => global.fixture.guests.filter(guest => !guest.isDestroyed()).length), 0)
      await page.evaluate(() => document.querySelector('webview').remove())
    }
  })
  await t.test('remote renderer clearly explains iframe restrictions and retains explicit external-open action', async () => {
    await desktop.evaluate(async ({ BrowserWindow }, url) => {
      const remote = new BrowserWindow({ width: 1000, height: 700, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } })
      global.fixture.remote = remote
      await remote.loadURL(url)
    }, workspace)
    const remote = desktop.context().pages().find(other => other !== page && other.url().startsWith(workspace))
    await remote.getByRole('note').waitFor()
    assert.equal(await remote.locator('iframe').count(), 1)
    assert.equal(await remote.locator('webview').count(), 0)
    await remote.locator('[title="openInDefaultBrowser"]').click()
    assert.equal(await remote.evaluate(() => window.opened), external + '/xfo')
    await desktop.evaluate(() => global.fixture.remote.close())
  })
  if (process.env.ANUBIS_WEBSITE_GOOGLE === '1') {
    await t.test('Google loads as an actual native guest without disabling web security', async () => {
      await page.evaluate(() => window.setWebsite('https://www.google.com/'))
      await waitUntil(() => desktop.evaluate(() => {
        const guest = global.fixture.guests.findLast(guest => !guest.isDestroyed())
        return !!guest && !guest.isLoading() && /^https:\/\/(?:www\.|consent\.)?google\.com\//.test(guest.getURL())
      }), 'Google guest did not load through normal TLS', 30000)
      assert.ok((await guestValue('document.title')).length > 0)
      assert.equal(await guestValue('window.top === window'), true)
      assert.match(await guestValue('document.documentURI'), /^https:\/\/(?:www\.|consent\.)?google\.com\//)
      assert.equal(await page.getByRole('alert').count(), 0)
      const response = await desktop.evaluate(() => {
        const guest = global.fixture.guests.findLast(guest => !guest.isDestroyed())
        return global.fixture.responses.findLast(response => response.id === guest.id)
      })
      assert.equal(response.status, 200)
      t.diagnostic('Google native guest: HTTP ' + response.status + ', normal TLS, webSecurity enabled')
    })
  }
  assert.deepEqual(errors, [])
})
