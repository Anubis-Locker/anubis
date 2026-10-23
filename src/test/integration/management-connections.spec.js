const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { chromium } = require('playwright')
const { expect } = require('@playwright/test')
const { createServer } = require('../../../services/management-api')

function agent (suffix, values = {}) {
  const id = '00000000-0000-4000-8000-' + suffix.padStart(12, '0')
  return {
    id,
    label: 'Fixture ' + suffix,
    fingerprint: suffix.repeat(64).slice(0, 64),
    app: 'anubis-desktop',
    version: '5.7.3',
    platform: 'win32',
    arch: 'x64',
    status: 'approved',
    online: true,
    url: 'https://device-' + id.replace(/-/g, '') + '.anubis.locker',
    createdAt: 1792700000000,
    lastSeen: 1792790000000,
    ...values
  }
}

async function fixture (t, agents) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'anubis-admin-connections-'))
  const adminToken = 'loopback-only-admin-fixture'
  const server = createServer({ dataDir, adminToken })
  let browser = null
  t.after(async () => {
    if (browser) await browser.close()
    await new Promise(resolve => server.close(resolve))
    fs.rmSync(dataDir, { recursive: true, force: true })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  browser = await chromium.launch()
  const context = await browser.newContext()
  const unexpected = []
  await context.route('**/*', route => {
    if (new URL(route.request().url()).origin === base) return route.continue()
    unexpected.push(new URL(route.request().url()).pathname)
    return route.abort()
  })
  const page = await context.newPage()
  await page.clock.install()
  await page.addInitScript(() => {
    window.copiedFixture = []
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: async value => { window.copiedFixture.push(value) } }
    })
    const fetch = window.fetch
    window.fetch = (input, options) => {
      if (String(input).endsWith('/_anubis/connect')) {
        window.exchangeFixture = { credentials: options.credentials, method: options.method }
      }
      return fetch(input, options)
    }
  })
  const state = { agents, managedStatus: 200, reportsStatus: 200, posts: [] }
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.route('**/api/agents', route => route.fulfill({
    status: state.managedStatus, json: { agents: state.agents }
  }))
  await page.route('**/api/installs', route => route.fulfill({
    status: state.reportsStatus, json: { installs: [] }
  }))
  await page.route('**/api/agents/*/*', route => {
    state.posts.push({ path: new URL(route.request().url()).pathname, method: route.request().method() })
    assert.equal(route.request().headers().authorization, 'Bearer ' + adminToken)
    return route.fulfill({ status: 409, json: { error: 'Unexpected fixture action' } })
  })
  await page.goto(base + '/admin')
  await page.locator('#token').fill(adminToken)
  await page.locator('#sign-in').click()
  await expect(page.locator('#inventory')).toBeVisible()
  t.after(() => {
    assert.deepEqual(unexpected, [])
    assert.deepEqual(errors, [])
  })
  return { page, context, base, state, adminToken }
}

test('managed connection addresses are real, copyable, online-first and explicitly not transferable authorization', { timeout: 60000 }, async t => {
  const online = agent('1', { label: '<img src=x onerror="window.injected=true">' })
  const offline = agent('2', { label: 'A offline', online: false, url: undefined })
  const invalid = agent('3', { url: 'https://untrusted.invalid/?token=never-display' })
  const f = await fixture(t, [offline, invalid, online])
  const { page } = f
  const live = page.locator(`[data-agent-id="${online.id}"]`)
  await expect(live.locator('.managed-address')).toHaveText(online.url + '/')
  await expect(page.locator('#agent-rows tr').first()).not.toHaveAttribute('data-agent-id', offline.id)
  await expect(page.locator('#agent-summary')).toContainText('2 approved devices online / 3 registered')
  await expect(page.locator('#connection-auth-help')).toContainText('different browser or incognito')
  await expect(page.locator('#connection-auth-help')).toContainText('existing app-profile password from the profile owner')
  await expect(page.locator('#connection-auth-help')).toContainText('profile without an app password')
  await expect(page.locator('#connection-auth-help')).toContainText('cannot retrieve, set or reset')
  await live.getByRole('button', { name: 'Copy device URL' }).click()
  assert.deepEqual(await page.evaluate(() => window.copiedFixture), [online.url + '/'])
  await expect(page.locator('#message')).toContainText('without credentials')
  await expect(page.locator('#agent-rows')).not.toContainText('never-display')
  await expect(page.locator('#agent-rows img')).toHaveCount(0)
  assert.equal(await page.evaluate(() => window.injected), undefined)
  await expect(page.locator(`[data-agent-id="${invalid.id}"]`).getByRole('button', { name: 'Open device', exact: true })).toBeDisabled()
  await expect(page.locator(`[data-agent-id="${offline.id}"]`)).toContainText('No live managed address')
  assert.deepEqual(f.state.posts, [])
  assert.deepEqual(await page.evaluate(() => ({
    local: Object.keys(window.localStorage), session: Object.keys(window.sessionStorage)
  })), { local: [], session: [] })
})

