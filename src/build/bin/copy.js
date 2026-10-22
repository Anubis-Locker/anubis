/**
 * copy static assets into the built app
 *
 * `work/app/assets` is the web root the packaged app serves (src/app/lib/file-server.js),
 * and the file-manager icons are fetched from `icons/` (src/app/common/runtime-constants.js),
 * so this copy is what makes them exist at runtime.
 *
 * The destination is removed first on purpose: shelljs `cp -r` copies *into* an existing
 * directory, so a second `npm run compile` without a `npm run clean` would create
 * `assets/icons/icons` and then fail. Removing it also drops icons deleted upstream.
 */
const { resolve } = require('path')
const { cp, rm, mkdir, test } = require('shelljs')
const { resolveBrandResDir } = require('../../common/brand-res')

const from = resolve(
  __dirname,
  '../../../node_modules/@ai-security-tool/icons/icons'
)
const to = resolve(
  __dirname,
  '../../../work/app/assets/icons'
)

rm('-rf', to)
cp('-r', from, to)

// brand logos/icons used by the main process (window icon, AppImage integration);
// folder from BRAND_RES_DIR / ../resource / node_modules/@ai-security-tool/resource
const resDir = resolveBrandResDir(resolve(__dirname, '../../..'))
const imagesTo = resolve(__dirname, '../../../work/app/assets/images')
mkdir('-p', imagesTo)
const dirs = ['res/imgs', 'tray-icons']
dirs.forEach(d => {
  const src = resolve(resDir, d)
  if (test('-d', src)) {
    cp('-r', src + '/*', imagesTo)
  }
})
