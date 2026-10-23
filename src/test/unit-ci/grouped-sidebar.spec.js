const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { parse } = require('@babel/parser')

const root = path.resolve(__dirname, '../../client')
const sidebar = 'components/sidebar/'
const settings = 'components/setting-panel/setting-left-sidebar-icons.jsx'
const settingMap = { setting: 'setting', widgets: 'widgets' }
const modals = { setting: 'setting' }
const site = 'https://anubis.locker'

async function harness (file, store = {}, extra = {}) {
  const { transformSync } = await import('rolldown/experimental')
  const defs = await import('../../client/common/left-sidebar-icon-defs.js')
  const source = fs.readFileSync(path.join(root, file), 'utf8')
  let code = transformSync(file, source, { jsx: { runtime: 'automatic' } }).code
  const ast = parse(code, { sourceType: 'module' })
  const edits = ast.program.body.flatMap(node => {
    if (node.type === 'ImportDeclaration') {
      return [{
        start: node.start,
        end: node.end,
        text: node.specifiers.map(spec => {
          const key = spec.type === 'ImportDefaultSpecifier' ? 'default' : spec.imported.name
          return `const ${spec.local.name} = require(${JSON.stringify(node.source.value)})[${JSON.stringify(key)}];`
        }).join('\n')
      }]
    }
    if (node.type === 'ExportDefaultDeclaration') {
      return [{ start: node.start, end: node.declaration.start, text: 'module.exports = ' }]
    }
    return []
  })
  for (const edit of edits.reverse()) {
    code = code.slice(0, edit.start) + edit.text + code.slice(edit.end)
  }
  let state
  let cleanup
  const effects = []
  const window = { store, translate: key => key, et: {} }
  const Select = Object.assign(() => null, { displayName: 'Select', Option: 'Option' })
  const dependencies = {
    react: {
      memo: value => value,
      useState: initial => {
        if (state === undefined) state = initial
        return [state, value => { state = value }]
      },
      useEffect: effect => { cleanup = effect() }
    },
    'react/jsx-runtime': require('react/jsx-runtime'),
    'manate/react': { auto: value => value },
    antd: { Modal: 'Modal', Tooltip: 'Tooltip', Popover: 'Popover', Badge: 'Badge', Select },
    'lucide-react': new Proxy({}, { get: (_, key) => key }),
    '../icons/ui-icons': new Proxy({}, { get: (_, key) => key }),
    '../../common/constants': { brand: { domains: { site } }, modals, settingMap },
    '../../common/ai-feature': { isAIDisabled: () => !!window.et.disableAIFeature },
    '../../common/left-sidebar-icon-defs': defs,
    '../../common/has-active-input': { default: () => false },
    '../sys-menu/menu-btn': { default: 'MenuBtn' },
    '../common/external-link': { default: 'ExternalLink' },
    '../tabs/quick-connect': { default: 'QuickConnect' },
    './menu-preview': { default: 'GroupedSidebarMenu' },
    './transfer-list': { default: 'TransferList' },
    './side-icon': { default: 'SideIcon' },
    './sidebar-panel': { default: 'SideBarPanel' },
    './side-panel': { default: 'SidePanel' },
    './transfer-modal': { default: 'TransferModal' },
    classnames: { default: (...values) => values.filter(value => typeof value === 'string').join(' ') },
    ...extra
  }
  const context = {
    module: { exports: {} },
    window,
    document: {
      addEventListener: (name, listener) => effects.push(listener),
      removeEventListener: (name, listener) => effects.splice(effects.indexOf(listener), 1)
    },
    require: name => {
      assert.ok(name in dependencies, `Unexpected dependency ${name}`)
      return dependencies[name]
    }
  }
  vm.runInNewContext(code, context, { filename: file })
  return {
    render: props => context.module.exports(props || {}),
    window,
    effects,
    cleanup: () => cleanup()
  }
}

function nodes (tree, predicate = () => true) {
  if (Array.isArray(tree)) return tree.flatMap(child => nodes(child, predicate))
  if (!tree || typeof tree !== 'object' || !tree.props) return []
  return [
    ...(predicate(tree) ? [tree] : []),
    ...nodes(tree.props.children, predicate)
  ]
}

