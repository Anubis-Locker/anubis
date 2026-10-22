/**
 * Resolve the brand resource package (logos / icons) folder.
 *
 * Order (first existing wins):
 *  1. env BRAND_RES_DIR (absolute, or relative to the repo root)
 *  2. ../resource relative to the repo root (monorepo layout)
 *  3. node_modules/@ai-security-tool/resource
 * When none exists the default (2) is returned so errors point to a sane path.
 * Used by vite config, electron-builder preparation, build scripts and dev runtime.
 * Keep in sync with web/src/app/common/brand-res.js.
 */

const { resolve, join } = require('path')
const { existsSync } = require('fs')

const PKG = ['node_modules', '@ai-security-tool', 'resource']

function resolveBrandResDir (root, env = process.env) {
  const candidates = []
  if (env.BRAND_RES_DIR) {
    candidates.push(resolve(root, env.BRAND_RES_DIR))
  }
  const sibling = resolve(root, '../resource')
  candidates.push(sibling, join(root, ...PKG))
  const found = candidates.find(d => existsSync(join(d, 'res', 'imgs')))
  return found || candidates[0]
}

module.exports = { resolveBrandResDir }
