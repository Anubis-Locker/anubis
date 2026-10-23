const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const net = require('node:net')
const { once } = require('node:events')
const { spawn, execFileSync } = require('node:child_process')
const { DatabaseSync } = require('node:sqlite')
const { chromium } = require('playwright')
const { snapshotWindowsProtocols } = require('../integration/lib/windows-protocol-fixture')
const { checkRendererNavigation } = require('./lib/renderer-navigation')

async function reservePort () {
  const server = net.createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  return port
}

async function bounded (promise, timeout, message) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeout)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}

test('ordinary packaged launch and relaunch preserve native functionality', {
  skip: process.platform !== 'win32' || !process.env.ANUBIS_ORDINARY_EXE,
  timeout: 180000
}, async t => {
  const executable = path.resolve(process.env.ANUBIS_ORDINARY_EXE)
  assert.ok(fs.statSync(executable).isFile())
  assert.ok(fs.existsSync(path.join(path.dirname(executable), 'resources', 'app.asar')),
    'Use the packaged executable, not an installer or bare Electron')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'anubis-ordinary-launch-'))
  const profile = path.join(root, 'profile')
  const data = path.join(root, 'data')
  const home = path.join(root, 'home')
  const appData = path.join(root, 'appdata')
  for (const dir of [profile, data, home, appData]) fs.mkdirSync(dir)
  for (const name of ['Local', 'Roaming']) fs.mkdirSync(path.join(home, 'AppData', name), { recursive: true })
  const databaseDirectory = path.join(data, 'users', 'default_user')
  fs.mkdirSync(databaseDirectory, { recursive: true })
  const db = new DatabaseSync(path.join(databaseDirectory, 'electerm_data.db'))
  db.exec('CREATE TABLE data (_id TEXT PRIMARY KEY, data TEXT)')
  const insert = db.prepare('INSERT INTO data (_id, data) VALUES (?, ?)')
  insert.run('userConfigNoEncrypt', JSON.stringify({ _id: 'userConfigNoEncrypt', allowMultiInstance: true }))
  insert.run('userConfig', JSON.stringify({
    _id: 'userConfig',
    allowMultiInstance: true,
    debug: true,
    confirmBeforeExit: false,
    deepLinkAutoRegister: false
  }))
  db.close()
  const env = {
    ...process.env,
    DATA_PATH: data,
    HOME: home,
    USERPROFILE: home,
    APPDATA: appData,
    LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    ANUBIS_ADMIN_AUTOSTART: '0',
    ANUBIS_ADMIN_MANAGED_ENABLED: '0',
    ANUBIS_ADMIN_MCP_ENABLED: '0',
    ANUBIS_ADMIN_ERROR_REPORT: '0',
    ANUBIS_ADMIN_UPDATE_ENABLED: '0'
  }
  for (const key of Object.keys(env)) {
    if (['NODE_ENV', 'NODE_TEST', 'NODE_TEST_CONTEXT', 'NODE_OPTIONS', 'NODE_V8_COVERAGE',
      'ELECTRON_RUN_AS_NODE', 'ANUBIS_MANAGED_ADMIN_TOKEN'].includes(key.toUpperCase())) delete env[key]
  }
  const protocols = snapshotWindowsProtocols(root, [root, executable])
  const report = { executable, cwd: path.dirname(executable), nodeEnvSet: false, launches: [], passed: false }
  const expectedOwner = execFileSync('whoami.exe', { encoding: 'utf8' }).trim().toLowerCase()
  const errors = []
  let processHandle
  let browser
  t.after(async () => {
    const cleanupErrors = []
    const clean = async fn => {
      try {
        await fn()
      } catch (error) {
        cleanupErrors.push(error.message)
      }
    }
    try {
      if (processHandle?.exitCode === null) {
        await clean(() => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
          `$p=Get-Process -Id ${processHandle.pid} -ErrorAction Stop; $p.CloseMainWindow() | Out-Null`]))
      }
      if (browser) await clean(() => browser.close())
      if (processHandle?.exitCode === null) {
        await clean(async () => {
          try {
            await bounded(once(processHandle, 'exit'), 5000, 'Isolated ordinary-launch process did not close')
          } catch (error) {
            execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
              `Stop-Process -Id ${processHandle.pid} -Force -ErrorAction Stop`])
            throw error
          }
        })
      }
      await clean(() => protocols.restore())
      if (!cleanupErrors.length) {
        await clean(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }))
      }
      report.cleanupPassed = !cleanupErrors.length
      report.cleanupErrors = cleanupErrors
      if (cleanupErrors.length) {
        report.passed = false
        throw new Error('Ordinary-launch cleanup failed; recovery files retained at ' + root)
      }
    } finally {
      if (process.env.ANUBIS_ORDINARY_REPORT) {
        fs.writeFileSync(path.resolve(process.env.ANUBIS_ORDINARY_REPORT), JSON.stringify(report, null, 2))
      }
    }
  })
  for (let attempt = 1; attempt <= 2; attempt++) {
    const debugPort = await reservePort()
    const serverPort = await reservePort()
    // Direct spawning avoids Electron's Playwright main-process harness and
    // production NODE_ENV overrides that ordinary desktop shortcuts do not use.
    processHandle = spawn(executable, [
      `--user-data-dir=${profile}`,
      '--remote-debugging-address=127.0.0.1',
      `--remote-debugging-port=${debugPort}`,
      '--server-port', String(serverPort)
    ], { cwd: path.dirname(executable), env, stdio: ['ignore', 'pipe', 'pipe'] })
    const launch = { attempt, pid: processHandle.pid, startupErrors: [] }
    report.launches.push(launch)
    for (const stream of [processHandle.stdout, processHandle.stderr]) {
      stream.on('data', chunk => {
        for (const line of chunk.toString().split(/\r?\n/)) {
          if (/Error|ENOENT|MODULE_NOT_FOUND|DevTools listening|Failed to start/.test(line)) {
            launch.startupErrors.push(line.replace(/\b[0-9a-f]{64,128}\b/gi, '[redacted]')
              .replace(/([?&](?:token|ticket)=)[^&\s]+/gi, '$1[redacted]'))
          }
        }
      })
    }
    const exited = once(processHandle, 'exit')
    let endpointReady = false
    const deadline = Date.now() + 30000
    while (Date.now() < deadline && processHandle.exitCode === null) {
      try {
        const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`, { signal: AbortSignal.timeout(1000) })
        const targets = await response.json()
        endpointReady = response.ok && targets.some(target =>
          target.type === 'page' && target.url.startsWith(`http://127.0.0.1:${serverPort}/index.html`))
      } catch (error) {
        if (!['TypeError', 'TimeoutError'].includes(error.name)) throw error
      }
      if (endpointReady) break
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    assert.ok(endpointReady, 'Ordinarily spawned application did not load its native renderer target')
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`)
    const context = browser.contexts()[0]
    const page = context.pages()[0] || await context.waitForEvent('page')
    page.on('pageerror', error => errors.push(error.message))
    await page.waitForFunction(() => window.store?.configLoaded && !!window.pre?.runGlobalAsync).catch(async error => {
      report.failure = error.message
      report.pageState = await bounded(page.evaluate(() => ({
        origin: window.location.origin,
        path: window.location.pathname,
        readyState: document.readyState,
        hasPre: !!window.pre,
        hasStore: !!window.store,
        configLoaded: !!window.store?.configLoaded,
        hasPassword: !!document.querySelector('input[type="password"]')
      })), 2000, 'Native page diagnostic timed out').catch(error => ({ error: error.message }))
      throw error
    })
    const owner = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `$p=Get-CimInstance Win32_Process -Filter 'ProcessId=${processHandle.pid}'; $o=Invoke-CimMethod -InputObject $p -MethodName GetOwner; @{owner=($o.Domain+'\\'+$o.User)} | ConvertTo-Json -Compress`
    ], { encoding: 'utf8' })).owner.toLowerCase()
    assert.equal(owner, expectedOwner)
    launch.owner = owner
    const nativeEnv = await page.evaluate(() => window.pre.runGlobalAsync('getEnv'))
    assert.equal(Object.hasOwn(nativeEnv, 'NODE_ENV'), false)
    assert.equal(path.resolve(nativeEnv.APPDATA).toLowerCase(), appData.toLowerCase())
    assert.equal(path.resolve(nativeEnv.HOME).toLowerCase(), home.toLowerCase())
    const constants = await page.evaluate(() => window.pre.runSync('getConstants'))
    assert.equal(constants.isDev, false)
    assert.equal(constants.isTest, false)
    const dimensions = await page.evaluate(() => window.pre.runGlobalAsync('getScreenSize'))
    assert.ok(dimensions.width > 0 && dimensions.height > 0)
    assert.equal(await page.evaluate(() => window.store.config.allowMultiInstance), true)
    const startupConfig = await page.evaluate(() => window.pre.runGlobalAsync('dbAction',
      'data', 'findOne', { _id: 'userConfigNoEncrypt' }))
    assert.equal(startupConfig.allowMultiInstance, true)
    launch.nativeIpcReady = true
    await page.waitForFunction(() => /PS [^\r\n]*>/.test(document.body.innerText))
    await page.locator('.session-current .xterm-helper-textarea').first().focus()
    await page.keyboard.insertText(`Write-Output ("ANUBIS_ORDINARY_" + "LAUNCH_${attempt}"); whoami`)
    await page.keyboard.press('Enter')
    await page.waitForFunction(({ marker, owner }) =>
      document.body.innerText.includes(marker) && document.body.innerText.toLowerCase().includes(owner),
    { marker: `ANUBIS_ORDINARY_LAUNCH_${attempt}`, owner: expectedOwner })
    launch.terminalOwner = owner
    await checkRendererNavigation(page, {
      test: (name, fn) => t.test(`launch ${attempt}: ${name}`, async sub => {
        try {
          await fn(sub)
        } catch (error) {
          launch.navigationFailed = true
          throw error
        }
      })
    })
    assert.notEqual(launch.navigationFailed, true)
    launch.navigationReady = true
    const close = page.evaluate(() => window.pre.runGlobalAsync('closeApp', 'closeApp'))
    await close.catch(error => {
      if (!/Target.*closed|closed|destroyed/i.test(error.message)) throw error
    })
    await browser.close()
    browser = null
    await bounded(exited, 15000, 'Normal window close did not terminate the isolated application')
    assert.equal(processHandle.exitCode, 0)
    launch.exitCode = processHandle.exitCode
  }
  assert.deepEqual(errors, [])
  assert.ok(report.launches.every(launch => launch.nativeIpcReady && launch.navigationReady && launch.exitCode === 0))
  report.passed = true
})
