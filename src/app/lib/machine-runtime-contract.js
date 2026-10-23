const fs = require('node:fs')
const path = require('node:path')

const MODES = new Map([
  ['--anubis-machine-host', 'system'],
  ['--anubis-context-worker', 'user-context']
])
const OPTIONS = new Map([
  ['--anubis-data-dir', 'dataDir'],
  ['--anubis-context-id', 'contextId'],
  ['--anubis-ready-file', 'readyFile'],
  ['--anubis-stop-file', 'stopFile'],
  ['--anubis-error-file', 'errorFile'],
  ['--anubis-control-pipe', 'controlPipe']
])
const PHASES = new Set(['bootstrap', 'engine', 'control', 'shutdown'])
const STARTUP_CODES = new Set([
  'EACCES', 'EPERM', 'ENOENT', 'EIO', 'ENOSPC', 'EROFS', 'ENOTDIR', 'EISDIR',
  'EINVAL', 'EMFILE', 'ENFILE', 'EADDRINUSE', 'EADDRNOTAVAIL', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT',
  'MODULE_NOT_FOUND', 'ERR_MODULE_NOT_FOUND', 'ERR_DLOPEN_FAILED',
  'ERR_MACHINE_RUNTIME_CONTRACT', 'ERR_MACHINE_IDENTITY', 'ERR_MACHINE_SYSTEM_REQUIRED',
  'ERR_MACHINE_USER_REQUIRED', 'ERR_MACHINE_POLICY', 'ERR_MACHINE_NATIVE_HELPER',
  'ERR_MACHINE_RENDERER_EXIT', 'ERR_MACHINE_WORKSPACE_TIMEOUT', 'ERR_MACHINE_INSTALLATION',
  'ERR_MACHINE_PROFILE_IN_USE', 'ERR_MACHINE_BACKEND_EXIT', 'ERR_MACHINE_CONTROL_SECURITY',
  'ERR_PROFILE_DATA_UNAVAILABLE',
  'ERR_ENGINE_NOT_READY', 'ERR_MACHINE_RUNTIME_START'
])

function invalid (message) {
  return Object.assign(new Error(message), { code: 'ERR_MACHINE_RUNTIME_CONTRACT' })
}

function localPath (value) {
  if (!/^[a-z]:\\/i.test(value) || value.includes('/') || /[:*?"<>|]/.test(value.slice(2)) ||
      [...value].some(char => char.charCodeAt(0) < 32) ||
      value.split('\\').some(part => part === '.' || part === '..' || /[. ]$/.test(part) ||
        /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(part))) {
    throw invalid('Machine runtime requires a canonical local Windows path')
  }
  return path.win32.normalize(value)
}

function parseMachineInvocation (argv, platform = process.platform) {
  if (!argv.some(arg => MODES.has(arg))) return null
  if (platform !== 'win32') throw invalid('Machine runtime requires Windows')
  const result = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (MODES.has(arg)) {
      if (result.mode) throw invalid('Multiple machine runtime modes')
      result.mode = MODES.get(arg)
      continue
    }
    const key = OPTIONS.get(arg)
    if (!key || key in result || !argv[i + 1] || argv[i + 1].startsWith('--')) {
      throw invalid('Invalid or duplicate machine runtime option')
    }
    result[key] = argv[++i]
  }
  if ([...OPTIONS.values()].some(key => !result[key])) throw invalid('Incomplete machine runtime invocation')
  if (!/^[a-f0-9]{32}$/.test(result.contextId)) throw invalid('Invalid machine runtime context ID')
  if (!/^\\\\\.\\pipe\\[a-z0-9_.-]{1,180}$/i.test(result.controlPipe)) {
    throw invalid('Invalid machine runtime control pipe')
  }
  for (const key of ['dataDir', 'readyFile', 'stopFile', 'errorFile']) {
    result[key] = localPath(result[key])
  }
  const files = [result.readyFile, result.stopFile, result.errorFile].map(file => file.toLowerCase())
  if (new Set(files).size !== files.length ||
      new Set(files.map(file => path.win32.dirname(file))).size !== 1 ||
      files.some(file => file === result.dataDir.toLowerCase())) {
    throw invalid('Invalid machine runtime control files')
  }
  return Object.freeze(result)
}

function writeSupervisorFile (file, value) {
  const before = fs.lstatSync(file)
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
    throw invalid('Supervisor status must be a precreated regular file')
  }
  // The supervisor owns the directory and file ACL; never create or rename here.
  const fd = fs.openSync(file, 'r+')
  try {
    const opened = fs.fstatSync(fd)
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.nlink !== 1) {
      throw invalid('Supervisor status file changed')
    }
    const data = Buffer.from(JSON.stringify(value))
    let offset = 0
    while (offset < data.length) {
      const written = fs.writeSync(fd, data, offset, data.length - offset, offset)
      if (!written) throw invalid('Supervisor status write did not advance')
      offset += written
    }
    fs.ftruncateSync(fd, data.length)
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
}

function writeReady (invocation) {
  writeSupervisorFile(invocation.readyFile, {
    version: 1,
    pid: process.pid,
    contextId: invocation.contextId
  })
}

function writeStartupFailure (invocation, phase, error) {
  if (!PHASES.has(phase)) throw invalid('Invalid machine runtime startup phase')
  const code = STARTUP_CODES.has(error?.code)
    ? error.code
    : 'ERR_MACHINE_RUNTIME_START'
  writeSupervisorFile(invocation.errorFile, {
    version: 1,
    pid: process.pid,
    contextId: invocation.contextId,
    phase,
    code
  })
}

module.exports = { parseMachineInvocation, writeSupervisorFile, writeReady, writeStartupFailure }
