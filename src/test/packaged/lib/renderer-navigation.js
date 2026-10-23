const assert = require('node:assert/strict')

async function clickSettingTab (page, key) {
  const tab = page.locator(`.setting-tabs [data-node-key="${key}"] [role="tab"]`)
  await tab.click()
  await page.waitForFunction(value => window.store.settingTab === value, key)
}

async function checkRendererNavigation (page, t) {
  await t.test('the actual About button and every information section render', async () => {
    await page.locator('.control-icon-wrap[title="About"]').click()
    const modal = page.locator('.info-modal')
    await modal.waitFor()
    for (const tab of await modal.getByRole('tab').all()) {
      await tab.click()
      assert.equal(await tab.getAttribute('aria-selected'), 'true')
    }
    await modal.locator('.custom-modal-close').click()
    await modal.waitFor({ state: 'hidden' })
  })
  await page.locator('.control-icon-wrap[title="Setting"]').click()
  await page.locator('.setting-wrap input').first().waitFor()
  const sections = {
    bookmarks: '.setting-tabs-bookmarks .tree-item',
    setting: '.setting-tabs-setting .item-list-unit',
    terminalThemes: '#terminal-theme-form_themeName',
    quickCommands: '#commands_0_command',
    triggers: '#matchValue',
    profiles: '.setting-tabs-profile #username'
  }
  for (const [key, selector] of Object.entries(sections)) {
    await t.test(`the ${key} section loads through a real navigation click`, async () => {
      await clickSettingTab(page, key)
      await page.locator('.setting-wrap').locator(selector).first().waitFor({ timeout: 10000 })
      assert.equal(await page.locator('.setting-wrap .common-err-desc').count(), 0)
    })
  }
  await t.test('the widgets section loads through a real navigation click', async () => {
    await clickSettingTab(page, 'widgets')
    await page.getByText('Select a widget to configure', { exact: true }).waitFor()
  })
  await clickSettingTab(page, 'setting')
  for (const category of ['Common', 'Terminal', 'Shortcuts', 'Setting sync', 'AI', 'Password']) {
    await t.test(`the ${category} settings page renders`, async () => {
      const item = page.locator('.setting-tabs-setting .item-list-unit').filter({ hasText: category })
      await item.click()
      await page.waitForFunction(text => {
        const active = document.querySelector('.setting-tabs-setting .item-list-unit.active')
        return active?.textContent.includes(text)
      }, category)
      assert.equal(await page.locator('.setting-wrap .common-err-desc').count(), 0)
    })
  }
  await page.locator('.close-setting-wrap:visible').first().click()
  await page.locator('.setting-wrap').waitFor({ state: 'hidden' })
}

module.exports = { checkRendererNavigation, clickSettingTab }
