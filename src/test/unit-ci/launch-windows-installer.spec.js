const { test, after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const { setTimeout: delay } = require('node:timers/promises')
const launchWindowsInstaller = require('../../app/lib/launch-windows-installer')

const isWin = process.platform === 'win32'
const root = isWin ? fs.mkdtempSync(path.resolve(__dirname, '../../../.installer-launch-regression-')) : null
after(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
})

function updater (launch) {
  const source = fs.readFileSync(path.resolve(__dirname, '../../app/server/download-upgrade.js'), 'utf8')
  const method = source.slice(source.indexOf('  async onEnd () {'), source.indexOf('  onError (err) {'))
    .replace('async onEnd ()', 'async function ()')
  const events = []
  const onEnd = vm.runInNewContext(`(${method})`, {
    isWin: true,
    installSrc: 'win-x64-installer.exe',
    launchWindowsInstaller: launch,
    openFile: assert.fail,
    process: { send: message => events.push(message.upgradeInstallerLaunched ? 'close' : 'show-file') }
  })
  const upgrade = {
    id: 'confirmed-launch',
    localPath: '',
    dir: 'download-directory',
    ws: { s: () => events.push('end') }
  }
  return { upgrade, events, run: () => onEnd.call(upgrade) }
}

function launcherWithExec (exec) {
  const module = { exports: {} }
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../../app/lib/launch-windows-installer.js'), 'utf8'), {
    module,
    require: name => {
      assert.equal(name, 'child_process')
      return { execFile: exec }
    },
    Buffer,
    process: { env: {} }
  })
  return module.exports
}

test('pending PowerShell/UAC cannot complete the update; cancellation propagates without shutdown', async () => {
  let complete
  const launch = launcherWithExec((command, args, options, callback) => {
    assert.equal(command, 'powershell.exe')
    assert.match(args.at(-1), /Start-Process.*-PassThru.*-ErrorAction Stop/)
    assert.match(args.at(-1), /catch[\s\S]*exit 1/)
    assert.equal(options.timeout, 120000)
    complete = callback
  })
  const f = updater(launch)
  f.upgrade.localPath = 'installer.exe'
  const pending = f.run()
  await Promise.resolve()
  assert.equal(f.upgrade.launched, undefined)
  assert.deepEqual(f.events, [])
  const cancelled = new Error('PowerShell exit 1')
  complete(cancelled, '', 'The operation was canceled by the user.')
  await assert.rejects(pending, /canceled by the user/)
  assert.equal(f.upgrade.launched, undefined)
  assert.deepEqual(f.events, [])
})

test('zero or missing process acknowledgement never requests shutdown', async () => {
  for (const output of ['', '0', 'not a process id']) {
    const launch = launcherWithExec((command, args, options, callback) => callback(null, output, ''))
    const f = updater(launch)
    f.upgrade.localPath = 'installer.exe'
    await assert.rejects(f.run(), /process creation was not confirmed/)
    assert.deepEqual(f.events, [])
  }
})

test('real Windows ShellExecute failure keeps the update unlaunched and emits no close handoff', { skip: !isWin, timeout: 20000 }, async () => {
  const f = updater(launchWindowsInstaller)
  f.upgrade.localPath = path.join(root, "missing installer ' unicode-\u03a9.exe")
  await assert.rejects(f.run(), error => {
    assert.ok(error.message.length > 0)
    return true
  })
  assert.equal(f.upgrade.launched, undefined)
  assert.deepEqual(f.events, [])
})

test('real Windows process creation is acknowledged before update completion and normal-close handoff', { skip: !isWin, timeout: 30000 }, async t => {
  const directory = path.join(root, "space ' unicode-\u03a9")
  fs.mkdirSync(directory)
  const exe = path.join(directory, 'installer-launch-fixture.exe')
  const script = `
$source = @'
using System;
using System.IO;
using System.Threading;
public class InstallerLaunchFixture {
  [STAThread]
  public static void Main() {
    string root = Environment.GetEnvironmentVariable("ANUBIS_LAUNCH_FIXTURE_ROOT");
    File.WriteAllText(Path.Combine(root, "started"), "started");
    Thread.Sleep(10000);
    File.WriteAllText(Path.Combine(root, "finished"), "finished");
  }
}
'@
Add-Type -TypeDefinition $source -OutputAssembly $env:ANUBIS_LAUNCH_FIXTURE_EXE -OutputType WindowsApplication -ErrorAction Stop
`
  await promisify(execFile)('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
    windowsHide: true,
    timeout: 15000,
    env: { ...process.env, TEMP: root, TMP: root, ANUBIS_LAUNCH_FIXTURE_EXE: exe }
  })
  const previous = process.env.ANUBIS_LAUNCH_FIXTURE_ROOT
  process.env.ANUBIS_LAUNCH_FIXTURE_ROOT = root
  t.after(() => {
    if (previous === undefined) delete process.env.ANUBIS_LAUNCH_FIXTURE_ROOT
    else process.env.ANUBIS_LAUNCH_FIXTURE_ROOT = previous
  })
  let pid
  const f = updater(async file => {
    pid = await launchWindowsInstaller(file)
  })
  f.upgrade.localPath = exe
  await f.run()
  assert.ok(Number.isSafeInteger(pid) && pid > 0)
  assert.equal(f.upgrade.launched, true)
  assert.deepEqual(f.events, ['show-file', 'end', 'close'])
  await promisify(execFile)('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `Get-Process -Id ${pid} -ErrorAction Stop | Out-Null`], {
    windowsHide: true,
    timeout: 10000
  })
  assert.equal(fs.existsSync(path.join(root, 'finished')), false, 'launcher must not wait for installer exit')
  const deadline = Date.now() + 15000
  while (!fs.existsSync(path.join(root, 'finished')) && Date.now() < deadline) await delay(100)
  assert.equal(fs.readFileSync(path.join(root, 'started'), 'utf8'), 'started')
  assert.equal(fs.readFileSync(path.join(root, 'finished'), 'utf8'), 'finished')
})
