const fs = require('node:fs/promises')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { isVvFile } = require('../common/vv-file')
const { parseQuickConnect } = require('../common/parse-quick-connect')

const MAX_FILE_BYTES = 1024 * 1024
const MAX_ARGUMENT_BYTES = 65536
const fail = code => Object.assign(new Error(code), { code })

function connectionArguments (argv) {
  if (!Array.isArray(argv) || argv.some(value => typeof value !== 'string') ||
      Buffer.byteLength(JSON.stringify(argv)) > MAX_ARGUMENT_BYTES) throw fail('ERR_HOST_INTENT_ARGUMENTS')
  const args = []
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index]
    if (value === '--anubis-machine-client') continue
    if (value === '--anubis-service-name') {
      index++
      continue
    }
    if (/^--remote-debugging-(?:address=127\.0\.0\.1|port=\d+)$/.test(value)) continue
    args.push(...argv.slice(index))
    break
  }
  return args
}

async function readLocalFile (value, cwd) {
  const file = path.win32.resolve(cwd, value)
  if (!/^[a-z]:\\/i.test(file) || /:/.test(file.slice(2))) throw fail('ERR_HOST_INTENT_FILE')
  let handle
  try {
    handle = await fs.open(file, 'r')
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw fail('ERR_HOST_INTENT_FILE')
    const buffer = Buffer.alloc(MAX_FILE_BYTES + 1)
    let length = 0
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null)
      if (!bytesRead) break
      length += bytesRead
    }
    if (length > MAX_FILE_BYTES) throw fail('ERR_HOST_INTENT_FILE')
    return buffer.subarray(0, length).toString('utf8')
  } catch {
    throw fail('ERR_HOST_INTENT_FILE')
  } finally {
    if (handle) await handle.close()
  }
}

async function parseMachineIntent (args, cwd, { version, cli }) {
  args = connectionArguments(args)
  if (!args.length) return null
  const { createCommandLine } = require('./command-line-options')
  const program = createCommandLine({ version, cli })
    .allowUnknownOption(false)
    .configureOutput({ writeOut () {}, writeErr () {} })
  try {
    program.parse(args, { from: 'user' })
  } catch (error) {
    if (['commander.helpDisplayed', 'commander.version'].includes(error.code)) {
      return { kind: 'help', text: error.code === 'commander.version' ? version : program.helpInformation() }
    }
    throw fail('ERR_HOST_INTENT_ARGUMENTS')
  }
  const options = program.opts()
  if (options.batchOp || options.serverPort) throw fail('ERR_HOST_INTENT_UNSUPPORTED')
  const vvFile = program.args.find(isVvFile)
  if (vvFile) {
    const text = await readLocalFile(vvFile.trim(), cwd)
    const [{ parseVv }, { vvToTab }] = await Promise.all([
      import(pathToFileURL(path.join(__dirname, '../common/parse-vv.mjs')).href),
      import(pathToFileURL(path.join(__dirname, '../common/vv-to-tab.mjs')).href)
    ])
    const parsed = parseVv(text)
    if (!parsed.ok) throw fail('ERR_HOST_INTENT_VV')
    return {
      kind: 'tab',
      tab: vvToTab(parsed, { filePath: vvFile }),
      warningCount: parsed.warnings.length
    }
  }
  if (options.opts) {
    try {
      const value = JSON.parse(options.opts)
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid options')
    } catch {
      throw fail('ERR_HOST_INTENT_ARGUMENTS')
    }
  }
  if (options.privateKeyPath) {
    const privateKey = await readLocalFile(options.privateKeyPath, cwd)
    options.opts = JSON.stringify({ ...JSON.parse(options.opts || '{}'), privateKey })
    delete options.privateKeyPath
  }
  if (!options.tp && !options.opts && !program.args.some(value => parseQuickConnect(value))) {
    throw fail('ERR_HOST_INTENT_ARGUMENTS')
  }
  return { kind: 'cli', payload: { options, argv: program.args } }
}

function intentScript (intent) {
  const value = JSON.stringify(intent).replace(/[\u2028\u2029]/g, char =>
    '\\u' + char.charCodeAt(0).toString(16))
  return `(async () => {
    if (!window.store || window.store.initLoadingData || !window.et?.wsOpened) return false;
    const request = ${value};
    if (request.kind === 'tab') await window.store.ipcOpenTab(request.tab);
    else await window.store.addTabFromCommandLine(null, request.payload);
    return true;
  })()`
}

function describeIntent (intent) {
  let tab = intent.tab
  if (intent.kind === 'cli') {
    const { options, argv } = intent.payload
    const protocol = argv.find(value => /^[a-z][a-z\d+.-]*:\/\//i.test(value))
    tab = protocol
      ? parseQuickConnect(protocol)
      : {
          ...(argv.map(value => parseQuickConnect(value)).find(Boolean) || {}),
          ...(options.port ? { port: Number(options.port) } : {}),
          ...JSON.parse(options.opts || '{}'),
          ...(options.tp ? { type: options.tp } : {})
        }
  }
  tab ||= {}
  const type = ['ssh', 'telnet', 'rdp', 'vnc', 'serial', 'spice', 'ftp', 'web', 'local'].includes(tab.type)
    ? tab.type.toUpperCase()
    : 'Connection'
  let host = tab.host
  if (tab.type === 'web') {
    try { host = new URL(tab.url).hostname } catch { host = '' }
  }
  const safeHost = typeof host === 'string' &&
    (require('node:net').isIP(host) || /^[a-z\d](?:[a-z\d._-]{0,251}[a-z\d])?$/i.test(host))
    ? host
    : ['local', 'serial'].includes(tab.type) ? '' : '[ticket-based or non-host target]'
  const port = Number(tab.port)
  return type + (safeHost ? ' ' + safeHost : '') +
    (Number.isInteger(port) && port > 0 && port <= 65535 ? ':' + port : '') +
    (intent.kind === 'cli' && JSON.parse(intent.payload.options.opts || '{}').privateKey
      ? '\nAn SSH private key was supplied by the interactive caller.'
      : '')
}

function quoteWindowsArgument (value) {
  return '"' + value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1') + '"'
}

module.exports = { parseMachineIntent, connectionArguments, intentScript, describeIntent, quoteWindowsArgument }
