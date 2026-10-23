const assert = require('node:assert/strict')

async function checkSerialSession (page, { path, readInput }) {
  await page.evaluate(path => window.store.addTab({
    type: 'serial',
    path,
    title: 'Serial PTY acceptance',
    baudRate: 9600,
    dataBits: 8,
    stopBits: 1,
    parity: 'none',
    rtscts: false,
    txLineEnding: '\n',
    rxLineEnding: 'lf_to_crlf'
  }), path)
  await page.waitForFunction(() => document.querySelector('.session-current')?.innerText.includes('ANUBIS_SERIAL_READY'))
  await page.locator('.session-current .xterm-helper-textarea').focus()
  await page.keyboard.insertText('ANUBIS_SERIAL_INPUT')
  await page.keyboard.press('Enter')
  await page.waitForFunction(() => document.querySelector('.session-current')?.innerText.includes('PTY_RX:ANUBIS_SERIAL_INPUT'))
  assert.equal(Buffer.from(await readInput()).toString(), 'ANUBIS_SERIAL_INPUT\n')
  await page.evaluate(() => window.store.delTab(
    window.store.tabs.find(tab => tab.title === 'Serial PTY acceptance').id
  ))
}

module.exports = { checkSerialSession }