test('report failures do not hide managed access; stale, offline, revoked or changed identities cannot mint cached grants', { timeout: 60000 }, async t => {
  const original = agent('1')
  const f = await fixture(t, [original])
  const { page, state } = f
  const row = () => page.locator(`[data-agent-id="${original.id}"]`)
  await expect(row().getByRole('button', { name: 'Open device', exact: true })).toBeEnabled()
  state.reportsStatus = 503
  state.agents = [{ ...original, online: false, url: undefined }]
  await page.locator('#refresh').click()
  await expect(page.locator('#reports-status')).toContainText('HTTP 503')
  await expect(row()).toContainText('Offline')
  await expect(row().getByRole('button', { name: 'Open device', exact: true })).toBeDisabled()
  await expect(row().locator('.managed-address')).toHaveCount(0)

  state.managedStatus = 503
  await page.locator('#refresh').click()
  await expect(page.locator('#agent-summary')).toContainText('Stale inventory')
  await expect(row()).toContainText('Unknown (stale)')
  await expect(row().getByRole('button', { name: 'MCP access', exact: true })).toBeDisabled()
  await page.evaluate(value => window.openMcp(value), original)
  await expect(page.locator('#mcp-access')).toBeHidden()
  assert.deepEqual(state.posts, [])

  state.managedStatus = 200
  state.agents = [{ ...original }]
  await page.locator('#refresh').click()
  await expect(row().getByRole('button', { name: 'Open device', exact: true })).toBeEnabled()
  await expect(page.locator('#reports-status')).toContainText('HTTP 503')
  state.managedStatus = 503
  await row().getByRole('button', { name: 'MCP access', exact: true }).click()
  await expect(row()).toContainText('Unknown (stale)')
  await expect(row().locator('.managed-address')).toHaveText(original.url + '/')
  await expect(row().getByRole('button', { name: 'Copy device URL' })).toBeDisabled()
  await expect(row().getByRole('button', { name: 'Open device', exact: true })).toBeDisabled()
  assert.deepEqual(state.posts, [])
  state.managedStatus = 200
  await page.locator('#refresh').click()
  state.agents = [{ ...original, status: 'revoked', online: false, url: undefined }]
  await row().getByRole('button', { name: 'MCP access', exact: true }).click()
  await expect(page.locator('#message')).toContainText('not approved and online')
  await expect(row().getByRole('button', { name: 'Approve', exact: true })).toBeDisabled()
  assert.deepEqual(state.posts, [])

  state.agents = [{ ...original }]
  await page.locator('#refresh').click()
  state.agents = [{ ...original, fingerprint: 'b'.repeat(64) }]
  const popup = page.waitForEvent('popup')
  await row().getByRole('button', { name: 'Open device', exact: true }).click()
  const rejected = await popup
  await expect(page.locator('#message')).toContainText('Device identity changed')
  await expect.poll(() => rejected.isClosed()).toBe(true)
  assert.deepEqual(state.posts, [])

  state.agents = [{ ...original, status: 'pending', online: false, url: undefined }]
  await page.locator('#refresh').click()
  await row().getByRole('checkbox').check()
  await expect(row().getByRole('button', { name: 'Approve', exact: true })).toBeEnabled()
  state.agents = [{ ...state.agents[0], fingerprint: 'c'.repeat(64) }]
  await page.locator('#refresh').click()
  await expect(row().getByRole('checkbox')).not.toBeChecked()
  await expect(row().getByRole('button', { name: 'Approve', exact: true })).toBeDisabled()
})

