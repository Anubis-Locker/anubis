const { execFile } = require('node:child_process')
const path = require('node:path')
const { serviceNameFromArgs } = require('./windows-host-client')

const CODES = new Set([
  'ERR_NATIVE_PASSWORD_INVALID_INPUT', 'ERR_NATIVE_PASSWORD_OLD_PASSWORD',
  'ERR_NATIVE_PASSWORD_PROFILE_UNAVAILABLE', 'ERR_NATIVE_PASSWORD_CONFLICT',
  'ERR_NATIVE_PASSWORD_STORAGE', 'ERR_NATIVE_PASSWORD_COMMITTED_INVALIDATION_FAILED',
  'ERR_NATIVE_PASSWORD_ADMISSION', 'ERR_NATIVE_PASSWORD_ELEVATION_REQUIRED',
  'ERR_NATIVE_PASSWORD_BUSY', 'ERR_NATIVE_PASSWORD_REQUEST',
  'ERR_NATIVE_PASSWORD_PRIVATE_CHANNEL_REQUIRED', 'ERR_NATIVE_PASSWORD_OUTCOME_UNKNOWN'
])
const CORE_CODES = new Set([
  'ERR_NATIVE_PASSWORD_INVALID_INPUT', 'ERR_NATIVE_PASSWORD_OLD_PASSWORD',
  'ERR_NATIVE_PASSWORD_PROFILE_UNAVAILABLE', 'ERR_NATIVE_PASSWORD_CONFLICT',
  'ERR_NATIVE_PASSWORD_STORAGE'
])
const hex = (value, length) => typeof value === 'string' && new RegExp('^[a-f0-9]{' + length + '}$').test(value)
const uint32 = value => Number.isInteger(value) && value > 0 && value <= 0xffffffff
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).sort().join(',') === keys
const password = (value, nonempty = false) => typeof value === 'string' &&
  (!nonempty || value.length > 0) && value.length <= 4096 &&
  Buffer.from(value, 'utf8').toString('utf8') === value

function nativePasswordError (code, committed) {
  return Object.assign(new Error('Native workspace password operation failed'), {
    code: CODES.has(code) ? code : 'ERR_NATIVE_PASSWORD_OUTCOME_UNKNOWN',
    ...(typeof committed === 'boolean' ? { committed } : {})
  })
}

function validOutcome (value, contextId, admissionId) {
  return exact(value, 'admissionId,committed,contextId,pid') && uint32(value.pid) &&
    value.contextId === contextId && hex(value.admissionId, 64) &&
    (!admissionId || value.admissionId === admissionId) && typeof value.committed === 'boolean'
}

function validRedemption (value, request) {
  const runtime = value?.runtime
  const caller = value?.caller
  return exact(value, 'admissionId,caller,contextId,newPassword,oldPassword,operation,runtime') &&
    value.operation === 'native-password-update' && value.contextId === request.contextId &&
    value.admissionId === request.admissionId &&
    exact(runtime, 'creationTime,pid') && runtime.pid === process.pid && hex(runtime.creationTime, 16) &&
    exact(caller, 'account,creationTime,elevated,logonSid,pid,sessionId,sid') &&
    typeof caller.sid === 'string' && /^S-1-(?:\d+-)+\d+$/.test(caller.sid) &&
    caller.sid !== 'S-1-5-18' && typeof caller.account === 'string' && caller.account.length > 0 &&
    caller.elevated === true && uint32(caller.sessionId) && uint32(caller.pid) &&
    typeof caller.logonSid === 'string' && /^S-1-5-5-\d+-\d+$/.test(caller.logonSid) && hex(caller.creationTime, 16) &&
    password(value.oldPassword) && password(value.newPassword, true)
}

function executeNativePassword (helper, serviceName, request, { signal } = {}) {
  const redeem = request?.operation === 'redeem-native-password'
  if (typeof helper !== 'string' || !path.win32.isAbsolute(helper) || path.win32.basename(helper).toLowerCase() !== 'anubis-host.exe' ||
      !hex(request?.contextId, 32) ||
      (redeem
        ? !exact(request, 'admissionId,contextId,operation,version') || !hex(request.admissionId, 64)
        : !exact(request, 'contextId,newPassword,oldPassword,operation,target,version') ||
          request.operation !== 'native-password-update' || request.target !== 'system' ||
          !password(request.oldPassword) || !password(request.newPassword, true)) ||
      request.version !== 1) {
    return Promise.reject(nativePasswordError('ERR_NATIVE_PASSWORD_INVALID_INPUT', false))
  }
  try {
    serviceNameFromArgs(['--anubis-service-name', serviceName])
  } catch {
    return Promise.reject(nativePasswordError('ERR_NATIVE_PASSWORD_INVALID_INPUT', false))
  }
  const frame = JSON.stringify(request) + '\n'
  if (Buffer.byteLength(frame) > 65536) {
    return Promise.reject(nativePasswordError('ERR_NATIVE_PASSWORD_INVALID_INPUT', false))
  }
  return new Promise((resolve, reject) => {
    const unknown = () => reject(nativePasswordError('ERR_NATIVE_PASSWORD_OUTCOME_UNKNOWN'))
    const child = execFile(helper, ['broker-client', '--name', serviceName, '--stdio'], {
      shell: false,
      windowsHide: true,
      encoding: 'utf8',
      timeout: redeem ? 5000 : 10000,
      signal,
      maxBuffer: 65536,
      stdio: ['pipe', 'pipe', 'pipe']
    }, (error, stdout) => {
      let reply
      try {
        reply = JSON.parse(stdout)
      } catch {
        return unknown()
      }
      if (!reply || reply.version !== 1 || typeof reply.ok !== 'boolean') return unknown()
      if (reply.ok) {
        if (error || Object.keys(reply).sort().join(',') !== 'ok,result,version') return unknown()
        if (redeem
          ? !validRedemption(reply.result, request)
          : !validOutcome(reply.result, request.contextId) || reply.result.committed !== true) return unknown()
        return resolve(reply.result)
      }
      if (!exact(reply, 'error,ok,version') && !exact(reply, 'error,ok,result,version')) return unknown()
      if (typeof reply.error !== 'string' || !CODES.has(reply.error)) return unknown()
      if (reply.error === 'ERR_NATIVE_PASSWORD_OUTCOME_UNKNOWN') return unknown()
      if (redeem) return reject(nativePasswordError('ERR_NATIVE_PASSWORD_ADMISSION', false))
      if (reply.result !== undefined) {
        if (!validOutcome(reply.result, request.contextId) ||
            (reply.result.committed !== (reply.error === 'ERR_NATIVE_PASSWORD_COMMITTED_INVALIDATION_FAILED'))) return unknown()
        return reject(nativePasswordError(reply.error, reply.result.committed))
      }
      if (CORE_CODES.has(reply.error) || reply.error === 'ERR_NATIVE_PASSWORD_COMMITTED_INVALIDATION_FAILED') return unknown()
      reject(nativePasswordError(reply.error, false))
    })
    child.stdin.on('error', unknown)
    child.stdin.end(frame)
  })
}

module.exports = {
  executeNativePassword, nativePasswordError, validOutcome, validRedemption, CORE_CODES
}
