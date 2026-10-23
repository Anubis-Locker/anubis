const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const pug = require('pug')
const stylus = require('stylus')

const root = path.resolve(__dirname, '../../client')
const read = file => fs.readFileSync(path.join(root, file), 'utf8')

function backgrounds () {
  const source = read('components/bg/css-overwrite.jsx')
  const context = {
    module: { exports: {} },
    noTerminalBgValue: 'none',
    textTerminalBgValue: 'text'
  }
  vm.runInNewContext(
    source.slice(source.indexOf('const themeDomId'), source.indexOf('export default')) +
    '\nmodule.exports = { createGlobalStyle, createStyleForTab }',
    context
  )
  return context.module.exports
}

test('default background stays local and does not dim the terminal or override user filters', async () => {
  const { createGlobalStyle } = backgrounds()
  const css = await createGlobalStyle({})
  assert.match(css, /background-image: url\("\.\/images\/electerm-watermark\.png"\)/)
  assert.match(css, /background-size: min\(100%, 766px\) auto/)
  assert.doesNotMatch(css, /filter:|opacity:|https?:/)
})

test('custom background, cover mode, per-tab filters and opt-out retain their behavior', async () => {
  const { createGlobalStyle, createStyleForTab } = backgrounds()
  const props = {
    terminalBackgroundImagePath: 'https://example.test/user.png',
    terminalBackgroundCoverMode: true,
    terminalBackgroundFilterBlur: 2,
    terminalBackgroundFilterOpacity: 0.6,
    terminalBackgroundFilterBrightness: 0.8,
    terminalBackgroundFilterContrast: 1.2,
    terminalBackgroundFilterGrayscale: 0.1
  }
  const global = await createGlobalStyle(props)
  assert.match(global, /url\(https:\/\/example.test\/user.png\)/)
  assert.match(global, /background-size: cover/)
  assert.match(global, /blur\(2px\) opacity\(0\.6\) brightness\(0\.8\) contrast\(1\.2\) grayscale\(0\.1\)/)
  const tab = await createStyleForTab({
    id: 'custom',
    terminalBackgroundFilterOpacity: 0.4
  }, props)
  assert.match(tab, /session-custom/)
  assert.match(tab, /opacity\(0\.4\)/)
  assert.match(tab, /background-size: cover/)
  const disabled = await createStyleForTab({
    id: 'disabled',
    terminalBackground: { terminalBackgroundImagePath: 'none' }
  }, props)
  assert.match(disabled, /background-image: none/)
  assert.doesNotMatch(disabled, /electerm-watermark|filter:/)
})

test('loading artwork stays local and static; shared logo styles preserve source contrast', () => {
  const html = pug.renderFile(path.join(root, 'views/index.pug'), {
    siteName: 'Anubis-Security-Tool',
    isDev: false,
    version: 'test',
    preloadChunks: [],
    _global: {}
  })
  assert.match(html, /src="images\/electerm.png"/)
  assert.doesNotMatch(html, /loader-api\.com|linear-gradient|animation: morph/)
  const css = stylus.render([
    read('components/sidebar/info.styl'),
    read('components/sidebar/sidebar.styl'),
    read('components/sidebar/menu-preview.styl')
  ].join('\n'))
  assert.match(css, /\.logo-filter\s*\{\s*filter: none;/)
  assert.match(css, /\.morph-shape\s*\{\s*background: #111;/)
  assert.match(css, /> svg:first-child\s*\{\s*color: inherit;/)
  assert.match(css, /\.sidebar \.menu-logo\s*\{[^}]*background: transparent;/)
})

test('menu uses the shared local app asset without changing menu actions', () => {
  const source = read('components/sys-menu/menu-btn.jsx')
  assert.match(source, /import \{ logoPath1 \} from '\.\.\/\.\.\/common\/constants'/)
  assert.match(source, /<img src=\{logoPath1\} width=\{24\} height=\{24\} alt=''/)
  assert.match(source, /content: this\.renderMenu\(\)/)
  assert.match(read('common/constants.js'), /logoPath1Ref from '@brand-res\/res\/imgs\/electerm-round-128x128\.png'/)
})
