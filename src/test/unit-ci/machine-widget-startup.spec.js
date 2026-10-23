const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

function fixture (headless) {
  let resolveStart
  let rejectStart
  let starts = 0
  const pending = new Promise((resolve, reject) => {
    resolveStart = resolve
    rejectStart = reject
  })
  const widget = {
    widgetInfo: { type: 'instance', singleInstance: true, name: 'Test' },
    widgetRun: () => ({
      instanceId: 'test-instance',
      start () { starts++; return pending },
      async stop () {}
    })
  }
  const directory = path.resolve(__dirname, '../../app/widgets')
  const source = fs.readFileSync(path.join(directory, 'load-widget.js'), 'utf8')
  const output = { exports: {} }
  const dependencies = {
    fs,
    path,
    './instance-log': {
      createContext: () => ({ bind () {} }),
      loggerFor: () => ({ log () {} })
    },
    '../lib/glob-state': { get: key => key === 'headlessRuntime' && headless },
    [path.join(directory, 'widget-mcp-server.js')]: widget,
    [path.join(directory, 'widget-other.js')]: widget
  }
  vm.runInNewContext('(function (require, module) {\n' + source + '\n})', {
    __dirname: directory,
    process: { on () {} },
    console
  })(name => {
    assert.ok(Object.hasOwn(dependencies, name), 'Unexpected dependency: ' + name)
    return dependencies[name]
  }, output)
  return {
    run: output.exports.runWidget,
    starts: () => starts,
    resolve: resolveStart,
    reject: rejectStart
  }
}

test('concurrent headless MCP autoRun requests share the actual startup promise and instance', async () => {
  const value = fixture(true)
  const first = value.run('mcp-server', { autoRun: true })
  assert.equal(value.run('mcp-server', { autoRun: true }), first)
  assert.equal(value.starts(), 1)
  value.resolve({ msg: 'ready' })
  const result = await first
  assert.equal(result.instanceId, 'test-instance')
  assert.equal(await value.run('mcp-server', { autoRun: true }), result)
  assert.equal(value.starts(), 1)
})

test('headless MCP manual starts still reject duplicate instances', async () => {
  const value = fixture(true)
  const first = value.run('mcp-server', { autoRun: true })
  await assert.rejects(value.run('mcp-server', {}), /already has a running instance/)
  value.resolve({})
  await first
})

test('ordinary desktop autoRun and other singleton widgets retain duplicate protection', async () => {
  for (const [headless, id] of [[false, 'mcp-server'], [true, 'other']]) {
    const value = fixture(headless)
    const first = value.run(id, { autoRun: true })
    await assert.rejects(value.run(id, { autoRun: true }), /already has a running instance/)
    value.resolve({})
    await first
    assert.equal(value.starts(), 1)
  }
})

test('failed shared headless MCP startup remains an explicit failure and permits a later retry', async () => {
  const value = fixture(true)
  const first = value.run('mcp-server', { autoRun: true })
  const repeated = value.run('mcp-server', { autoRun: true })
  value.reject(new Error('listener failed'))
  await assert.rejects(first, /listener failed/)
  await assert.rejects(repeated, /listener failed/)
  await assert.rejects(value.run('mcp-server', { autoRun: true }), /listener failed/)
  assert.equal(value.starts(), 2)
})
