const { test } = require('node:test')
const assert = require('node:assert/strict')
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const { _electron: electron } = require('playwright')

test('packaged Unix desktop functionality', {
  skip: process.platform === 'win32',
  timeout: 180000
}, async t => {
  assert.ok(process.env.ANUBIS_SMOKE_EXE, 'ANUBIS_SMOKE_EXE must identify the packaged executable')
  const root = mkdtempSync(join(tmpdir(), 'anubis-unix-smoke-'))
  const home = join(root, 'home')
  mkdirSync(home)
  const markerFile = 'anubis-smoke-file.txt'
  writeFileSync(join(home, markerFile), 'packaged Unix file manager fixture')
  const bookmark = {
    _id: 'unix-packaged-smoke',
    title: 'Packaged Unix bookmark',
    type: 'ssh',
    host: '127.0.0.1',
    password: 'packaged-unix-test-secret'
  }
  const errors = []
  let app
  async function launch () {
    app = await electron.launch({
      executablePath: resolve(process.env.ANUBIS_SMOKE_EXE),
      args: [`--user-data-dir=${join(root, 'profile')}`],
      env: {
        ...process.env,
        HOME: home,
        NODE_ENV: 'production',
        NODE_TEST: '',
        DATA_PATH: join(root, 'data'),
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
    const capture = page => {
      if (captured.has(page)) return
      captured.add(page)
      page.on('pageerror', error => errors.push(error.stack))
      page.on('console', message => {
        if (message.type() === 'error') errors.push(message.text())
      })
    }
    app.on('window', capture)
    const page = await app.firstWindow()
    capture(page)
    await page.waitForFunction(() => window.store?.configLoaded)
    return page
  }
  t.after(async () => {
    try {
      if (app) await app.close()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
  let page = await launch()
  await t.test('native terminal executes a shell command', async () => {
    await page.waitForFunction(() => /[%$#] /.test(document.querySelector('.session-current .xterm-rows')?.innerText || ''))
    const sidebar = page.locator('.control-icon-wrap.active[title="Bookmarks"]')
    if (await sidebar.isVisible()) await sidebar.click()
    await page.locator('.session-current .xterm-helper-textarea').first().focus()
    await page.keyboard.insertText("printf 'ANUBIS_%s\\n' PACKAGED_UNIX_OK")
    await page.keyboard.press('Enter')
    await page.waitForFunction(() => document.body.innerText.includes('ANUBIS_PACKAGED_UNIX_OK'))
  })
  await t.test('file manager lists a real local file', async () => {
    await page.locator('.session-current .term-sftp-tabs .type-tab').nth(1).click()
    const address = page.locator('.session-current .sftp-local-section .sftp-title input').first()
    await address.fill(home)
    await address.press('Enter')
    await page.locator('.session-current .sftp-local-section').getByText(markerFile, { exact: true }).first().waitFor()
  })
  await t.test('settings and OS-backed encryption work in the packaged application', async () => {
    await page.evaluate(() => window.store.openSetting())
    await page.locator('.setting-wrap').waitFor()
    const encryption = await page.evaluate(async () => {
      const encrypted = await window.pre.runGlobalAsync('safeEncrypt', 'packaged-unix-keyring')
      const decrypted = await window.pre.runGlobalAsync('safeDecrypt', encrypted)
      return { encrypted, decrypted }
    })
    assert.match(encryption.encrypted, /^v2:safe:/)
    assert.equal(encryption.decrypted, 'packaged-unix-keyring')
    await page.evaluate(item => window.pre.runGlobalAsync('dbAction', 'bookmarks', 'insert', item), bookmark)
    await page.evaluate(() => window.store.hideSettingModal())
  })
  await t.test('bookmarks and passwords survive a real application restart', async () => {
    await app.close()
    app = null
    page = await launch()
    const saved = await page.evaluate(id => window.pre.runGlobalAsync('dbAction', 'bookmarks', 'findOne', { _id: id }), bookmark._id)
    assert.equal(saved.title, bookmark.title)
    assert.equal(saved.password, bookmark.password)
  })
  assert.deepEqual(errors, [], 'packaged Unix application logged runtime errors')
})