const type = name => node => node.type === name || node.type?.displayName === name
const button = (tree, label) => nodes(tree, node => node.type === 'button' && node.props['aria-label'] === label)[0]
const labels = tree => nodes(tree, type('details')).map(group => ({
  label: nodes(group, type('summary'))[0].props.title,
  items: nodes(group, type('button')).map(item => item.props['aria-label'])
}))

function makeStore () {
  const calls = []
  const store = {
    config: {},
    settingItem: { id: '' },
    upgradeInfo: {},
    ...Object.fromEntries([
      'openSettingSync', 'toggleAIPanel', 'openWidgetsModal', 'openSetting',
      'openAbout', 'toggleLeftSideBar', 'onZoomReset', 'openLeftSidePanel',
      'setOpenedSideBar'
    ].map(name => [name, (...args) => calls.push([name, ...args])]))
  }
  return { store, calls }
}

test('approved default groups are exact, with no extra legacy or preview entries', async () => {
  const { store } = makeStore()
  const h = await harness(sidebar + 'menu-preview.jsx', store)
  const expected = [
    { label: 'Tools', items: ['Bookmarks', 'Quick connect', 'Setting sync', 'AI Agents', 'Widgets'] },
    { label: 'PRO Features', items: ['Community', 'Plugin Store', 'Automation', 'DLL Scanner', 'CVE Scanner', 'Crypto Miner', 'Browser Control'] },
    { label: 'Other', items: ['Setting', 'About', 'Hide'] }
  ]
  assert.deepEqual(labels(h.render()), expected)
  const defaults = fs.readFileSync(path.join(root, 'common/default-setting.js'), 'utf8')
  store.config.leftSideBarIcons = vm.runInNewContext(defaults.match(/leftSideBarIcons:\s*(\[[\s\S]*?\])/)[1])
  assert.deepEqual(labels(h.render()), expected)
  assert.doesNotMatch(fs.readFileSync(path.join(root, sidebar + 'menu-preview.jsx'), 'utf8'), /Local preview|Menu preview/)
})

test('live custom ordering and empty selection work without mutating saved config', async () => {
  const { store } = makeStore()
  const h = await harness(sidebar + 'menu-preview.jsx', store)
  const ids = ['widgets', 'setting', 'settingSync', 'bookmarks', 'widgets', 'terminalThemes', 'unknown']
  store.config.leftSideBarIcons = ids
  assert.deepEqual(labels(h.render())[0].items, ['Widgets', 'Setting sync', 'Bookmarks', 'AI Agents'])
  assert.deepEqual(labels(h.render())[2].items, ['Setting', 'About', 'Hide'])
  assert.equal(store.config.leftSideBarIcons, ids)
  store.config.leftSideBarIcons = []
  assert.deepEqual(labels(h.render())[0].items, ['AI Agents'])
  assert.deepEqual(labels(h.render())[2].items, ['About', 'Hide'])
})

test('ordinary entries call real handlers; Quick connect uses the actual input popover', async () => {
  const { store, calls } = makeStore()
  const h = await harness(sidebar + 'menu-preview.jsx', store)
  const tree = h.render({ handleClickBookmark: () => calls.push(['bookmark']) })
  for (const label of ['Bookmarks', 'Setting sync', 'AI Agents', 'Widgets', 'Setting', 'About', 'Hide']) {
    button(tree, label).props.onClick()
  }
  assert.deepEqual(calls.map(call => call[0]), [
    'bookmark', 'openSettingSync', 'toggleAIPanel', 'openWidgetsModal', 'openSetting', 'openAbout', 'toggleLeftSideBar'
  ])
  const quick = nodes(tree, type('Popover'))[0]
  assert.equal(quick.props.trigger, 'click')
  assert.equal(quick.props.content.type, 'QuickConnect')
  assert.equal(quick.props.content.props.inputOnly, true)
  assert.equal(button(tree, 'Bookmarks').props.className.includes('bookmark-sidebar-toggle'), true)
  h.window.et.disableAIFeature = true
  assert.equal(button(h.render(), 'AI Agents').props.disabled, true)
})

