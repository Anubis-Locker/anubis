const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const { parseMachineIntent, connectionArguments, intentScript, describeIntent, quoteWindowsArgument } = require('../../app/lib/machine-client-intent')

const metadata = { version: '5.6.12', cli: 'anubis' }
const parse = (args, cwd = process.cwd()) => parseMachineIntent(args, cwd, metadata)

test('machine launch flags are excluded without swallowing a connection option value', async () => {
  assert.deepEqual(connectionArguments([
    '--anubis-machine-client', '--anubis-service-name', 'AnubisHost',
    '--password', '--anubis-machine-client', 'root@example.invalid'
  ]), ['--password', '--anubis-machine-client', 'root@example.invalid'])
  assert.equal(await parse(['--anubis-machine-client', '--anubis-service-name', 'AnubisHost']), null)
  const value = await parse(['-pw', 'synthetic-password', '-l', 'alice', '-P', '2222', 'example.invalid'])
  assert.equal(value.kind, 'cli')
  assert.equal(value.payload.options.password, 'synthetic-password')
  assert.equal(value.payload.options.user, 'alice')
  assert.equal(value.payload.options.port, '2222')
  assert.deepEqual(value.payload.argv, ['example.invalid'])
})

test('machine links and help are accepted, while unsupported server/batch flags and malformed inputs fail explicitly', async () => {
  for (const url of ['ssh://alice@example.invalid', 'vnc://127.0.0.1:5901', 'anubis://host?type=rdp']) {
    assert.equal((await parse([url])).kind, 'cli')
  }
  assert.match((await parse(['--help'])).text, /private-key-path/)
  assert.equal((await parse(['--version'])).text, '5.6.12')
  for (const args of [['-sp', '30976'], ['-bo', 'work.json']]) {
    await assert.rejects(parse(args), { code: 'ERR_HOST_INTENT_UNSUPPORTED' })
  }
  for (const args of [['--unknown'], ['--password'], ['--opts', '[]'], ['--opts', '{'], ['x'.repeat(65536)]]) {
    await assert.rejects(parse(args), { code: 'ERR_HOST_INTENT_ARGUMENTS' })
  }
})

test('.vv uses the canonical parser; files are local, bounded, regular and read before the workspace receives the request', {
  skip: process.platform !== 'win32'
}, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'anubis-machine-intent-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const file = path.join(root, 'console.vv')
  await fs.writeFile(file, '[virt-viewer]\ntype=spice\nhost=127.0.0.1\nport=5902\npassword=synthetic-ticket\nusername=ignored\n')
  const request = await parse(['console.vv'], root)
  assert.equal(request.kind, 'tab')
  assert.equal(request.tab.type, 'spice')
  assert.equal(request.tab.port, 5902)
  assert.equal(request.tab.password, 'synthetic-ticket')
  assert.equal(request.warningCount, 1)
  assert.ok(!JSON.stringify(request).includes(root))
  await fs.unlink(file)
  let received
  assert.equal(await vm.runInNewContext(intentScript(request), {
    window: { et: { wsOpened: true }, store: { ipcOpenTab: tab => { received = tab } } }
  }), true)
  assert.equal(received.password, 'synthetic-ticket')
  await assert.rejects(parse(['console.vv'], root), { code: 'ERR_HOST_INTENT_FILE' })
  await fs.writeFile(file, '[virt-viewer]\ntype=rdp\nhost=127.0.0.1\n')
  await assert.rejects(parse([file]), { code: 'ERR_HOST_INTENT_VV' })
  await fs.writeFile(file, Buffer.alloc(1024 * 1024 + 1))
  await assert.rejects(parse([file]), { code: 'ERR_HOST_INTENT_FILE' })
})

test('UNC, device and alternate-stream intent files are rejected on every platform', async () => {
  for (const value of ['\\\\server\\share\\console.vv', '\\\\?\\C:\\console.vv', 'C:\\console.vv:ticket.vv']) {
    await assert.rejects(parse([value]), { code: 'ERR_HOST_INTENT_FILE' })
    await assert.rejects(parse(['-i', value, 'root@example.invalid']), { code: 'ERR_HOST_INTENT_FILE' })
  }
})