test('Open device revalidates identity, exchanges a body-only ticket and reports browser authorization, not product success', { timeout: 60000 }, async t => {
  const original = agent('1')
  const f = await fixture(t, [original])
  const { page, context, state, base } = f
  let exchangeStatus = 200
  const ticket = 'd'.repeat(64)
  const requestedUrls = []
  const requests = []
  context.on('request', request => requestedUrls.push(request.url()))
  await page.route('**/api/agents/*/connect', route => {
    state.posts.push({ path: new URL(route.request().url()).pathname, method: route.request().method() })
    assert.equal(route.request().headers().authorization, 'Bearer ' + f.adminToken)
    return route.fulfill({ json: { url: original.url, ticket, expiresAt: Date.now() + 30000 } })
  })
  await context.route(original.url + '/**', route => {
    const request = route.request()
    const pathname = new URL(request.url()).pathname
    requests.push({ path: pathname, method: request.method() })
    const headers = {
      'access-control-allow-origin': base,
      'access-control-allow-credentials': 'true',
      'access-control-allow-methods': 'POST',
      'access-control-allow-headers': 'content-type'
    }
    if (pathname === '/_anubis/connect') {
      if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers })
      assert.equal(request.method(), 'POST')
      assert.equal(request.headers().authorization, undefined)
      assert.deepEqual(request.postDataJSON(), { ticket })
      return route.fulfill({ status: exchangeStatus, headers, json: { ok: exchangeStatus === 200 } })
    }
    if (pathname === '/favicon.ico') return route.fulfill({ status: 204 })
    assert.equal(pathname, '/')
    return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Owned fixture</title>' })
  })
  const first = page.waitForEvent('popup')
  await page.getByRole('button', { name: 'Open device', exact: true }).click()
  const opened = await first
  await opened.waitForURL(original.url + '/')
  assert.equal(await opened.evaluate(() => window.opener), null)
  await expect(page.locator('#message')).toContainText('Browser authorized; device page requested')
  await expect(page.locator('#message')).toContainText('not a verified terminal')
  assert.deepEqual(await page.evaluate(() => window.exchangeFixture), { credentials: 'include', method: 'POST' })
  assert.ok(requests.some(request => request.path === '/_anubis/connect' && request.method === 'POST'))
  assert.ok(requestedUrls.every(url => !url.includes(ticket) && !url.includes(f.adminToken)))
  await opened.close()

  exchangeStatus = 401
  const second = page.waitForEvent('popup')
  await page.getByRole('button', { name: 'Open device', exact: true }).click()
  const rejected = await second
  await expect(page.locator('#message')).toContainText('Connection ticket rejected: HTTP 401')
  await expect.poll(() => rejected.isClosed()).toBe(true)
  await expect(page.getByRole('button', { name: 'Open device', exact: true })).toBeEnabled()
  assert.equal(state.posts.length, 2)
  assert.deepEqual(await page.evaluate(() => ({
    local: Object.keys(window.localStorage), session: Object.keys(window.sessionStorage)
  })), { local: [], session: [] })
})

test('an in-flight MCP grant is not displayed after its device inventory becomes stale', { timeout: 60000 }, async t => {
  const original = agent('1')
  const { page, state } = await fixture(t, [original])
  let release
  let requested = false
  const pending = new Promise(resolve => { release = resolve })
  t.after(() => release())
  await page.route('**/api/agents/*/mcp-token', async route => {
    requested = true
    await pending
    return route.fulfill({
      json: {
        url: original.url + '/mcp', scope: 'mcp', token: 'e'.repeat(64), expiresAt: Date.now() + 3600000
      }
    })
  })
  await page.getByRole('button', { name: 'MCP access', exact: true }).click()
  await expect.poll(() => requested).toBe(true)
  state.managedStatus = 503
  await page.locator('#refresh').click()
  await expect(page.locator('#agent-summary')).toContainText('Stale inventory')
  release()
  await expect(page.locator('#message')).toContainText('Device availability changed')
  await expect(page.locator('#mcp-access')).toBeHidden()
  await expect(page.locator('#mcp-credentials')).toHaveText('')
})

test('an in-flight browser ticket cannot reach the device after inventory availability changes', { timeout: 60000 }, async t => {
  for (const change of ['stale', 'offline', 'revoked', 'fingerprint']) {
    await t.test(change, async subtest => {
      const original = agent('1')
      const { page, context, state } = await fixture(subtest, [original])
      const deviceRequests = []
      context.on('request', request => {
        if (new URL(request.url()).origin === original.url) deviceRequests.push(request.method())
      })
      let release
      let requested = false
      const pending = new Promise(resolve => { release = resolve })
      subtest.after(() => release())
      await page.route('**/api/agents/*/connect', async route => {
        requested = true
        await pending
        return route.fulfill({
          json: { url: original.url, ticket: 'f'.repeat(64), expiresAt: Date.now() + 30000 }
        })
      })
      const popup = page.waitForEvent('popup')
      await page.getByRole('button', { name: 'Open device', exact: true }).click()
      const opened = await popup
      await expect.poll(() => requested).toBe(true)
      if (change === 'stale') state.managedStatus = 503
      else if (change === 'fingerprint') state.agents = [{ ...original, fingerprint: 'c'.repeat(64) }]
      else {
        state.agents = [{
          ...original,
          online: false,
          url: undefined,
          status: change === 'revoked' ? 'revoked' : 'approved'
        }]
      }
      await page.locator('#refresh').click()
      await expect(page.locator('#refresh')).toBeEnabled()
      release()
      await expect(page.locator('#message')).toContainText('Device availability changed while issuing browser access')
      await expect(page.locator('#message')).toContainText('unused ticket expires automatically')
      await expect(page.locator('#message')).not.toContainText('Browser authorized')
      await expect.poll(() => opened.isClosed()).toBe(true)
      assert.deepEqual(deviceRequests, [])
    })
  }
})
