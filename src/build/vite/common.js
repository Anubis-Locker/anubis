import { config as conf } from 'dotenv'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { createRequire } from 'module'

conf()

export const cwd = process.cwd()
export const env = process.env
export const isProd = env.NODE_ENV === 'production'
const packPath = resolve(cwd, '../../../package.json')
export const pack = JSON.parse(readFileSync(packPath).toString())
export const version = pack.version
export const viewPath = resolve(cwd, '../../../src/client/views')
// brand resource package (logos/icons): env BRAND_RES_DIR, ../resource or
// node_modules/@ai-security-tool/resource (see src/common/brand-res.js).
// client code imports it through the `@brand-res` alias (see conf.js)
const require = createRequire(import.meta.url)
const { resolveBrandResDir } = require('../../common/brand-res.js')
export const resourceDir = resolveBrandResDir(resolve(cwd, '../../..'))
export const staticPaths = [
  {
    dir: resolve(cwd, '../../../node_modules/@ai-security-tool/icons/icons'),
    path: '/icons'
  },
  {
    dir: resolve(resourceDir, 'tray-icons'),
    path: '/images'
  },
  {
    dir: resolve(resourceDir, 'res/imgs'),
    path: '/images'
  },
  {
    dir: resolve(cwd, '../../../src/client/entry'),
    path: '/'
  }
]
