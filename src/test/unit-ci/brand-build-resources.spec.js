const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { spawnSync } = require('node:child_process')

const script = path.resolve(__dirname, '../../build/bin/prepare-electron-build.js')
const template = path.resolve(__dirname, '../../build/electron-builder.json')

describe('packaging brand resources', () => {
  for (const complete of [false, true]) {
    it(complete ? 'resolves every platform asset from the explicit resource package' : 'fails before packaging if an installer asset is missing', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anubis-build-res-'))
      try {
        const source = fs.readFileSync(template, 'utf8')
        fs.mkdirSync(path.join(dir, 'src/build'), { recursive: true })
        fs.writeFileSync(path.join(dir, 'src/build/electron-builder.json'), source)
        const resources = path.join(dir, 'resource-package')
        fs.mkdirSync(path.join(resources, 'res/imgs'), { recursive: true })
        fs.mkdirSync(path.join(resources, 'build-res'), { recursive: true })
        if (complete) {
          for (const match of source.matchAll(/"@brand-res\/([^"]+)"/g)) {
            const file = path.join(resources, match[1])
            fs.mkdirSync(path.dirname(file), { recursive: true })
            if (!fs.existsSync(file)) fs.writeFileSync(file, 'asset fixture')
          }
        }
        const result = spawnSync(process.execPath, [script], {
          cwd: dir,
          env: { ...process.env, BRAND_RES_DIR: resources },
          encoding: 'utf8',
          timeout: 15000
        })
        if (complete) {
          assert.equal(result.status, 0, result.stderr)
          const prepared = fs.readFileSync(path.join(dir, 'electron-builder.json'), 'utf8')
          assert.ok(!prepared.includes('@brand-res'))
          assert.match(prepared, /resource-package\/res\/icons\/win\/icon.ico/)
        } else {
          assert.notEqual(result.status, 0)
          assert.match(result.stderr, /Brand package is missing res\/icons\/win\/icon.ico/)
        }
      } finally {
        fs.rmSync(dir, { recursive: true, force: true })
      }
    })
  }
})