test('only seven PRO entries open explanatory dialogs with the official link', async () => {
  const { store, calls } = makeStore()
  const h = await harness(sidebar + 'menu-preview.jsx', store)
  for (const label of labels(h.render())[1].items) {
    button(h.render(), label).props.onClick()
    const modal = nodes(h.render(), type('Modal'))[0]
    assert.equal(modal.props.open, true)
    assert.equal(modal.props.title, label)
    assert.equal(nodes(modal, type('ExternalLink'))[0].props.to, site)
    modal.props.onCancel()
    assert.equal(nodes(h.render(), type('Modal'))[0].props.open, false)
  }
  assert.equal(calls.length, 0)
})

test('active states reflect the real settings, bookmark and AI panel state', async () => {
  const { store } = makeStore()
  const h = await harness(sidebar + 'menu-preview.jsx', store)
  for (const [label, state] of [
    ['Bookmarks', { openedSideBar: 'bookmarks' }],
    ['Setting sync', { showModal: modals.setting, settingTab: settingMap.setting, settingItem: { id: 'setting-sync' } }],
    ['Widgets', { showModal: modals.setting, settingTab: settingMap.widgets }],
    ['Setting', { showModal: modals.setting, settingTab: settingMap.setting, settingItem: { id: 'setting-common' } }],
    ['AI Agents', { rightPanelVisible: true, rightPanelTab: 'ai' }],
    ['About', { showInfoModal: true }]
  ]) {
    Object.assign(store, state)
    assert.equal(button(h.render(), label).props['aria-current'], 'page')
  }
})

test('settings expose only effective controls and preserve older selections on edit', async () => {
  const updates = []
  const config = { leftSideBarIcons: ['terminalThemes', 'widgets', 'newBookmark', 'unknown'] }
  const h = await harness(settings)
  const props = { config, store: { updateConfig: value => updates.push(value) } }
  let select = nodes(h.render(props), type('Select'))[0]
  assert.deepEqual(Array.from(select.props.value), ['widgets'])
  assert.deepEqual(nodes(select, type('Option')).map(option => option.props.value),
    ['bookmarks', 'quickConnect', 'settingSync', 'widgets', 'setting'])
  select.props.onChange([])
  assert.deepEqual(Array.from(updates[0].leftSideBarIcons), ['terminalThemes', 'newBookmark', 'unknown'])
  config.leftSideBarIcons = []
  select = nodes(h.render(props), type('Select'))[0]
  assert.equal(select.props.value.length, 0)
})

const sidebarProps = () => ({
  height: 720,
  leftSidePanelWidth: 300,
  leftSideBarWidth: 248,
  upgradeInfo: { shouldUpgrade: true, upgradePercent: 42 },
  fileTransfers: [{ id: 'transfer' }],
  transferHistory: [{ id: 'history' }],
  transferTab: 'history',
  zoom: 1.25
})

test('footer passes real transfer state and restores zoom reset and update progress handlers', async () => {
  const { store, calls } = makeStore()
  const h = await harness(sidebar + 'index.jsx', store)
  const props = sidebarProps()
  const tree = h.render(props)
  const menu = nodes(tree, type('GroupedSidebarMenu'))[0]
  const transfers = nodes(menu, type('TransferList'))[0]
  for (const key of ['fileTransfers', 'transferHistory', 'transferTab']) {
    assert.equal(transfers.props[key], props[key])
  }
  const reset = nodes(menu, node => node.type === 'SideIcon' && node.props.title === 'resetzoom')[0]
  reset.props.onClick()
  assert.deepEqual(calls, [['onZoomReset']])
  const progress = nodes(menu, type('Tooltip'))[0]
  assert.equal(progress.props.title, 'upgrading 42%')
  nodes(progress, type('SideIcon'))[0].props.onClick()
  assert.equal(store.upgradeInfo.showUpgradeModal, true)
  props.zoom = 1
  props.upgradeInfo.checkingRemoteVersion = true
  assert.equal(nodes(h.render(props), type('SideIcon')).length, 0)
  props.zoom = undefined
  props.upgradeInfo = { shouldUpgrade: false }
  assert.equal(nodes(h.render(props), type('SideIcon')).length, 0)
  props.upgradeInfo = { shouldUpgrade: true, showUpgradeModal: true }
  assert.equal(nodes(h.render(props), type('SideIcon')).length, 0)
})

