const { test } = require('node:test')
const assert = require('node:assert/strict')
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, cpSync, readdirSync } = require('fs')
const { tmpdir, homedir } = require('os')
const { join, resolve, dirname, basename } = require('path')
const { createHash } = require('crypto')
const http = require('http')
const { spawn } = require('child_process')
const { _electron: electron } = require('playwright')
const {
  startTestSshServer, stopTestSshServer, HOST_KEY_PUBLIC, TEST_USERNAME, TEST_PASSWORD
} = require('../integration/lib/ssh-test-server')
const { startTestVncServer } = require('../integration/lib/vnc-test-server')
const { startSshForward } = require('../integration/lib/ssh-forward')
const { snapshotWindowsProtocols } = require('../integration/lib/windows-protocol-fixture')

test('packaged Windows desktop functionality', { timeout: 180000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'anubis-desktop-smoke-'))
  const home = join(root, 'home')
  const data = join(root, 'data')
  const userData = join(root, 'user-data')
  const remoteFiles = join(root, 'remote')
  for (const dir of [home, data, userData, remoteFiles]) {
    mkdirSync(dir, { recursive: true })
  }
  const markerFile = 'anubis-smoke-file.txt'
  writeFileSync(join(home, markerFile), 'local file manager fixture')
  writeFileSync(join(remoteFiles, markerFile), 'sftp fixture')
  const server = await startTestSshServer({ port: 0, rootDir: remoteFiles })
  const vnc = await startTestVncServer()
  const port = server.address().port
  const knownHosts = join(homedir(), '.ssh', 'known_hosts')
  const testHostEntry = `[127.0.0.1]:${port} ${HOST_KEY_PUBLIC}`
  const cleanupHostEntries = new Set([testHostEntry])
  const initialHostEntries = new Set(existsSync(knownHosts) ? readFileSync(knownHosts, 'utf8').split(/\r?\n/) : [])
  let app
  let rdpForward
  let localHttp
  const errors = []
  const executablePath = resolve(process.env.ANUBIS_SMOKE_EXE || join('dist', 'win-unpacked', 'anubis.exe'))
  let protocols = null
  async function launch ({ exe = executablePath, profile = userData, dataPath = data } = {}) {
    app = await electron.launch({
      executablePath: exe,
      args: [`--user-data-dir=${profile}`],
      env: {
        ...process.env,
        NODE_ENV: 'production',
        NODE_TEST: '',
        DATA_PATH: dataPath,
        ANUBIS_ADMIN_AUTOSTART: '0',
        ANUBIS_ADMIN_ERROR_REPORT: '0'
      },
      timeout: 45000
    })
    for (const stream of [app.process().stdout, app.process().stderr]) {
      stream.on('data', chunk => {
        const text = chunk.toString()
        process.stdout.write(text)
        if (/\berror [›>]|decrypt error|Error parsing JSON/.test(text)) errors.push(text)
      })
    }
    const captured = new WeakSet()
    const capturePage = page => {
      if (captured.has(page)) return
      captured.add(page)
      page.on('pageerror', error => errors.push(error.stack))
      page.on('console', message => {
        const text = message.text()
        if (message.type() === 'error' || text.includes('[RDP-FILE-TRANSFER][error]')) {
          errors.push(text)
          process.stdout.write(text + '\n')
        }
      })
    }
    app.on('window', capturePage)
    const page = await app.firstWindow()
    capturePage(page)
    await page.waitForFunction(() => window.store?.configLoaded)
    return page
  }
  t.after(async () => {
    try {
      if (app) await app.close()
    } finally {
      await stopTestSshServer(server)
      await vnc.close()
      if (rdpForward) await rdpForward.close()
      if (localHttp) await new Promise(resolve => localHttp.close(resolve))
      if (existsSync(knownHosts)) {
        const content = readFileSync(knownHosts, 'utf8')
        const clean = content.split(/(?<=\n)/).filter(line => !cleanupHostEntries.has(line.trim())).join('')
        if (clean !== content) writeFileSync(knownHosts, clean)
      }
      if (protocols) protocols.restore()
      rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
    }
  })
  protocols = snapshotWindowsProtocols(root, [root, executablePath])
  const page = await launch()
  await t.test('local terminal executes a command, not just opens a window', async () => {
    await page.waitForFunction(() => /PS [^\r\n]*>/.test(document.body.innerText))
    const sidebarButton = page.locator('.control-icon-wrap.active[title="Bookmarks"]')
    if (await sidebarButton.isVisible()) await sidebarButton.click()
    await page.locator('.session-current .xterm-helper-textarea').first().focus()
    await page.keyboard.insertText('Write-Output ("ANUBIS_" + "TERMINAL_OK")')
    await page.keyboard.press('Enter')
    await page.waitForFunction(() => document.body.innerText.includes('ANUBIS_TERMINAL_OK'))
  })
  await t.test('local file manager lists actual files', async () => {
    await page.locator('.session-current .term-sftp-tabs .type-tab').nth(1).click()
    const address = page.locator('.session-current .sftp-local-section .sftp-title input').first()
    await address.fill(home)
    await address.press('Enter')
    await page.locator('.session-current .sftp-local-section').getByText(markerFile, { exact: true }).first().waitFor()
  })
  await t.test('settings open and bookmark data can be written and read', async () => {
    await page.evaluate(() => window.store.openSetting())
    await page.locator('.setting-wrap').waitFor()
    const bookmark = {
      _id: 'packaged-smoke-bookmark',
      title: 'Packaged smoke bookmark',
      type: 'local',
      password: 'migration-smoke-test-secret'
    }
    await page.evaluate(item => window.pre.runGlobalAsync('dbAction', 'bookmarks', 'insert', item), bookmark)
    const saved = await page.evaluate(id => window.pre.runGlobalAsync('dbAction', 'bookmarks', 'findOne', { _id: id }), bookmark._id)
    assert.equal(saved.title, bookmark.title)
    await page.evaluate(() => window.store.hideSettingModal())
  })
  await t.test('administrator policy rejects user overrides while ordinary settings remain editable', async () => {
    const values = await page.evaluate(async () => {
      const previousFontSize = window.store.config.fontSize
      await window.pre.runGlobalAsync('saveUserConfig', {
        baseURLAI: 'https://invalid.example/ai',
        mcpServerEnabled: false,
        syncSetting: { cloudApiUrl: 'https://invalid.example/sync', autoSync: false },
        fontSize: previousFontSize + 1,
        adminLockedKeys: []
      })
      const saved = await window.pre.runGlobalAsync('dbAction', 'data', 'findOne', { _id: 'userConfig' })
      await window.pre.runGlobalAsync('saveUserConfig', { fontSize: previousFontSize })
      return { saved, originalAI: window.store.config.baseURLAI, originalSync: window.store.config.syncSetting.cloudApiUrl, previousFontSize }
    })
    assert.equal(values.saved.baseURLAI, values.originalAI)
    assert.equal(values.saved.syncSetting.cloudApiUrl, values.originalSync)
    assert.equal(values.saved.mcpServerEnabled, true)
    assert.equal(values.saved.adminLockedKeys, undefined)
    assert.equal(values.saved.fontSize, values.previousFontSize + 1)
    assert.equal(values.saved.syncSetting.autoSync, false)
  })
  await t.test('SSH shell and SFTP work through the packaged server', async () => {
    await page.evaluate(opts => window.store.addTab(opts), {
      type: 'ssh',
      host: '127.0.0.1',
      port,
      username: TEST_USERNAME,
      password: TEST_PASSWORD,
      authType: 'password',
      useSshAgent: false,
      title: 'SSH smoke',
      enableSsh: true,
      sftpPathFollowSsh: false,
      pane: 'terminal'
    })
    await page.getByRole('button', { name: 'Trust and Save', exact: true }).click()
    await page.getByText('Welcome to the electerm MCP integration test shell', { exact: false }).first().waitFor()
    await page.locator('.session-current .xterm-helper-textarea').first().focus()
    await page.keyboard.insertText('echo ANUBIS_SSH_OK')
    await page.keyboard.press('Enter')
    await page.waitForFunction(() => (document.body.innerText.match(/ANUBIS_SSH_OK/g) || []).length >= 2)
    await page.locator('.session-current .term-sftp-tabs .type-tab').nth(1).click()
    await page.locator('.session-current .sftp-remote-section').getByText(markerFile, { exact: true }).first().waitFor()
  })
  await t.test('branded deep links reach the running instance once and connect to SSH', async () => {
    const before = await page.evaluate(() => window.store.tabs.length)
    const link = `anubis://${encodeURIComponent(TEST_USERNAME)}:${encodeURIComponent(TEST_PASSWORD)}@127.0.0.1:${port}?title=Anubis%20deep%20link%20smoke&useSshAgent=false`
    await new Promise((resolve, reject) => {
      const child = spawn(executablePath, [`--user-data-dir=${userData}`, link], {
        env: { ...process.env, DATA_PATH: data, ANUBIS_ADMIN_AUTOSTART: '0', ANUBIS_ADMIN_ERROR_REPORT: '0' },
        stdio: 'ignore',
        windowsHide: true
      })
      const timer = setTimeout(() => {
        child.kill()
        reject(new Error('Deep-link secondary instance did not exit'))
      }, 15000)
      child.once('error', error => {
        clearTimeout(timer)
        reject(error)
      })
      child.once('close', code => {
        clearTimeout(timer)
        if (code === 0) resolve()
        else reject(new Error(`Deep-link secondary instance exited with ${code}`))
      })
    })
    await page.waitForFunction(count => window.store.tabs.length === count + 1, before)
    await page.locator('.session-current').getByText('Welcome to the electerm MCP integration test shell', { exact: false }).first().waitFor()
    const registration = await page.evaluate(() => window.pre.runGlobalAsync('checkProtocolRegistration'))
    assert.deepEqual(Object.keys(registration).sort(), ['anubis', 'ssh', 'telnet', 'vnc', 'rdp', 'spice', 'serial', 'ftp'].sort())
    assert.ok(Object.values(registration).every(Boolean))
  })
  await t.test('MCP starts automatically and accepts authenticated initialization', async () => {
    await page.waitForFunction(() => window.store.widgetInstances.some(w => w.widgetId === 'mcp-server'))
    const url = await page.evaluate(() => window.store.widgetInstances.find(w => w.widgetId === 'mcp-server').serverInfo.url)
    const token = readFileSync(join(userData, 'admin-mcp-token'), 'utf8').trim()
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'packaged-smoke', version: '1' } }
      }),
      signal: AbortSignal.timeout(10000)
    })
    assert.equal(response.status, 200)
    assert.match(await response.text(), /"protocolVersion"/)
    for (const authorization of ['', 'Bearer invalid-test-token']) {
      const denied = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: authorization },
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'initialize', params: {} }),
        signal: AbortSignal.timeout(10000)
      })
      assert.equal(denied.status, 401)
    }
    const publicInfo = await page.evaluate(() => window.store.widgetInstances.find(w => w.widgetId === 'mcp-server').serverInfo)
    assert.equal(publicInfo.apiKey, undefined)
    assert.equal(publicInfo.apiKeyManagedByAdmin, true)
  })
  await t.test('configured hosted AI returns a response', { skip: !process.env.ANUBIS_SMOKE_AI }, async () => {
    const result = await page.evaluate(() => {
      const c = window.store.config
      return window.pre.runGlobalAsync(
        'AIchat', 'Anubis desktop smoke test', c.modelAI, c.roleAI,
        c.baseURLAI, c.apiPathAI, c.apiKeyAI, c.proxyAI, false, c.authHeaderNameAI
      )
    })
    assert.equal(result.error, undefined)
    assert.ok(result.response?.length > 0)
    const streamed = await page.evaluate(async () => {
      const c = window.store.config
      const start = await window.pre.runGlobalAsync(
        'AIchat', 'Anubis streaming smoke test', c.modelAI, c.roleAI,
        c.baseURLAI, c.apiPathAI, c.apiKeyAI, c.proxyAI, true, c.authHeaderNameAI
      )
      if (start.error || !start.sessionId) return start
      for (let i = 0; i < 100; i++) {
        const state = await window.pre.runGlobalAsync('getStreamContent', start.sessionId)
        if (state.error || !state.hasMore) return state
        await new Promise(resolve => setTimeout(resolve, 50))
      }
      throw new Error('Hosted AI stream did not finish')
    })
    assert.equal(streamed.error, undefined)
    assert.equal(streamed.hasMore, false)
    assert.equal(streamed.content, result.response)
  })
  await t.test('VNC displays remote pixels and sends keyboard and pointer input', async () => {
    await page.evaluate(port => window.store.addTab({
      type: 'vnc',
      host: '127.0.0.1',
      port,
      title: 'VNC smoke',
      scaleViewport: false,
      viewOnly: false
    }), vnc.port)
    await page.waitForFunction(() => {
      const canvas = document.querySelector('.session-current canvas')
      if (!canvas || canvas.width !== 64 || canvas.height !== 48) return false
      const pixel = canvas.getContext('2d').getImageData(10, 10, 1, 1).data
      return pixel[0] === 0 && pixel[1] === 255 && pixel[2] === 0
    })
    const canvas = page.locator('.session-current canvas')
    await canvas.click({ position: { x: 10, y: 10 } })
    await page.keyboard.press('a')
    await assertEventually(() => vnc.events.keys.some(event => event.down && event.key === 97))
    assert.ok(vnc.events.pointers.some(event => event.buttons === 1))
    assert.deepEqual(vnc.errors, [])
  })
  await t.test('RDP renders a real remote desktop and delivers input through the packaged WASM client', {
    skip: !process.env.ANUBIS_SMOKE_RDP
  }, async () => {
    rdpForward = await startSshForward({
      host: process.env.VPS_HOST,
      port: Number(process.env.VPS_PORT || 22),
      username: 'root',
      password: process.env.VPS_PASS,
      remotePort: 3398
    })
    await page.evaluate(port => window.store.addTab({
      type: 'rdp',
      host: '127.0.0.1',
      port,
      username: 'qa',
      password: 'fixture-only',
      domain: 'anubis-qa',
      title: 'RDP smoke'
    }), rdpForward.port)
    const canvas = page.locator('.session-current canvas')
    await canvas.waitFor()
    await page.locator('.session-current .ant-spin-spinning').waitFor({ state: 'hidden' })
    // xrdp presents its login dialog when the client does not send INFO_AUTOLOGON.
    await canvas.focus()
    await page.keyboard.press('Enter')
    let lastPixel
    try {
      await assertEventually(async () => {
        const failure = errors.find(text => text.includes('[RDP-FILE-TRANSFER][error]'))
        if (failure) throw new Error(failure)
        const image = await canvas.screenshot()
        lastPixel = await page.evaluate(async data => {
          const img = new window.Image()
          img.src = 'data:image/png;base64,' + data
          await img.decode()
          const target = new window.OffscreenCanvas(img.width, img.height)
          const context = target.getContext('2d')
          context.drawImage(img, 0, 0)
          const pixel = context.getImageData(Math.floor(img.width / 2), Math.floor(img.height / 2), 1, 1).data
          return Array.from(pixel)
        }, image.toString('base64'))
        return lastPixel[0] >= 240 && lastPixel[1] >= 240 && lastPixel[2] >= 240
      }, () => `RDP fixture framebuffer did not appear; center pixel: ${lastPixel}`)
    } catch (error) {
      if (process.env.ANUBIS_SMOKE_DIAGNOSTIC_IMAGE) {
        writeFileSync(process.env.ANUBIS_SMOKE_DIAGNOSTIC_IMAGE, await page.screenshot())
      }
      throw error
    }
    await canvas.click({ position: { x: 50, y: 50 } })
    await page.keyboard.press('a')
    await assertEventually(async () => {
      const log = await rdpForward.exec('cat /opt/anubis-qa-rdp/input-events.log')
      const events = log.split('SELFTEST_COMPLETE').pop()
      return events.includes('KeyPress') && events.includes('keysym 0x61, a') && events.includes('ButtonPress')
    })
    assert.deepEqual(rdpForward.errors, [])
  })
  await t.test('an authenticated remote SSH tunnel reaches a local server from the VPS', {
    skip: !process.env.ANUBIS_SMOKE_TUNNELS
  }, async () => {
    if (!rdpForward) {
      rdpForward = await startSshForward({
        host: process.env.VPS_HOST,
        port: Number(process.env.VPS_PORT || 22),
        username: 'root',
        password: process.env.VPS_PASS,
        remotePort: 3398
      })
    }
    localHttp = http.createServer((req, res) => res.end('ANUBIS_REVERSE_TUNNEL_OK'))
    await new Promise(resolve => localHttp.listen(0, '127.0.0.1', resolve))
    const remotePort = Number(await rdpForward.exec(
      "node -e \"const s=require('net').createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})\""
    ))
    await page.evaluate(options => window.store.addTab(options), {
      type: 'ssh',
      host: process.env.VPS_HOST,
      port: Number(process.env.VPS_PORT || 22),
      username: 'root',
      password: process.env.VPS_PASS,
      authType: 'password',
      useSshAgent: false,
      title: 'Reverse tunnel smoke',
      enableSsh: true,
      pane: 'terminal',
      sshTunnels: [{
        sshTunnel: 'forwardRemoteToLocal',
        sshTunnelRemoteHost: '127.0.0.1',
        sshTunnelRemotePort: remotePort,
        sshTunnelLocalHost: '127.0.0.1',
        sshTunnelLocalPort: localHttp.address().port
      }]
    })
    await page.waitForFunction(() => document.body.innerText.includes('Trust SSH host key') ||
      window.store.tabs.some(tab => tab.title === 'Reverse tunnel smoke' && tab.sshTunnelResults?.length))
    const trust = page.getByRole('button', { name: 'Trust and Save', exact: true })
    if (await trust.isVisible()) {
      await trust.click()
      const target = Number(process.env.VPS_PORT || 22) === 22
        ? process.env.VPS_HOST
        : `[${process.env.VPS_HOST}]:${process.env.VPS_PORT}`
      for (const line of readFileSync(knownHosts, 'utf8').split(/\r?\n/)) {
        if (line.split(/\s+/)[0] === target && !initialHostEntries.has(line)) cleanupHostEntries.add(line)
      }
    }
    await page.waitForFunction(() => window.store.tabs.some(tab =>
      tab.title === 'Reverse tunnel smoke' && tab.sshTunnelResults?.length))
    const result = await page.evaluate(() => window.store.tabs.find(tab =>
      tab.title === 'Reverse tunnel smoke').sshTunnelResults[0])
    assert.equal(result.error, undefined)
    assert.equal(await rdpForward.exec(
      `curl --fail --silent --max-time 5 http://127.0.0.1:${remotePort}`
    ), 'ANUBIS_REVERSE_TUNNEL_OK')
    await page.evaluate(() => window.store.delTab(
      window.store.tabs.find(tab => tab.title === 'Reverse tunnel smoke').id
    ))
  })
  await app.close()
  app = undefined
  const restarted = await launch()
  await t.test('bookmark data survives restart and remains decryptable', async () => {
    const saved = await restarted.evaluate(() => window.pre.runGlobalAsync(
      'dbAction', 'bookmarks', 'findOne', { _id: 'packaged-smoke-bookmark' }
    ))
    assert.equal(saved?.title, 'Packaged smoke bookmark')
    assert.equal(saved?.password, 'migration-smoke-test-secret')
  })
  await t.test('hosted sync round-trips encrypted bookmarks and automatically uploads changes', {
    skip: !process.env.ANUBIS_SMOKE_SYNC_TOKEN
  }, async () => {
    await restarted.evaluate(token => {
      window.store.updateSyncSetting({
        cloudAccessToken: token,
        cloudGistId: 'cloud',
        cloudSyncPassword: 'anubis-sync-smoke-encryption-password',
        autoSync: false
      })
    }, process.env.ANUBIS_SMOKE_SYNC_TOKEN)
    await restarted.evaluate(() => window.store.uploadSettingAction('cloud'))
    const uploaded = await restarted.evaluate(() => window.store.previewServerData('cloud'))
    const ciphertext = uploaded.files['bookmarks.json'].content
    assert.ok(ciphertext.startsWith('gcm:'))
    assert.ok(!ciphertext.includes('migration-smoke-test-secret'))
    assert.ok(!ciphertext.includes('Packaged smoke bookmark'))
    await restarted.evaluate(() => window.store.setBookmarks([]))
    await restarted.waitForFunction(() => window.store.bookmarks.length === 0)
    await restarted.evaluate(() => window.store.downloadSettingAction('cloud'))
    await restarted.waitForFunction(() => window.store.bookmarks.some(b => b.title === 'Packaged smoke bookmark'))
    await restarted.evaluate(() => {
      window.store.updateSyncSetting({ autoSync: true, autoSyncInterval: 0, autoSyncDirection: 'upload' })
      window.store.setBookmarks(window.store.bookmarks.map(bookmark => ({
        ...bookmark,
        description: 'Anubis automatic sync fixture'
      })))
    })
    await restarted.waitForFunction(async () => {
      const gist = await window.store.previewServerData('cloud')
      const value = await window.pre.runGlobalAsync(
        'decryptAsync', gist.files['bookmarks.json'].content, 'anubis-sync-smoke-encryption-password'
      )
      return JSON.parse(value).some(b => b.description === 'Anubis automatic sync fixture')
    })
    await restarted.evaluate(() => {
      window.store.updateSyncSetting({ autoSync: false, cloudAccessToken: '', cloudSyncPassword: '', cloudGistId: '' })
    })
  })
  await app.close()
  app = undefined
  await t.test('first portable startup migrates legacy data without changing its source', async () => {
    const portable = join(root, 'portable')
    const legacy = join(portable, 'electerm')
    const migrated = join(portable, 'anubis')
    cpSync(dirname(executablePath), portable, { recursive: true })
    cpSync(userData, legacy, { recursive: true })
    cpSync(data, legacy, { recursive: true })
    mkdirSync(migrated)
    const legacyDb = join(legacy, 'users', 'default_user', 'electerm.db')
    const digest = () => createHash('sha256').update(readFileSync(legacyDb)).digest('hex')
    const before = digest()
    const migratedPage = await launch({
      exe: join(portable, basename(executablePath)),
      profile: migrated,
      dataPath: ''
    })
    const saved = await migratedPage.evaluate(() => window.pre.runGlobalAsync(
      'dbAction', 'bookmarks', 'findOne', { _id: 'packaged-smoke-bookmark' }
    ))
    assert.equal(saved?.title, 'Packaged smoke bookmark', JSON.stringify({
      targetFiles: readdirSync(migrated),
      legacyFiles: readdirSync(legacy),
      paths: await app.evaluate(({ app }) => ({
        app: app.getAppPath(),
        userData: app.getPath('userData')
      }))
    }))
    assert.equal(saved?.password, 'migration-smoke-test-secret')
    assert.ok(existsSync(join(migrated, 'users', 'default_user', 'electerm.db')))
    assert.equal(digest(), before)
  })
  assert.deepEqual(errors, [], 'packaged app logged runtime errors')
})

async function assertEventually (predicate, message = 'Remote input did not reach the fixture server') {
  for (let i = 0; i < 100; i++) {
    if (await predicate()) return
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  assert.fail(typeof message === 'function' ? message() : message)
}