test('private keys are read by the interactive process, not by the selected workspace', {
  skip: process.platform !== 'win32'
}, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'anubis-machine-key-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const file = path.join(root, 'private key')
  await fs.writeFile(file, 'synthetic-key-material')
  const request = await parse(['-i', 'private key', 'root@example.invalid'], root)
  assert.equal(request.payload.options.privateKeyPath, undefined)
  assert.equal(JSON.parse(request.payload.options.opts).privateKey, 'synthetic-key-material')
  assert.ok(!JSON.stringify(request).includes(root))
  await fs.unlink(file)
  let received
  await vm.runInNewContext(intentScript(request), {
    window: { et: { wsOpened: true }, store: { addTabFromCommandLine: (_event, payload) => { received = payload } } }
  })
  assert.equal(JSON.parse(received.options.opts).privateKey, 'synthetic-key-material')
})

test('locked workspace requests do not execute, and serialized payloads cannot turn into executable JavaScript', async () => {
  const request = await parse(['ssh://alice@example.invalid', '--title', '"; globalThis.injected=true; //\u2028'])
  assert.equal(await vm.runInNewContext(intentScript(request), { window: {} }), false)
  const sandbox = {
    window: {
      et: { wsOpened: true },
      store: { addTabFromCommandLine: (_event, payload) => assert.equal(payload.options.title, request.payload.options.title) }
    }
  }
  assert.equal(await vm.runInNewContext(intentScript(request), sandbox), true)
  assert.equal(sandbox.injected, undefined)
  assert.equal(quoteWindowsArgument('a "quoted" value\\'), '"a \\"quoted\\" value\\\\"')
})

test('native confirmation shows the actual connection destination, never URL passwords or SPICE tickets', async () => {
  assert.equal(describeIntent(await parse(['ssh://alice:synthetic-ticket@example.invalid:2222'])), 'SSH example.invalid:2222')
  assert.equal(describeIntent(await parse(['ssh://alice@example.invalid', '--opts', '{"host":"ignored.invalid"}'])), 'SSH example.invalid:22')
  assert.equal(describeIntent(await parse(['--tp', 'rdp', '--opts', '{"host":"127.0.0.1","port":3389}'])), 'RDP 127.0.0.1:3389')
  assert.equal(describeIntent(await parse(['-P', '2223', 'root@example.invalid'])), 'SSH example.invalid:2223')
  const description = describeIntent({ kind: 'tab', tab: { type: 'spice', host: 'PVE:synthetic-ticket::', port: 5900 } })
  assert.match(description, /ticket-based/)
  assert.ok(!description.includes('synthetic-ticket'))
})

test('Windows native argument parsing round-trips UAC quoting, including spaces, quotes and trailing backslashes', {
  skip: process.platform !== 'win32'
}, () => {
  const values = ['anubis.exe', '', 'ssh://alice@example.invalid', 'a "quoted" title\\', 'C:\\dir with spaces\\', "apostrophe'", '\u03b1']
  const command = values.map(quoteWindowsArgument).join(' ').replace(/'/g, "''")
  const script = `
$ProgressPreference='SilentlyContinue'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class AnubisIntentArgv {
  [DllImport("shell32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr CommandLineToArgvW(string text, out int count);
  [DllImport("kernel32.dll")] public static extern IntPtr LocalFree(IntPtr value);
}
'@
$count=0
$pointer=[AnubisIntentArgv]::CommandLineToArgvW('${command}', [ref]$count)
try {
  $values=@(for ($i=0; $i -lt $count; $i++) {
    [Runtime.InteropServices.Marshal]::PtrToStringUni([Runtime.InteropServices.Marshal]::ReadIntPtr($pointer,$i*[IntPtr]::Size))
  })
  [Console]::OutputEncoding=New-Object Text.UTF8Encoding($false)
  ConvertTo-Json -InputObject $values -Compress
} finally { [AnubisIntentArgv]::LocalFree($pointer) | Out-Null }
`
  const result = require('node:child_process').execFileSync(
    path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { encoding: 'utf8', windowsHide: true, timeout: 15000 }
  )
  assert.deepEqual(JSON.parse(result.trim()), values)
})
