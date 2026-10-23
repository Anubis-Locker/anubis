const crypto = require('crypto')

const ALLOWED_FUNCTIONS = new Set([
  'AIchat', 'AIchatWithTools', 'AIlistModels', 'getStreamContent', 'stopStream',
  'abortAIRequest', 'encryptAsync', 'decryptAsync', 'lookup', 'loadSshConfig',
  'listSerialPorts', 'loadFontList', 'listItermThemes', 'saveUserConfig',
  'watchFile', 'unwatchFile', 'listWidgets', 'runWidget', 'stopWidget',
  'runWidgetFunc', 'checkDbUpgrade', 'doUpgrade', 'getEnv'
])
const BROWSER_TABLES = new Set([
  'bookmarks', 'bookmarkGroups', 'addressBookmarks', 'terminalThemes',
  'quickCommands', 'profiles', 'workspaces', 'triggers', 'history',
  'terminalCommandHistory', 'aiChatHistory', 'autoRunWidgets'
])

function sanitizeConfig (config) {
  const result = { ...config }
  for (const key of ['tokenElecterm', 'requireAuth', 'hashedPassword', 'salt', 'mcpToken', 'mcpServerToken']) {
    delete result[key]
  }
  result.host = ''
  result.port = ''
  result.server = ''
  result.useSystemTitleBar = true
  return result
}

function createBrowserRpc ({ functions, getConfig, getPassword, constants, init }) {
  return async (func, args = []) => {
    if (!Array.isArray(args)) throw new Error('Invalid browser RPC arguments')
    if (func === 'browserInfo') {
      return {
        ...constants(),
        config: sanitizeConfig(getConfig()),
        requirePassword: !!(await getPassword()).hashedPassword
      }
    }
    if (func === 'browserLogin') {
      const { salt, hashedPassword } = await getPassword()
      if (!hashedPassword) return true
      if (typeof args[0] !== 'string' || args[0].length > 4096 || !salt) return false
      const actual = crypto.pbkdf2Sync(args[0], salt, 1000, 64, 'sha512')
      const expected = Buffer.from(hashedPassword, 'hex')
      return actual.length === expected.length && crypto.timingSafeEqual(actual, expected)
    }
    if (func === 'init') {
      const result = await init()
      return { ...result, config: sanitizeConfig(result.config) }
    }
    if (func === 'saveUserConfig') {
      const config = args[0]
      if (!config || typeof config !== 'object' || Array.isArray(config) ||
          ['requireAuth', 'hashedPassword', 'salt', 'mcpToken', 'mcpServerToken'].some(key => key in config)) {
        throw new Error('Native authentication settings cannot be changed remotely')
      }
      await functions.saveUserConfig(config)
      return true
    }
    if (func === 'dbAction') {
      const [table, action] = args
      if (!(BROWSER_TABLES.has(table) || table === 'data') ||
          !['find', 'findOne', 'insert', 'update', 'remove', 'count'].includes(action)) {
        throw new Error('Invalid browser database operation')
      }
      // Config includes local authentication and native transport secrets.
      // Only the policy-aware config controller can read or update it remotely.
      if (table === 'data') {
        const query = args[2]
        const id = query?._id
        if (!query || Object.keys(query).length !== 1 || typeof id !== 'string' ||
            !(id === 'lastDataUpdateTime' ||
            (id.endsWith(':order') && BROWSER_TABLES.has(id.slice(0, -6)))) ||
            !['findOne', 'update'].includes(action)) {
          throw new Error('Use managed configuration API for application data')
        }
        if (action === 'update' &&
            (Object.keys(args[3] || {}).length !== 1 ||
            Object.keys(args[3].$set || {}).some(key => key !== 'value'))) {
          throw new Error('Invalid managed application data update')
        }
      }
      return functions.dbAction(...args)
    }
    if (['checkMigrate', 'getPendingDeepLink', 'getPendingVvFile'].includes(func)) return null
    if (func === 'getScreenSize') return { width: 1920, height: 1080 }
    if (['initCommandLine', 'registerDeepLink', 'setWindowSize', 'setBackgroundColor'].includes(func)) return true
    if (!ALLOWED_FUNCTIONS.has(func) ||
        !Object.prototype.hasOwnProperty.call(functions, func) ||
        typeof functions[func] !== 'function') {
      throw new Error(`Unsupported managed browser function: ${String(func)}`)
    }
    return functions[func](...args)
  }
}

module.exports = { createBrowserRpc, sanitizeConfig, ALLOWED_FUNCTIONS }
