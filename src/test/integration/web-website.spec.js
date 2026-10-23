const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const { pathToFileURL } = require('node:url')
const { chromium } = require('playwright')

test('real Web website component embeds allowed pages and explains frame-policy refusal without bypass', {
  skip: process.env.ANUBIS_WEB_WEBSITE_E2E !== '1',
  timeout: 120000
}, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'anubis-web-website-'))
  const servers = []
  let browser = null
  t.after(async () => {
    try {
      await browser?.close()
    } finally {
      for (const server of servers) {
        server.closeAllConnections()
        await new Promise(resolve => server.close(resolve))
      }
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  })
  const modules = path.dirname(path.dirname(require.resolve('react/package.json')))
  fs.symlinkSync(modules, path.join(root, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
  const entry = path.join(root, 'entry.jsx')
  const component = path.resolve(__dirname, '../../client/components/web/web-session.jsx')
  fs.writeFileSync(entry, `
import React from 'react'
import {createRoot} from 'react-dom/client'
import WebSession from ${JSON.stringify(component)}
const root=createRoot(document.getElementById('app'))
let generation=0
window.setWebsite=url=>root.render(<WebSession key={++generation} tab={{url,title:'Website fixture'}} reloadTab={tab=>window.setWebsite(tab.url)}/>)
window.setWebsite(window.initialWebsite)
`)
  const { build } = await import(pathToFileURL(require.resolve('vite')).href)
  const react = (await import(pathToFileURL(require.resolve('@vitejs/plugin-react')).href)).default
  const pack = require('../../../package.json')
  const result = await build({
    root,
    configFile: false,
    plugins: [react()],
    resolve: { dedupe: [...Object.keys(pack.dependencies || {}), ...Object.keys(pack.devDependencies || {})] },
    logLevel: 'silent',
    build: {
      write: false,
      minify: false,
      rollupOptions: { input: entry, output: { entryFileNames: 'entry.js', assetFileNames: '[name][extname]' } }
    }
  })
  const output = new Map(result.output.map(file => [file.fileName, file.code || file.source]))
  const requests = []
  async function listen (handler) {
    const server = http.createServer(handler)
    servers.push(server)
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    return `http://127.0.0.1:${server.address().port}`
  }
  const website = await listen((req, res) => {
    requests.push(req.url)
    res.writeHead(200, {
      'content-type': 'text/html',
      ...(req.url === '/blocked' ? { 'x-frame-options': 'DENY' } : {})
    })
    res.end('<!doctype html><title>Website fixture</title><h1 id="site">Actual embedded website</h1>')
  })
  const workspace = await listen((req, res) => {
    const asset = output.get(req.url.slice(1))
    if (asset !== undefined) {
      res.writeHead(200, { 'content-type': req.url.endsWith('.css') ? 'text/css' : 'text/javascript' })
      return res.end(asset)
    }
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(`<!doctype html><html><head><script>
window.et={isWebApp:true};window.api={};window.translate=x=>x;window.openLink=url=>window.openedWebsite=url;
window.initialWebsite=${JSON.stringify(website + '/allowed')};
</script></head><body><div id="app"></div><script type="module" src="/entry.js"></script></body></html>`)
  })
  browser = await chromium.launch({ headless: true })
  const context = await browser.newContext()
  await context.route('**/*', route => {
    const url = new URL(route.request().url())
    return url.hostname === '127.0.0.1' ? route.continue() : route.abort()
  })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(workspace)
  await page.frameLocator('iframe').locator('#site').waitFor()
  assert.equal(await page.locator('webview').count(), 0)
  assert.equal(await page.locator('[role="note"]').count(), 1)
  const refusal = page.waitForEvent('console', {
    predicate: message => /frame|embedding/i.test(message.text()) && /refused|deny/i.test(message.text()),
    timeout: 10000
  })
  await page.evaluate(url => window.setWebsite(url), website + '/blocked')
  await refusal
  assert.ok(requests.includes('/blocked'))
  assert.equal(await page.frameLocator('iframe').locator('#site').count(), 0)
  await page.locator('[role="note"] button').click()
  assert.equal(await page.evaluate(() => window.openedWebsite), website + '/blocked')
  await page.evaluate(() => window.setWebsite('file:///not-a-website'))
  await page.getByText('not valid (HTTP or HTTPS required)', { exact: false }).waitFor()
  assert.equal(await page.locator('iframe').count(), 0)
  assert.deepEqual(errors, [])
})
