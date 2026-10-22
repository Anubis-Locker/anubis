/**
 * Admin-level settings (see fork/docs/ADMIN-VS-USER.md).
 * The main process decides which keys are locked for this installation and
 * sends them as `config.adminLockedKeys`; the real enforcement is in
 * src/app/common/admin-policy.js, this only hides/disables the UI.
 *
 * Keep ADMIN_LOCKABLE_KEYS in sync with src/app/common/admin-policy.js.
 */

export const ADMIN_LOCKABLE_KEYS = [
  'syncSetting.cloudApiUrl',
  'baseURLAI',
  'apiPathAI',
  'authHeaderNameAI',
  'enableGlobalProxy',
  'proxy',
  'checkUpdateOnStart',
  'mcpServerEnabled',
  'errorReportEnabled',
  'errorReportUrl',
  'autoStartOnLogin'
]

export function getAdminLockedKeys (config) {
  const cfg = config || globalThis.window?.store?.config
  return cfg?.adminLockedKeys || []
}

export function isAdminLocked (key, config) {
  return getAdminLockedKeys(config).includes(key)
}
