const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { execFileSync } = require('node:child_process')
const { assembleWebClient } = require('../../build/bin/assemble-web-client')

test('published renderer resolves shared browser modules without the app checkout', async () => {
  const root = path.resolve(__dirname, '../../..')
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'anubis-client-package-'))
  try {
    const target = assembleWebClient({
      root, target: path.join(temporary, 'package'), registry: 'https://npm.anubis.locker/'
    })
    const npmCli = process.env.npm_execpath || fs.realpathSync(path.join(path.dirname(process.execPath),
      process.platform === 'win32' ? 'node_modules/npm/bin/npm-cli.js' : 'npm'))
    const npm = args => execFileSync(process.execPath, [npmCli, ...args], options)
    const options = {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 60000,
      env: { ...process.env, npm_config_update_notifier: 'false' }
    }
    options.cwd = target
    const [packed] = JSON.parse(npm(['pack', '--json', '--ignore-scripts']))
    const files = new Set(packed.files.map(file => file.path))
    const consumer = path.join(temporary, 'consumer')
    fs.mkdirSync(consumer)
    fs.writeFileSync(path.join(consumer, 'package.json'), '{"private":true}\n')
    options.cwd = consumer
    npm([
      'install', '--ignore-scripts', '--no-package-lock', '--no-audit', '--no-fund',
      path.relative(consumer, path.join(target, packed.filename))
    ])
    const installed = path.join(consumer, 'node_modules', '@ai-security-tool', 'electerm-react')
    const client = path.join(installed, 'client')
    const shared = new Set()
    for (const entry of fs.readdirSync(client, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || !/\.[cm]?[jt]sx?$/.test(entry.name)) continue
      const file = path.join(entry.parentPath, entry.name)
      const source = fs.readFileSync(file, 'utf8')
      const imports = source.matchAll(/(?:\bfrom\s*|\bimport\s*(?:\(\s*)?|\brequire\s*\(\s*)['"](\.[^'"]+)['"]/g)
      for (const [, specifier] of imports) {
        const resolved = path.resolve(path.dirname(file), specifier)
        if (!path.relative(client, resolved).startsWith('..')) continue
        const relative = path.relative(installed, resolved).split(path.sep).join('/')
        assert.ok(files.has(relative), `Packed shared import is missing: ${relative}`)
        assert.deepEqual(fs.readFileSync(resolved), fs.readFileSync(path.join(root, 'src', relative)))
        shared.add(relative)
      }
    }
    assert.deepEqual([...shared].sort(), ['app/common/parse-vv.mjs', 'app/common/vv-to-tab.mjs'])
    const parser = await import(pathToFileURL(path.join(installed, 'app/common/parse-vv.mjs')))
    const converter = await import(pathToFileURL(path.join(installed, 'app/common/vv-to-tab.mjs')))
    assert.equal(typeof parser.parseVv, 'function')
    assert.equal(typeof converter.vvToTab, 'function')
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true })
  }
})
