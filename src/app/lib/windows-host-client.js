const { execFile, spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

function clientError (code) {
  return Object.assign(new Error('Windows machine host is unavailable or access was denied'), { code })
}

function serviceNameFromArgs (argv, marker = null) {
  if (marker !== null && (!marker || Array.isArray(marker) ||
      marker.version !== 1 || Object.keys(marker).sort().join(',') !== 'serviceName,version' ||
      typeof marker.serviceName !== 'string' ||
      !/^AnubisHost(?:-QA-[a-zA-Z0-9-]{1,64})?$/.test(marker.serviceName))) {
    throw clientError('ERR_HOST_INSTALL_MARKER')
  }
  const index = argv.indexOf('--anubis-service-name')
  const name = index < 0 ? marker?.serviceName || 'AnubisHost' : argv[index + 1]
  if (argv.filter(arg => arg === '--anubis-service-name').length > 1 ||
      typeof name !== 'string' || !/^AnubisHost(?:-QA-[a-zA-Z0-9-]{1,64})?$/.test(name)) {
    throw clientError('ERR_HOST_SERVICE_NAME')
  }
  return name
}

function readInstallerMarker (installDir) {
  let fd
  try {
    fd = fs.openSync(path.join(installDir, 'anubis-machine-install.json'), 'r')
    const stat = fs.fstatSync(fd)
    if (!stat.isFile() || stat.size > 1024) throw clientError('ERR_HOST_INSTALL_MARKER')
    const marker = JSON.parse(fs.readFileSync(fd, 'utf8'))
    if (marker === null) throw clientError('ERR_HOST_INSTALL_MARKER')
    serviceNameFromArgs([], marker)
    return marker
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw clientError('ERR_HOST_INSTALL_MARKER')
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
}

function requestHost (helper, serviceName, request, { signal } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(helper, ['broker-client', '--name', serviceName, '--stdio'], {
      shell: false,
      windowsHide: true,
      encoding: 'utf8',
      timeout: 40000,
      signal,
      maxBuffer: 65536,
      stdio: ['pipe', 'pipe', 'pipe']
    }, (error, stdout) => {
      if (error) return reject(clientError('ERR_HOST_REQUEST'))
      let response
      try {
        response = JSON.parse(stdout)
      } catch {
        return reject(clientError('ERR_HOST_RESPONSE'))
      }
      if (response?.version !== 1 || response.ok !== true) return reject(clientError('ERR_HOST_REQUEST'))
      resolve(response.result)
    })
    child.stdin.on('error', () => reject(clientError('ERR_HOST_REQUEST')))
    child.stdin.end(JSON.stringify(request) + '\n')
  })
}

function isPreparedUpdatePath (file, serviceName) {
  const suffix = '\\Anubis\\Host\\' + serviceName + '\\updates\\'
  return typeof file === 'string' && path.win32.isAbsolute(file) &&
    file.includes(suffix) && /^[a-f0-9]{32}\\installer\.exe$/.test(file.split(suffix)[1] || '')
}

async function discardPreparedWindowsUpdate (file, serviceName) {
  if (!isPreparedUpdatePath(file, serviceName)) throw clientError('ERR_HOST_UPDATE_CLEANUP')
  await fs.promises.unlink(file)
  await fs.promises.rmdir(path.dirname(file))
}

function prepareWindowsUpdate (helper, serviceName, file, update) {
  return new Promise((resolve, reject) => {
    execFile(helper, ['prepare-update', '--name', serviceName, '--source-file', file,
      '--sha256', update.sha256, '--size', String(update.size)], {
      windowsHide: true,
      encoding: 'utf8',
      timeout: 120000,
      maxBuffer: 32768,
      stdio: ['ignore', 'pipe', 'pipe']
    }, (error, stdout) => {
      if (error) return reject(clientError('ERR_HOST_UPDATE_PREPARE'))
      let result
      try { result = JSON.parse(stdout) } catch { return reject(clientError('ERR_HOST_UPDATE_PREPARE')) }
      if (result?.size !== update.size || result.sha256 !== update.sha256 ||
          !isPreparedUpdatePath(result.path, serviceName)) {
        return reject(clientError('ERR_HOST_UPDATE_PREPARE'))
      }
      resolve(result.path)
    })
  })
}

function launchPreparedWindowsUpdate (file) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, [], {
      cwd: path.dirname(file),
      shell: false,
      detached: true,
      stdio: 'ignore',
      windowsHide: false
    })
    child.once('error', () => reject(clientError('ERR_HOST_UPDATE_LAUNCH')))
    child.once('spawn', () => {
      child.unref()
      resolve(child.pid)
    })
  })
}

function validateDescriptor (value, target, expectedSid) {
  const identity = value?.identity
  const endpoint = value?.endpoint
  if (!/^[a-f0-9]{32}$/.test(value?.contextId) ||
      !identity || !/^S-1-(?:\d+-)+\d+$/.test(identity.sid) ||
      typeof identity.account !== 'string' || !identity.account ||
      !Number.isInteger(identity.pid) || identity.pid < 1 ||
      !Number.isInteger(identity.sessionId) || identity.sessionId < 0 ||
      typeof identity.elevated !== 'boolean' ||
      !endpoint || !Number.isInteger(endpoint.localPort) || endpoint.localPort < 1 ||
      endpoint.localPort > 65535 || !/^[a-f0-9]{64}$/.test(endpoint.privateProof)) {
    throw clientError('ERR_HOST_DESCRIPTOR')
  }
  if ((target.target === 'system' && (identity.sid !== 'S-1-5-18' || identity.sessionId !== 0 || !identity.elevated)) ||
      (target.target === 'user' && (identity.sessionId !== target.sessionId || identity.sid !== expectedSid))) {
    throw clientError('ERR_HOST_CONTEXT_IDENTITY')
  }
  return value
}

function isContextUrl (url, port) {
  try {
    const parsed = new URL(url)
    return ['http:', 'ws:'].includes(parsed.protocol) && parsed.hostname === '127.0.0.1' &&
      parsed.port === String(port) && !parsed.username && !parsed.password
  } catch {
    return false
  }
}

function publicContext (descriptor) {
  const { sid, account, elevated, sessionId, pid } = descriptor.identity
  return { contextId: descriptor.contextId, identity: { sid, account, elevated, sessionId, pid } }
}

module.exports = {
  serviceNameFromArgs,
  readInstallerMarker,
  requestHost,
  prepareWindowsUpdate,
  discardPreparedWindowsUpdate,
  launchPreparedWindowsUpdate,
  validateDescriptor,
  isContextUrl,
  publicContext
}
