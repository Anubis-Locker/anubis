const fs = require('fs')
const path = require('path')

function stageBrowserAssets ({
  destination,
  source = path.join(path.dirname(require.resolve('@ai-security-tool/anubis-browser-assets/package.json')), 'assets'),
  version = require('@ai-security-tool/anubis-browser-assets/package.json').version
}) {
  for (const entry of [
    `js/basic-${version}.js`,
    `js/electerm-${version}.js`,
    `js/worker-${version}.js`,
    `css/style-${version}.css`
  ]) {
    const file = path.join(source, entry)
    if (!fs.statSync(file).isFile() || fs.statSync(file).size === 0) {
      throw new Error(`Missing managed browser asset: ${entry}`)
    }
  }
  if (path.resolve(source) === path.resolve(destination)) {
    throw new Error('Managed browser staging must not overwrite its source')
  }
  fs.rmSync(destination, { recursive: true, force: true })
  fs.cpSync(source, destination, { recursive: true })
  fs.writeFileSync(path.join(destination, 'manifest.json'), JSON.stringify({ version }))
  return destination
}

module.exports = { stageBrowserAssets }
