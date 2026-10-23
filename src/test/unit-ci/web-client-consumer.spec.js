const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { verifyWebClientConsumer } = require('../../build/bin/verify-web-client-consumer')

test('immutable client verification requires exact files, bytes and normalized registry metadata', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'anubis-client-consumer-'))
  try {
    const assembled = path.join(directory, 'assembled')
    const installed = path.join(directory, 'installed')
    fs.mkdirSync(path.join(assembled, 'client'), { recursive: true })
    const metadata = {
      name: '@ai-security-tool/electerm-react',
      version: '5.7.3',
      files: ['client', 'LICENSE'],
      publishConfig: { registry: 'https://npm.anubis.locker' }
    }
    fs.writeFileSync(path.join(assembled, 'package.json'), JSON.stringify(metadata))
    fs.writeFileSync(path.join(assembled, 'client', 'entry.js'), 'export default true\n')
    fs.writeFileSync(path.join(assembled, 'LICENSE'), 'MIT\n')
    fs.writeFileSync(path.join(assembled, '.npmignore'), 'not part of the package\n')
    fs.cpSync(assembled, installed, { recursive: true })
    fs.unlinkSync(path.join(installed, '.npmignore'))
    metadata.publishConfig.registry += '/'
    fs.writeFileSync(path.join(installed, 'package.json'), JSON.stringify(metadata))
    verifyWebClientConsumer(assembled, installed)
    fs.writeFileSync(path.join(installed, 'unexpected.js'), 'extra\n')
    assert.throws(() => verifyWebClientConsumer(assembled, installed), /inventory differs/)
    fs.unlinkSync(path.join(installed, 'unexpected.js'))
    fs.writeFileSync(path.join(installed, 'client', 'entry.js'), 'export default false\n')
    assert.throws(() => verifyWebClientConsumer(assembled, installed), /entry\.js/)
    fs.copyFileSync(path.join(assembled, 'client', 'entry.js'), path.join(installed, 'client', 'entry.js'))
    metadata.version = '5.7.4'
    fs.writeFileSync(path.join(installed, 'package.json'), JSON.stringify(metadata))
    assert.throws(() => verifyWebClientConsumer(assembled, installed), /metadata differs/)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
