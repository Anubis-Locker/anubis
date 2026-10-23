const { test, mock } = require('node:test')
const assert = require('node:assert/strict')
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } = require('fs')
const { tmpdir } = require('os')
const { join } = require('path')
const { Arch } = require('builder-util')
const machineHost = require('../../build/bin/windows-machine-host')
// Native compilation has its own contract tests; ConPTY fixtures are not Go builds.
const hostBuild = mock.method(machineHost, 'copyWindowsMachineHost', () => {})
const afterPack = require('../../build/bin/after-pack')

function fixture (t, arch = 'x64') {
  const root = mkdtempSync(join(tmpdir(), 'anubis-pack-test-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const appDir = join(root, 'app')
  const appOutDir = join(root, 'out')
  const source = join(appDir, 'node_modules', 'node-pty', 'prebuilds', `win32-${arch}`, 'conpty')
  const release = join(
    appOutDir, 'resources', 'app.asar.unpacked', 'node_modules', 'node-pty', 'build', 'Release'
  )
  mkdirSync(source, { recursive: true })
  mkdirSync(release, { recursive: true })
  writeFileSync(join(release, 'conpty.node'), 'native module')
  return {
    source,
    release,
    context: { electronPlatformName: 'win32', arch: Arch[arch], appOutDir, packager: { info: { appDir } } }
  }
}

for (const arch of ['x64', 'arm64']) {
  test(`packages the ${arch} ConPTY runtime beside the rebuilt native module`, async t => {
    const { context, source, release } = fixture(t, arch)
    for (const file of ['conpty.dll', 'OpenConsole.exe']) {
      writeFileSync(join(source, file), `${arch}:${file}`)
    }
    await afterPack(context)
    assert.ok(hostBuild.mock.calls.some(call => call.arguments[0] === context && call.arguments[1] === arch))
    for (const file of ['conpty.dll', 'OpenConsole.exe']) {
      assert.equal(readFileSync(join(release, 'conpty', file), 'utf8'), `${arch}:${file}`)
    }
  })
}

test('fails the build when the console host is missing', async t => {
  const { context, source } = fixture(t)
  writeFileSync(join(source, 'conpty.dll'), 'dll')
  await assert.rejects(afterPack(context), /ENOENT.*OpenConsole\.exe/)
})

test('fails the build when a runtime binary is empty', async t => {
  const { context, source } = fixture(t)
  writeFileSync(join(source, 'conpty.dll'), '')
  await assert.rejects(afterPack(context), /Empty Windows terminal runtime/)
})

test('leaves Linux and macOS packages unchanged', async () => {
  await afterPack({ electronPlatformName: 'linux' })
  await afterPack({ electronPlatformName: 'darwin' })
})