test('existing transfer popover opens/closes with history-only data and retains error counts', async () => {
  const h = await harness(sidebar + 'transfer-list.jsx')
  const props = { fileTransfers: [], transferHistory: [], transferTab: 'history' }
  assert.equal(h.render(props), null)
  props.transferHistory = [{ id: 'past' }]
  let popover = h.render(props)
  assert.equal(popover.props.open, false)
  popover.props.onOpenChange(true)
  popover = h.render(props)
  assert.equal(popover.props.open, true)
  assert.equal(popover.props.content.props.transferHistory, props.transferHistory)
  assert.equal(popover.props.content.props.transferTab, 'history')
  popover.props.content.props.onClose()
  assert.equal(h.render(props).props.open, false)
  props.fileTransfers = [{ id: 'failed', error: true }]
  const badge = nodes(h.render(props), type('Badge'))[0]
  assert.equal(badge.props.count, 1)
  assert.equal(badge.props.color, 'red')
})

test('bookmark toggle, mobile pin policy, click-outside and cleanup remain wired', async () => {
  const { store, calls } = makeStore()
  store.openedSideBar = 'bookmarks'
  store.pinned = true
  store.isMobile = false
  const h = await harness(sidebar + 'index.jsx', store)
  const props = { ...sidebarProps(), pinned: true, isMobile: true, showModal: 'setting' }
  const tree = h.render(props)
  assert.equal(nodes(tree, type('SideBarPanel'))[0].props.pinned, false)
  nodes(tree, type('GroupedSidebarMenu'))[0].props.handleClickBookmark()
  assert.equal(store.showModal, 0)
  assert.deepEqual(calls, [['openLeftSidePanel']])
  const listener = h.effects[0]
  const outside = { target: { closest: () => false } }
  listener(outside)
  assert.equal(calls.length, 1)
  store.isMobile = true
  listener({ target: { closest: selector => selector === '.bookmark-sidebar-toggle' } })
  assert.equal(calls.length, 1)
  listener(outside)
  assert.deepEqual(calls[1], ['setOpenedSideBar', ''])
  h.cleanup()
  assert.equal(h.effects.length, 0)
})

test('approved desktop width and mobile/collapsed panel geometry share the store measurement', async () => {
  const source = fs.readFileSync(path.join(root, 'store/store.js'), 'utf8')
  const ast = parse(source, { sourceType: 'module' })
  const cls = ast.program.body.find(node => node.type === 'ClassDeclaration')
  const getter = cls.body.body.find(node => node.kind === 'get' && node.key.name === 'leftSideBarWidth')
  const store = { _leftSideBarOpen: true, isMobile: false }
  const width = vm.runInNewContext(`(function () ${source.slice(getter.body.start, getter.body.end)})`, {
    window: { store },
    sidebarWidth: 43
  })
  for (const innerWidth of [800, 1099, 1100, 1920]) {
    store.innerWidth = innerWidth
    assert.equal(width(), 248)
  }
  store.isMobile = true
  assert.equal(width(), 43)
  store._leftSideBarOpen = false
  assert.equal(width(), 0)
  const h = await harness(sidebar + 'index.jsx', { ...makeStore().store, ...store })
  const props = { ...sidebarProps(), leftSideBarWidth: 0, isMobile: true }
  let tree = h.render(props)
  assert.match(tree.props.className, /collapsed/)
  const panel = nodes(tree, type('SidePanel'))[0]
  assert.equal(panel.props.leftSideBarWidth, 0)
  assert.equal(panel.props.leftSidePanelWidth, 300)
  props.leftSideBarWidth = 248
  props.isMobile = false
  props.pinned = true
  tree = h.render(props)
  assert.match(tree.props.className, /sidebar-expanded/)
  assert.equal(nodes(tree, type('SideBarPanel'))[0].props.pinned, true)
})

test('sidebar Stylus compiles with compact/collapsed footer and bounded scrolling', () => {
  const stylus = require('stylus')
  const source = fs.readFileSync(path.join(root, sidebar + 'menu-preview.styl'), 'utf8')
  const css = stylus.render(source)
  assert.match(css, /\.preview-compact .preview-footer/)
  assert.match(css, /\.collapsed .preview-footer/)
  assert.match(css, /max-height: 40%/)
  assert.match(css, /\.preview-menu-item:focus-visible/)
})
