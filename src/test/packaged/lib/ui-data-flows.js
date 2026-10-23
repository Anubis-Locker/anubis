const assert = require('node:assert/strict')
const { clickSettingTab } = require('./renderer-navigation')

const names = {
  command: 'Packaged UI quick command',
  profile: 'Packaged UI profile',
  trigger: 'Packaged UI trigger',
  theme: 'Packaged UI theme',
  bookmark: 'Packaged UI local bookmark'
}

async function checkUIDataFlows (page, t) {
  await page.locator('.control-icon-wrap[title="Setting"]').click()
  await t.test('quick commands are created through their actual form', async () => {
    await clickSettingTab(page, 'quickCommands')
    await page.locator('.setting-wrap #name').fill(names.command)
    const command = process.platform === 'win32'
      ? 'Write-Output ("ANUBIS_" + "UI_QUICK_COMMAND_OK")'
      : "printf 'ANUBIS_%s\\n' UI_QUICK_COMMAND_OK"
    await page.locator('.setting-wrap #commands_0_command').fill(command)
    await page.locator('.setting-wrap button[type="submit"]:visible').click()
    await page.locator('.setting-wrap .item-list-unit').filter({ hasText: names.command }).first().waitFor()
  })
  await t.test('credential profiles are saved through their actual form', async () => {
    await clickSettingTab(page, 'profiles')
    await page.locator('.setting-wrap #name').fill(names.profile)
    await page.locator('.setting-wrap #username').fill('packaged-ui-user')
    await page.locator('.setting-wrap #password').fill('packaged-ui-password')
    await page.locator('.setting-wrap button[type="submit"]:visible').click()
    await page.locator('.setting-wrap .item-list-unit').filter({ hasText: names.profile }).first().waitFor()
  })
  await t.test('terminal triggers are saved through their actual form', async () => {
    await clickSettingTab(page, 'triggers')
    await page.locator('.setting-wrap #name').fill(names.trigger)
    await page.locator('.setting-wrap #matchValue').fill('PACKAGED_UI_UNUSED_PATTERN')
    await page.locator('.setting-wrap #actionValue').fill('echo packaged-ui-action')
    await page.locator('.setting-wrap').getByRole('button', { name: 'Save', exact: true }).click()
    await page.locator('.setting-wrap .item-list-unit').filter({ hasText: names.trigger }).first().waitFor()
  })
  await t.test('custom themes are saved through their actual form', async () => {
    await clickSettingTab(page, 'terminalThemes')
    await page.locator('.setting-wrap #terminal-theme-form_themeName').fill(names.theme)
    await page.locator('.setting-wrap').getByRole('button', { name: 'Save', exact: true }).click()
    await page.locator('.setting-wrap .item-list-unit').filter({ hasText: names.theme }).first().waitFor()
  })
  await clickSettingTab(page, 'bookmarks')
  await page.locator('.setting-wrap button:has(.with-plus[aria-label="book"])').click()
  for (const type of ['ssh', 'telnet', 'vnc', 'rdp', 'ftp', 'serial', 'spice', 'web', 'local']) {
    await t.test(`the ${type} connection editor renders the correct protocol form`, async () => {
      const radio = page.locator(`.setting-wrap .ant-radio-button-wrapper:has(input[value="${type}"])`)
      await radio.click()
      await page.locator('.setting-wrap input[id$="_title"]:visible').first().waitFor()
      assert.equal(await radio.locator('input').isChecked(), true)
      const defaultPort = { ssh: '22', telnet: '23', vnc: '5900', rdp: '3389', ftp: '21' }[type]
      if (defaultPort) {
        assert.equal(await page.locator('.setting-wrap input[id$="_port"]:visible').inputValue(), defaultPort)
      }
    })
  }
  await t.test('a local bookmark is created and connected through the actual form', async () => {
    await page.locator('.setting-wrap #local-form_title').fill(names.bookmark)
    await page.locator('.setting-wrap button[type="submit"]:visible').first().click()
    await page.waitForFunction(title => window.store.bookmarks.some(item => item.title === title), names.bookmark)
  })
  const close = page.locator('.close-setting-wrap:visible').first()
  if (await close.isVisible()) await close.click()
  await t.test('a saved quick command actually executes in the terminal', async () => {
    await page.locator('.session-current .xterm-helper-textarea').waitFor()
    await page.locator('.quick-command-trigger-wrap .ant-btn').click()
    await page.locator('.qm-item').filter({ hasText: names.command }).first().click()
    await page.waitForFunction(() => document.body.innerText.includes('ANUBIS_UI_QUICK_COMMAND_OK'))
  })
}

async function checkUIDataPersistence (page) {
  const saved = await page.evaluate(titles => ({
    command: window.store.quickCommands.find(item => item.name === titles.command),
    profile: window.store.profiles.find(item => item.name === titles.profile),
    trigger: window.store.triggers.find(item => item.name === titles.trigger),
    theme: window.store.terminalThemes.find(item => item.name === titles.theme),
    bookmark: window.store.bookmarks.find(item => item.title === titles.bookmark)
  }), names)
  assert.ok(saved.command, 'UI-created quick command survives restart')
  assert.equal(saved.profile?.username, 'packaged-ui-user')
  assert.equal(saved.profile?.password, 'packaged-ui-password')
  assert.ok(saved.theme, 'UI-created theme survives restart')
  assert.ok(saved.trigger, 'UI-created trigger survives restart')
  assert.equal(saved.bookmark?.type, 'local')
}

module.exports = { checkUIDataFlows, checkUIDataPersistence }
