const { test, after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const { once } = require('node:events')
const vm = require('node:vm')

process.env.NODE_ENV = 'development'
const runtime = require('../../app/common/runtime-constants')
const brand = require('../../app/common/brand')
const globalState = require('../../app/server/global-state')
const { fsExport } = require('../../app/lib/fs')
const root = fs.mkdtempSync(path.resolve(__dirname, '../../../.upgrade-regression-'))
const previousTempDir = runtime.tempDir
const previousBaseUrls = brand.update.baseUrls
const originalOpenFile = fsExport.openFile
runtime.tempDir = root
let launch = async () => {}
fsExport.openFile = file => launch(file)
const { Upgrade } = require('../../app/server/download-upgrade')
fsExport.openFile = originalOpenFile
const suffix = require('../../app/lib/install-src')
const name = `anubis-test-${suffix}`
const body = Buffer.alloc(256 * 1024, 42)

after(() => {
  runtime.tempDir = previousTempDir
  brand.update.baseUrls = previousBaseUrls
  fs.rmSync(root, { recursive: true, force: true })
})

async function fixture (t, { metadata, download, open } = {}) {
  const events = []
  const launches = []
  const messages = []
  const originalSend = process.send
  process.send = message => messages.push({ message, events: events.length })
  t.after(() => { process.send = originalSend })
  const server = http.createServer((req, res) => {
    if (req.url.startsWith(brand.update.releaseJson)) {
      if (metadata) {
        metadata(req, res, baseUrl)
      } else {
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({
          release: {
            assets: [{ name, size: body.length, browser_download_url: baseUrl + '/asset' }]
          }
        }))
      }
    } else if (download) {
      download(req, res, upgrade)
    } else {
      res.end(body)
    }
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const baseUrl = `http://127.0.0.1:${server.address().port}`
  brand.update.baseUrls = [baseUrl]
  launch = async file => {
    launches.push(file)
    assert.deepEqual(await fs.promises.readFile(file), body)
    assert.equal(upgrade.writeSteam.closed, true)
    if (open) {
      await open(file)
    }
  }
  const ws = {
    closes: 0,
    s (event) {
      events.push(event)
    },
    close () {
      this.closes++
      upgrade.destroy()
    }
  }
  const upgrade = new Upgrade({ id: 'test-download', ws })
  globalState.setUpgradeInst(upgrade.id, upgrade)
  t.after(async () => {
    upgrade.destroy()
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    if (upgrade.dir) {
      await fs.promises.rm(upgrade.dir, { recursive: true, force: true })
    }
  })
  return { upgrade, events, launches, messages, ws, server }
}

function assertFailure ({ upgrade, events, launches, messages }) {
  assert.equal(launches.length, 0)
  const errors = events.filter(e => e.id === 'upgrade:err:test-download')
  assert.equal(errors.length, 1)
  assert.equal(typeof errors[0].error.message, 'string')
  assert.equal(events.some(e => e.id === 'upgrade:end:test-download'), false)
  assert.equal(messages.some(e => e.message.upgradeInstallerLaunched), false)
  assert.equal(globalState.getUpgradeInst(upgrade.id), undefined)
  if (upgrade.dir) {
    assert.equal(fs.existsSync(upgrade.dir), false)
  }
}

test('streams to a unique directory, verifies bytes, then launches and emits upgrade:end', async t => {
  const f = await fixture(t)
  const unrelated = path.join(root, name)
  fs.writeFileSync(unrelated, 'keep')
  await f.upgrade.init()
  assert.equal(f.launches.length, 1)
  assert.equal(path.dirname(f.upgrade.localPath), f.upgrade.dir)
  assert.notEqual(f.upgrade.localPath, unrelated)
  assert.equal(fs.readFileSync(unrelated, 'utf8'), 'keep')
  assert.deepEqual(f.events.at(-1), {
    id: 'upgrade:end:test-download',
    data: f.upgrade.dir
  })
  assert.ok(f.events.some(e => e.id === 'upgrade:data:test-download'))
  assert.ok(f.events.filter(e => e.id.includes(':data:')).every(e => e.data < 100))
  assert.equal(globalState.getUpgradeInst(f.upgrade.id), undefined)
  const closeMessages = f.messages.filter(e => e.message.upgradeInstallerLaunched)
  const closesForInstaller = runtime.isWin && suffix.endsWith('-installer.exe')
  assert.equal(closeMessages.length, closesForInstaller ? 1 : 0)
  if (closesForInstaller) {
    assert.equal(closeMessages[0].events, f.events.length, 'close request follows successful completion notification')
  }
  const count = f.events.length
  await new Promise(resolve => setTimeout(resolve, 1100))
  assert.equal(f.events.length, count, 'no trailing throttled progress after completion')
})

test('metadata HTTP failure preserves error id and context', async t => {
  const f = await fixture(t, { metadata: (req, res) => { res.writeHead(503).end() } })
  await f.upgrade.init()
  assertFailure(f)
})

test('missing compatible release asset reports an error', async t => {
  const f = await fixture(t, {
    metadata: (req, res) => res.end(JSON.stringify({ release: { assets: [] } }))
  })
  await f.upgrade.init()
  assertFailure(f)
  assert.match(f.events[0].error.message, /No compatible/)
})

test('renderer uses the same exact suffix match and explicitly rejects a missing asset', async t => {
  let assets = [
    { name: name + '.sha256', browser_download_url: 'wrong-checksum-url' },
    { name, browser_download_url: 'correct-installer-url' }
  ]
  await fixture(t, {
    metadata: (req, res) => res.end(JSON.stringify({
      release: { assets, body: 'Release notes', published_at: '2026-10-22' }
    }))
  })
  const source = fs.readFileSync(path.resolve(__dirname, '../../client/common/update-check.js'), 'utf8')
    .replace(/^import fetch .*\r?\n/m, '')
    .replace(/import \{[\s\S]*?\} from '.\/constants'\r?\n/, '')
    .replace(/^import dayjs .*\r?\n/m, '')
    .replace(/export (async )?function/g, '$1function')
  const getLatestReleaseInfo = vm.runInNewContext(source + '\ngetLatestReleaseInfo', {
    window: { store: { installSrc: suffix, getProxySetting: () => null } },
    brand,
    baseUpdateCheckUrls: brand.update.baseUrls,
    fetch: data => require('axios')(data.options).then(res => res.data),
    dayjs: () => ({ format: () => '2026-10-22' })
  })
  const info = await getLatestReleaseInfo()
  assert.equal(info.browserDownloadUrl, 'correct-installer-url')
  assets = assets.slice(0, 1)
  await assert.rejects(getLatestReleaseInfo(), /No compatible update asset found/)
})

for (const assetName of [`../${name}`, `..\\${name}`, `C:${name}`]) {
  test(`rejects unsafe asset basename ${assetName}`, async t => {
    const f = await fixture(t, {
      metadata: (req, res, base) => res.end(JSON.stringify({
        release: { assets: [{ name: assetName, size: body.length, browser_download_url: base + '/asset' }] }
      }))
    })
    await f.upgrade.init()
    assertFailure(f)
    assert.equal(f.upgrade.dir, undefined)
  })
}

for (const size of [0, -1, '123', 1.5]) {
  test(`rejects invalid declared size ${JSON.stringify(size)}`, async t => {
    const f = await fixture(t, {
      metadata: (req, res, base) => res.end(JSON.stringify({
        release: { assets: [{ name, size, browser_download_url: base + '/asset' }] }
      }))
    })
    await f.upgrade.init()
    assertFailure(f)
  })
}

test('asset HTTP errors never launch the installer', async t => {
  const f = await fixture(t, { download: (req, res) => res.writeHead(404).end() })
  await f.upgrade.init()
  assertFailure(f)
})

test('aborted HTTP body never treats stream close as completion', async t => {
  const f = await fixture(t, {
    download: (req, res) => {
      res.writeHead(200, { 'Content-Length': body.length })
      res.write(body.subarray(0, 1024))
      setTimeout(() => res.destroy(), 20)
    }
  })
  await f.upgrade.init()
  assertFailure(f)
})

for (const length of [1024, body.length + 1]) {
  test(`rejects a normally ended body with mismatching length ${length}`, async t => {
    const f = await fixture(t, { download: (req, res) => res.end(Buffer.alloc(length)) })
    await f.upgrade.init()
    assertFailure(f)
  })
}

test('real destination write error is handled and partial directory removed', async t => {
  const f = await fixture(t, {
    download: (req, res, upgrade) => {
      fs.mkdirSync(upgrade.localPath)
      res.end(body)
    }
  })
  await f.upgrade.init()
  assertFailure(f)
})

test('installer launch rejection is reported rather than completing', async t => {
  const f = await fixture(t, { open: async () => { throw new Error('launch rejected') } })
  await f.upgrade.init()
  assert.equal(f.launches.length, 1)
  assert.match(f.events.at(-1).error.message, /launch rejected/)
  assert.equal(f.events.some(e => e.id.includes(':end:')), false)
  assert.equal(f.messages.some(e => e.message.upgradeInstallerLaunched), false)
  assert.equal(fs.existsSync(f.upgrade.dir), false)
})

test('cancellation while launching does not request application shutdown', async t => {
  const f = await fixture(t, { open: async () => f.upgrade.destroy() })
  await f.upgrade.init()
  assert.equal(f.launches.length, 1)
  assert.equal(f.messages.some(e => e.message.upgradeInstallerLaunched), false)
  assert.equal(f.events.some(e => e.id.includes(':end:')), false)
})

test('successful Windows NSIS launch alone requests shutdown, after notifying the renderer', async () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../../app/server/download-upgrade.js'), 'utf8')
  const method = source.slice(source.indexOf('  async onEnd () {'), source.indexOf('  onError (err) {'))
    .replace('async onEnd ()', 'async function ()')
  for (const [isWin, installSrc, shouldClose] of [
    [true, 'win-x64-installer.exe', true],
    [true, 'win-x64.tar.gz', false],
    [true, 'win-x64-portable.exe', false],
    [false, 'mac-x64.dmg', false]
  ]) {
    const events = []
    const onEnd = vm.runInNewContext(`(${method})`, {
      isWin,
      installSrc,
      openFile: async file => { events.push('launch') },
      launchWindowsInstaller: async file => { events.push('launch') },
      process: { send: message => events.push(message.upgradeInstallerLaunched ? 'close' : 'show-file') }
    })
    const upgrade = {
      localPath: 'downloaded-installer',
      dir: 'download-directory',
      id: 'handoff',
      ws: { s: () => events.push('end') }
    }
    await onEnd.call(upgrade)
    assert.equal(upgrade.launched, true)
    assert.deepEqual(events, ['launch', 'show-file', 'end', ...(shouldClose ? ['close'] : [])])
  }
})

test('cancels during metadata request and destroy is idempotent', async t => {
  let requested
  const request = new Promise(resolve => { requested = resolve })
  const f = await fixture(t, { metadata: () => requested() })
  const done = f.upgrade.init()
  await request
  f.upgrade.destroy()
  f.upgrade.destroy()
  await done
  assert.deepEqual(f.events, [])
  assert.equal(f.launches.length, 0)
  assert.equal(f.ws.closes, 1)
  assert.equal(globalState.getUpgradeInst(f.upgrade.id), undefined)
})

test('pause/resume before initialization preserves bytes and completion', async t => {
  const f = await fixture(t)
  f.upgrade.pause()
  const done = f.upgrade.init()
  while (!f.upgrade.continueDownload) {
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  assert.equal(f.launches.length, 0)
  f.upgrade.resume()
  await done
  assert.equal(f.launches.length, 1)
  assert.equal(f.events.at(-1).id, 'upgrade:end:test-download')
})

test('cancellation while paused aborts the pipeline and removes partial files', async t => {
  const f = await fixture(t)
  f.upgrade.pause()
  const done = f.upgrade.init()
  while (!f.upgrade.continueDownload) {
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  f.upgrade.destroy()
  await done
  assert.equal(f.launches.length, 0)
  assert.equal(f.events.some(e => /:(end|err):/.test(e.id)), false)
  assert.equal(fs.existsSync(f.upgrade.dir), false)
})

function clientFixture (onSend = () => {}) {
  const listeners = new Set()
  const sent = []
  const ws = {
    closes: 0,
    s (data) { sent.push(data); onSend(data, ws) },
    addEventListener (type, callback) { listeners.add(callback) },
    removeEventListener (type, callback) { listeners.delete(callback) },
    close () { this.closes++; this.onclose() },
    emit (event) {
      for (const listener of listeners) {
        listener({ data: JSON.stringify(event) })
      }
    }
  }
  const module = { exports: {} }
  const source = fs.readFileSync(path.resolve(__dirname, '../../client/common/upgrade.js'), 'utf8')
    .replace(/^import .*\r?\n/gm, '')
    .replace('export default async', 'module.exports = async')
  vm.runInNewContext(source, {
    module,
    window: { pre: { transferKeys: ['pause', 'resume', 'destroy'] } },
    generate: () => 'client-test',
    initWs: async () => ws
  })
  return { create: module.exports, ws, sent, listeners }
}

test('client installs listeners before starting, waits for end not 100%, and cleans up', async () => {
  const f = clientFixture((data, ws) => {
    if (data.action === 'upgrade-new') {
      ws.emit({ id: 'upgrade:data:client-test', data: 100 })
    }
  })
  const progress = []
  const ends = []
  const client = await f.create({
    onData: n => progress.push(n),
    onEnd: event => ends.push(event),
    onError: assert.fail
  })
  assert.deepEqual(progress, [100])
  assert.equal(f.ws.closes, 0)
  f.ws.emit({ id: 'upgrade:end:client-test', data: 'download-directory' })
  assert.equal(ends.length, 1)
  assert.equal(f.listeners.size, 0)
  assert.equal(f.ws.closes, 1)
  client.destroy()
  assert.equal(f.ws.closes, 1)
})

test('client handles server errors, unexpected disconnect and explicit cancellation once', async () => {
  for (const mode of ['error', 'disconnect', 'cancel']) {
    const f = clientFixture()
    const errors = []
    const client = await f.create({ onData: assert.fail, onEnd: assert.fail, onError: e => errors.push(e) })
    if (mode === 'error') {
      f.ws.emit({ id: 'upgrade:err:client-test', error: { message: 'download failed' } })
    } else if (mode === 'disconnect') {
      f.ws.onclose()
    } else {
      client.destroy()
    }
    assert.equal(errors.length, mode === 'cancel' ? 0 : 1)
    assert.equal(f.listeners.size, 0)
    assert.equal(f.ws.closes, 1)
  }
})

function componentFixture (upgrade = async () => ({ destroy () {} })) {
  const timers = new Set()
  const window = {
    translate: s => s,
    store: { upgradeInfo: {}, getProxySetting: () => null },
    et: {}
  }
  const source = fs.readFileSync(path.resolve(__dirname, '../../client/components/main/upgrade.jsx'), 'utf8')
  const start = source.indexOf('export default class Upgrade')
  const end = source.indexOf('  renderError =')
  const Component = vm.runInNewContext(
    source.slice(start, end).replace('export default ', '') + '\n}; Upgrade',
    {
      PureComponent: class {},
      downloadMirrorList: ['direct'],
      window,
      isMac: false,
      isWin: true,
      upgrade,
      debounce: fn => Object.assign(fn, { cancel () {} }),
      setTimeout: callback => { timers.add(callback); return callback },
      clearTimeout: callback => timers.delete(callback),
      clearInterval: () => {},
      downloadUpgradeTimeout: 1000
    }
  )
  const component = new Component()
  component.props = { installSrc: suffix }
  return { component, timers, window }
}

test('component keeps 100% alive until end, resets idle timer, and clears timers on error/end', async () => {
  let destroyed = 0
  const f = componentFixture(async () => ({ destroy () { destroyed++ } }))
  await f.component.doUpgrade()
  assert.equal(f.timers.size, 1)
  f.component.onData(100)
  assert.equal(destroyed, 0)
  assert.equal(f.window.store.upgradeInfo.upgradePercent, 100)
  assert.equal(f.timers.size, 1)
  f.component.onEnd()
  assert.equal(destroyed, 1)
  assert.equal(f.timers.size, 0)
  await f.component.doUpgrade()
  f.component.onError(new Error('failed'))
  assert.equal(f.window.store.upgradeInfo.error, 'failed')
  assert.equal(f.window.store.upgradeInfo.upgrading, false)
  assert.equal(f.timers.size, 0)
})

test('component cancels a pending websocket initialization and ignores stale callbacks', async () => {
  let ready
  let callbacks
  let destroyed = 0
  const f = componentFixture(options => {
    callbacks = options
    return new Promise(resolve => { ready = resolve })
  })
  const pending = f.component.doUpgrade()
  f.component.cancel()
  callbacks.onData(50)
  callbacks.onError(new Error('stale'))
  ready({ destroy () { destroyed++ } })
  await pending
  assert.equal(destroyed, 1)
  assert.equal(f.window.store.upgradeInfo.upgradePercent, 0)
  assert.equal(f.window.store.upgradeInfo.error, '')
  assert.equal(f.timers.size, 0)
})

test('component reports initialization failure and cancels timers on unmount', async () => {
  const f = componentFixture(async () => { throw new Error('connect failed') })
  await f.component.doUpgrade()
  assert.equal(f.window.store.upgradeInfo.error, 'connect failed')
  assert.equal(f.timers.size, 0)
  f.component.onData(1)
  f.component.componentWillUnmount()
  assert.equal(f.timers.size, 0)
})
