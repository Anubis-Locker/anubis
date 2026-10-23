const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

function verifyWebClientConsumer (assembled, installed) {
  const readPackage = root => JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  const expectedPackage = readPackage(assembled)
  const actualPackage = readPackage(installed)
  const normalize = pkg => {
    if (pkg.publishConfig?.registry) {
      pkg.publishConfig.registry = new URL(pkg.publishConfig.registry).href
    }
    return pkg
  }
  assert.deepEqual(normalize(actualPackage), normalize(expectedPackage), 'Published client metadata differs')
  const expected = new Set(['package.json'])
  const collect = (root, relative, result) => {
    const file = path.resolve(root, relative)
    assert.ok(file.startsWith(path.resolve(root) + path.sep), 'Invalid package file path')
    const info = fs.lstatSync(file)
    if (info.isDirectory()) {
      for (const child of fs.readdirSync(file)) collect(root, path.join(relative, child), result)
    } else {
      assert.ok(info.isFile(), 'Only regular package files are accepted')
      result.add(relative.split(path.sep).join('/'))
    }
  }
  for (const file of [...expectedPackage.files, 'LICENSE', 'README.md']) {
    if (fs.existsSync(path.join(assembled, file))) collect(assembled, file, expected)
  }
  const actual = new Set()
  for (const file of fs.readdirSync(installed)) collect(installed, file, actual)
  assert.deepEqual(actual, expected, 'Published client file inventory differs')
  for (const file of expected) {
    if (file === 'package.json') continue
    assert.ok(fs.readFileSync(path.join(assembled, file)).equals(fs.readFileSync(path.join(installed, file))), file)
  }
}

module.exports = { verifyWebClientConsumer }
if (require.main === module) {
  verifyWebClientConsumer(path.resolve(process.argv[2]), path.resolve(process.argv[3]))
  console.log('Existing immutable client matches the complete assembled source')
}
