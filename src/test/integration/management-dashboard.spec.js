const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { chromium } = require('playwright')
const { expect } = require('@playwright/test')
const { createServer } = require('../../../services/management-api')

test('management dashboard authenticates, isolates history and never treats reports as live access', { timeout: 60000 }, async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'anubis-inventory-browser-'))
  const adminToken = 'inventory-browser-test-token'
  const server = createServer({ dataDir, adminToken })
  let browser = null
  t.after(async () => {
    if (browser) await browser.close()
    await new Promise(resolve => server.close(resolve))
    fs.rmSync(dataDir, { recursive: true, force: true })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  const injected = '<img src=x onerror="window.injected=true">'
  const invalidWebUrls = [
    'http://desktop-qa.anubis.locker/',
    'https://untrusted.invalid/',
    'https://anubis.locker.untrusted.invalid/',
    'https://user:never-render-me@desktop-qa.anubis.locker/',
    'https://desktop-qa.anubis.locker:8443/',
    'https://desktop-qa.anubis.locker/?token=never-render-me',
    'https://desktop-qa.anubis.locker/#never-render-me'
  ]
  const fixtures = [
    { installId: 'qa-connected', type: 'error', message: injected, stack: 'selected stack' },
    {
      installId: 'qa-connected',
      type: 'heartbeat',
      app: 'anubis-desktop',
      version: '5.6.11',
      platform: 'win32',
      arch: 'x64',
      meta: { connection: { webUrl: 'https://desktop-qa.anubis.locker/' } }
    },
    { installId: 'qa-no-address', type: 'error', message: 'unrelated error' },
    {
      installId: 'qa-untrusted-address',
      meta: { connection: { webUrl: 'javascript:window.injected=true' } }
    },
    ...invalidWebUrls.map((webUrl, index) => ({
      installId: 'qa-invalid-url-' + index,
      meta: { connection: { webUrl, webPass: 'never-render-me' } }
    }))
  ]
  const installationCount = new Set(fixtures.map(fixture => fixture.installId)).size
  for (const fixture of fixtures) {
    const response = await fetch(base + '/api/report', {
      method: 'POST',
      body: JSON.stringify(fixture),
      signal: AbortSignal.timeout(5000)
    })
    assert.equal(response.status, 200)
  }

  browser = await chromium.launch({ headless: true })
  const page = await browser.newPage()
  const errors = []
  const requests = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('request', request => requests.push({ url: request.url(), method: request.method() }))
  await page.clock.install()
  await page.goto(base + '/admin')
  await expect(page.locator('#login')).toBeVisible()
  await expect(page.locator('#inventory')).toBeHidden()

  await page.locator('#token').fill('incorrect-token')
  await page.locator('#sign-in').click()
  await expect(page.locator('#message')).toContainText('token rejected')
  await expect(page.locator('#rows tr')).toHaveCount(0)
  await page.locator('#token').fill(adminToken)
  await page.locator('#sign-in').click()
  await expect(page.locator('#inventory')).toBeVisible()
  await expect(page.locator('#rows tr')).toHaveCount(installationCount)
  await expect(page.locator('#count')).toHaveText(String(installationCount))
  await expect(page.locator('#token')).toHaveValue('')
  await expect(page.locator('main')).toContainText('not a live presence signal')
  await expect(page.locator('#managed-access-help')).toContainText('From another PC')
  await expect(page.locator('#managed-access-help')).toContainText('not Windows screen sharing')
  await expect(page.locator('main')).toContainText('No Web address reported')
  await expect(page.locator('main')).toContainText('Web address outside the permitted HTTPS domain')
  await expect(page.locator('#rows a')).toHaveCount(1)
  await expect(page.locator('#rows')).not.toContainText('never-render-me')
  await expect(page.locator('#rows a')).toHaveAttribute('href', 'https://desktop-qa.anubis.locker/')
  assert.deepEqual(await page.evaluate(() => ({
    local: Object.keys(window.localStorage),
    session: Object.keys(window.sessionStorage)
  })), { local: [], session: [] })

  const selected = page.locator('#rows tr').filter({ hasText: 'qa-connected' })
  await selected.getByRole('button', { name: 'Reports' }).click()
  await expect(page.locator('#reports')).toContainText(injected)
  await expect(page.locator('#reports')).toContainText('selected stack')
  await expect(page.locator('#reports')).not.toContainText('unrelated error')
  await expect(page.locator('#reports img')).toHaveCount(0)
  assert.equal(await page.evaluate(() => window.injected), undefined)

  const before = requests.filter(request => request.url.endsWith('/api/installs')).length
  await page.clock.fastForward(10001)
  await expect.poll(() => requests.filter(request => request.url.endsWith('/api/installs')).length).toBeGreaterThan(before)
  await expect(page.locator('#refresh')).toBeEnabled()
  await page.route('**/api/installs', route => route.fulfill({ status: 503, body: '{}' }))
  await page.locator('#refresh').click()
  await expect(page.locator('#message')).toContainText('HTTP 503')
  await expect(page.locator('#rows tr')).toHaveCount(installationCount)
  await page.unroute('**/api/installs')
  await page.locator('#refresh').click()
  await expect(page.locator('#message')).toHaveText('')

  await page.locator('#sign-out').click()
  await expect(page.locator('#login')).toBeVisible()
  await expect(page.locator('#inventory')).toBeHidden()
  await expect(page.locator('#rows tr')).toHaveCount(0)
  await expect(page.locator('#reports')).toHaveText('')
  await page.locator('#token').fill(adminToken)
  await page.locator('#sign-in').click()
  await expect(page.locator('#inventory')).toBeVisible()
  await page.reload()
  await expect(page.locator('#login')).toBeVisible()
  await expect(page.locator('#rows tr')).toHaveCount(0)

  await page.locator('#token').fill(adminToken)
  await page.locator('#sign-in').click()
  await expect(page.locator('#inventory')).toBeVisible()
  await page.route('**/api/installs', route => route.fulfill({ status: 401, body: '{}' }))
  await page.locator('#refresh').click()
  await expect(page.locator('#message')).toContainText('token rejected')
  await expect(page.locator('#rows tr')).toHaveCount(0)
  await expect(page.locator('#login')).toBeVisible()
  assert.ok(requests.every(request => request.method === 'GET'))
  assert.ok(requests.every(request => !request.url.includes(adminToken)))
  assert.deepEqual(errors, [])
})

