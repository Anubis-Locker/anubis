const { test } = require('node:test')
const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const { mkdtempSync, mkdirSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const { createServer } = require('node:net')
const { DatabaseSync } = require('node:sqlite')
const { _electron: electron } = require('playwright')
const { startSshForward } = require('../integration/lib/ssh-forward')
const { snapshotWindowsProtocols } = require('../integration/lib/windows-protocol-fixture')

async function unusedPort () {
  const server = createServer()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  await new Promise(resolve => server.close(resolve))
  return port
}

function github (args, input) {
  const result = spawnSync('gh', args, {
    input,
    encoding: 'utf8',
    timeout: 30000,
    windowsHide: true
  })
  if (result.error) throw result.error
  assert.equal(result.status, 0, 'The authenticated GitHub fixture operation failed')
  return result.stdout
}

test('packaged live Spice and private GitHub sync', {
  skip: !process.env.ANUBIS_SMOKE_EXTENDED,
  timeout: 180000
}, async t => {
  const executablePath = resolve(process.env.ANUBIS_SMOKE_EXE)
  const root = mkdtempSync(join(tmpdir(), 'anubis-extended-smoke-'))
  const data = join(root, 'data')
  const databaseDirectory = join(data, 'users', 'default_user')
  mkdirSync(databaseDirectory, { recursive: true })
  const database = new DatabaseSync(join(databaseDirectory, 'electerm_data.db'))
  database.exec('CREATE TABLE data (_id TEXT PRIMARY KEY, data TEXT)')
  database.prepare('INSERT INTO data VALUES (?, ?)').run(
    'userConfigNoEncrypt', JSON.stringify({ allowMultiInstance: true })
  )
  database.close()
  let app
  let forward
  let gistId
  let token = ''
  let protocols
  const errors = []
  const redact = text => token ? text.split(token).join('[REDACTED]') : text
  t.after(async () => {
    try {
      if (app) {
        await app.close()
        app = undefined
      }
    } finally {
      try {
        if (forward) await forward.close()
        if (gistId) github(['api', '--method', 'DELETE', `gists/${gistId}`])
      } finally {
        if (protocols) {
          protocols.restore()
          protocols = undefined
        }
        rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
      }
    }
  })
  protocols = snapshotWindowsProtocols(root, [root, executablePath])
  app = await electron.launch({
    executablePath,
    args: [`--user-data-dir=${join(root, 'profile')}`, `--server-port=${await unusedPort()}`],
    env: {
      ...process.env,
      NODE_ENV: 'production',
      NODE_TEST: '',
      DATA_PATH: data,
      ANUBIS_ADMIN_AUTOSTART: '0',
      ANUBIS_ADMIN_MANAGED_ENABLED: '0',
      ANUBIS_ADMIN_ERROR_REPORT: '0',
      ANUBIS_ADMIN_MCP_ENABLED: '0'
    },
    timeout: 45000
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(30000)
  page.on('pageerror', error => errors.push(redact(error.message)))
  page.on('console', message => {
    if (message.type() === 'error') errors.push(redact(message.text()))
  })
  await page.waitForFunction(() => window.store?.configLoaded)
  assert.equal(await page.evaluate(() => window.et.version), process.env.ANUBIS_SMOKE_VERSION)
  const sidebar = page.locator('.control-icon-wrap.active[title="Bookmarks"]')
  if (await sidebar.isVisible()) await sidebar.click()
  await t.test('Spice renders the real guest framebuffer and delivers keyboard and pointer events', async () => {
    forward = await startSshForward({
      host: process.env.VPS_HOST,
      port: Number(process.env.VPS_PORT || 22),
      username: 'root',
      password: process.env.VPS_PASS,
      remotePort: 5999
    })
    await page.evaluate(port => window.store.addTab({
      type: 'spice',
      host: '127.0.0.1',
      port,
      title: 'Spice fixture'
    }), forward.port)
    const canvas = page.locator('.session-current .spice-session-mount canvas')
    await canvas.waitFor()
    await page.waitForFunction(() => {
      const canvas = document.querySelector('.session-current .spice-session-mount canvas')
      if (!canvas?.width || !canvas.height) return false
      const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data
      let visible = 0
      for (let i = 0; i < pixels.length; i += 4) {
        if (pixels[i] + pixels[i + 1] + pixels[i + 2] > 100) visible++
      }
      return visible > 100
    })
    await canvas.click({ position: { x: 50, y: 50 } })
    await page.keyboard.press('a')
    await page.waitForFunction(() => window.store.tabs.find(tab => tab.title === 'Spice fixture')?.status === 'success')
    let input = ''
    let trace = ''
    for (let attempt = 0; attempt < 50; attempt++) {
      input = await forward.exec('cat /opt/anubis-qa-spice/guest-input.log')
      trace = await forward.exec('cat /opt/anubis-qa-spice/input-trace.log')
      if (input.includes('READY\r\na') && /input_event_btn.*down 1/.test(trace)) break
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    assert.ok(input.includes('READY\r\na'), 'The guest did not receive the typed key through Spice')
    assert.match(trace, /input_event_btn.*down 1/)
    assert.deepEqual(forward.errors, [])
  })
  await t.test('live private GitHub gist sync encrypts, uploads, downloads and restores bookmarks without exporting its token', async () => {
    token = github(['auth', 'token']).trim()
    assert.ok(token, 'GitHub authentication is unavailable')
    const gist = JSON.parse(github(['api', '--method', 'POST', 'gists', '--input', '-'], JSON.stringify({
      public: false,
      description: 'Temporary Anubis encrypted sync acceptance fixture',
      files: { 'anubis-qa.json': { content: '{"temporary":true}' } }
    })))
    gistId = gist.id
    assert.equal(gist.public, false)
    await page.evaluate(({ token, gistId }) => {
      window.store.updateSyncSetting({
        githubAccessToken: token,
        githubGistId: gistId,
        githubSyncPassword: 'temporary-github-sync-encryption-password',
        autoSync: false
      })
      window.store.setBookmarks([{
        id: 'github-acceptance-bookmark',
        title: 'Private GitHub sync fixture',
        type: 'ssh',
        host: '127.0.0.1',
        password: 'fixture-password-never-plaintext'
      }])
    }, { token, gistId })
    await page.evaluate(() => window.store.uploadSettingAction('github'))
    const uploaded = await page.evaluate(() => window.store.previewServerData('github'))
    assert.equal(uploaded.public, false)
    const ciphertext = uploaded.files['bookmarks.json'].content
    assert.ok(ciphertext.startsWith('gcm:'))
    assert.ok(!ciphertext.includes('fixture-password-never-plaintext'))
    assert.ok(!ciphertext.includes('Private GitHub sync fixture'))
    assert.ok(!JSON.stringify(uploaded.files).includes(token), 'The sync token was exported into the gist')
    await page.evaluate(() => window.store.setBookmarks([]))
    await page.waitForFunction(() => window.store.bookmarks.length === 0)
    await page.evaluate(() => window.store.downloadSettingAction('github'))
    await page.waitForFunction(() => window.store.bookmarks.some(bookmark =>
      bookmark.title === 'Private GitHub sync fixture' &&
      bookmark.password === 'fixture-password-never-plaintext'
    ))
    await page.evaluate(() => window.store.updateSyncSetting({
      githubAccessToken: '',
      githubGistId: '',
      githubSyncPassword: '',
      autoSync: false
    }))
  })
  assert.deepEqual(errors, [])
})
