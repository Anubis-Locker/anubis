const { executeNativePassword, nativePasswordError, CORE_CODES } = require('./native-password-client')

// Credentials and OS admission come only from the protected broker redemption.
function createNativePasswordHandler ({ helper, serviceName, contextId, updatePassword }) {
  if (!/^[a-f0-9]{32}$/.test(contextId) || typeof updatePassword !== 'function') {
    throw new TypeError('Native password handler requires its canonical runtime context')
  }
  let active = false
  return async packet => {
    if (!packet || typeof packet !== 'object' || Array.isArray(packet) ||
        Object.keys(packet).sort().join(',') !== 'admissionId,contextId,operation,version' ||
        packet.version !== 1 || packet.operation !== 'native-password-update' ||
        packet.contextId !== contextId || typeof packet.admissionId !== 'string' ||
        !/^[a-f0-9]{64}$/.test(packet.admissionId)) {
      throw nativePasswordError('ERR_NATIVE_PASSWORD_ADMISSION', false)
    }
    if (active) throw nativePasswordError('ERR_NATIVE_PASSWORD_BUSY', false)
    active = true
    let redeemed
    const result = { pid: process.pid, contextId, admissionId: packet.admissionId }
    try {
      try {
        redeemed = await executeNativePassword(helper, serviceName, {
          version: 1,
          operation: 'redeem-native-password',
          contextId,
          admissionId: packet.admissionId
        })
      } catch {
        // The broker alone decides whether this invocation was still unredeemed.
        return {
          version: 1,
          ok: false,
          result: { ...result, committed: false },
          error: { code: 'ERR_NATIVE_PASSWORD_ADMISSION' }
        }
      }
      try {
        const changed = await updatePassword({
          oldPassword: redeemed.oldPassword,
          newPassword: redeemed.newPassword
        })
        if (changed?.committed !== true || Object.keys(changed).join(',') !== 'committed') {
          throw nativePasswordError('ERR_NATIVE_PASSWORD_OUTCOME_UNKNOWN')
        }
        return { version: 1, ok: true, result: { ...result, committed: true } }
      } catch (error) {
        const uncommitted = CORE_CODES.has(error.code) && error.committed === false
        const committedFailure = error.code === 'ERR_NATIVE_PASSWORD_COMMITTED_INVALIDATION_FAILED' && error.committed === true
        if (!uncommitted && !committedFailure) throw nativePasswordError('ERR_NATIVE_PASSWORD_OUTCOME_UNKNOWN')
        return {
          version: 1,
          ok: false,
          result: { ...result, committed: committedFailure },
          error: { code: error.code }
        }
      }
    } finally {
      if (redeemed) {
        redeemed.oldPassword = undefined
        redeemed.newPassword = undefined
      }
      active = false
    }
  }
}

module.exports = { createNativePasswordHandler }