test('managed MCP credentials validate their origin and clear on close, revocation and sign-out', { timeout: 60000 }, async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'anubis-inventory-browser-'))
  const adminToken = 'inventory-mcp-test-token'
  const server = createServer({ dataDir, adminToken })
  let browser = null
  t.after(async () => {
    if (browser) await browser.close()
    await new Promise(resolve => server.close(resolve))
    fs.rmSync(dataDir, { recursive: true, force: true })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  const agent = {
    id: '00000000-0000-4000-8000-000000000001',
    label: 'Managed MCP fixture',
    app: 'anubis-desktop',
    version: '5.6.12',
    status: 'approved',
    online: true
  }
  const credential = 'a'.repeat(64)
  let url = 'https://untrusted.invalid/mcp'
  browser = await chromium.launch({ headless: true })
  const page = await browser.newPage()
  const errors = []
  const requests = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('request', request => requests.push(request.url()))
  await page.route('**/api/agents', route => route.fulfill({ json: { agents: [agent] } }))
  await page.route('**/api/agents/*/mcp-token', route => {
    assert.equal(route.request().method(), 'POST')
    assert.equal(route.request().headers().authorization, 'Bearer ' + adminToken)
    return route.fulfill({ json: { url, token: credential, scope: 'mcp', expiresAt: Date.now() + 3600000 } })
  })
  await page.goto(base + '/admin')
  await page.locator('#token').fill(adminToken)
  await page.locator('#sign-in').click()
  const mcp = page.getByRole('button', { name: 'MCP access', exact: true })
  await mcp.click()
  await expect(page.locator('#message')).toContainText('Invalid managed device origin')
  await expect(page.locator('#mcp-access')).toBeHidden()
  url = 'https://device-' + agent.id.replace(/-/g, '') + '.anubis.locker/mcp'
  await mcp.click()
  await expect(page.locator('#mcp-credentials')).toContainText('Authorization: Bearer ' + credential)
  await expect(page.locator('#mcp-credentials')).toContainText(url)
  await page.locator('#close-mcp').click()
  await expect(page.locator('#mcp-credentials')).toHaveText('')
  await mcp.click()
  await expect(page.locator('#mcp-access')).toBeVisible()
  agent.status = 'revoked'
  agent.online = false
  await page.locator('#refresh').click()
  await expect(page.locator('#mcp-access')).toBeHidden()
  await expect(page.locator('#mcp-credentials')).toHaveText('')
  agent.status = 'approved'
  agent.online = true
  await page.locator('#refresh').click()
  await mcp.click()
  await expect(page.locator('#mcp-access')).toBeVisible()
  await page.locator('#sign-out').click()
  await expect(page.locator('#mcp-access')).toBeHidden()
  await expect(page.locator('#mcp-credentials')).toHaveText('')
  assert.deepEqual(await page.evaluate(() => ({
    local: Object.keys(window.localStorage),
    session: Object.keys(window.sessionStorage)
  })), { local: [], session: [] })
  assert.ok(requests.every(url => url.startsWith(base) && !url.includes(adminToken) && !url.includes(credential)))
  assert.deepEqual(errors, [])
})
