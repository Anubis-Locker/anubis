const fs = require('node:fs')
const path = require('node:path')

function assembleWebClient ({
  root = path.resolve(__dirname, '../../..'),
  target = path.join(root, 'src/build/web-app'),
  name = process.env.CLIENT_PKG_NAME || '@ai-security-tool/electerm-react',
  registry = process.env.NPM_REGISTRY_URL
} = {}) {
  if (new URL(registry).protocol !== 'https:') {
    throw new Error('Client publication requires an HTTPS registry')
  }
  const template = path.join(root, 'src/build/web-app')
  const pkg = JSON.parse(fs.readFileSync(path.join(template, 'package.json'), 'utf8'))
  pkg.name = name
  pkg.version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version
  pkg.publishConfig = { registry }
  fs.mkdirSync(target, { recursive: true })
  for (const file of ['LICENSE', '.npmignore', 'README.md']) {
    const source = path.join(template, file)
    if (target !== template && fs.existsSync(source)) {
      fs.copyFileSync(source, path.join(target, file))
    }
  }
  fs.writeFileSync(path.join(target, 'package.json'), JSON.stringify(pkg, null, 2) + '\n')
  fs.rmSync(path.join(target, 'client'), { recursive: true, force: true })
  fs.cpSync(path.join(root, 'src/client'), path.join(target, 'client'), { recursive: true })
  for (const file of pkg.files.filter(file => file.startsWith('app/common/'))) {
    const destination = path.join(target, file)
    fs.mkdirSync(path.dirname(destination), { recursive: true })
    fs.copyFileSync(path.join(root, 'src', file), destination)
  }
  return target
}

if (require.main === module) assembleWebClient()

module.exports = { assembleWebClient }
