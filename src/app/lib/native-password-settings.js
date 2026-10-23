const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { executeNativePassword } = require('./native-password-client')

// Native broker authorization is mandatory; these checks only bind the local UI.
async function openNativePasswordSettings ({ parent, actor, helper, serviceName, getContext, onChanged }) {
  if (!actor.elevated || actor.sid === 'S-1-5-18' || !Number.isInteger(actor.sessionId) || actor.sessionId < 1) {
    return { ok: false, code: 'ERR_NATIVE_PASSWORD_ELEVATION_REQUIRED', committed: false }
  }
  const selected = getContext()
  if (selected?.identity.sid !== 'S-1-5-18' || selected.identity.sessionId !== 0 ||
      !/^[a-f0-9]{32}$/.test(selected.contextId)) {
    return { ok: false, code: 'ERR_NATIVE_PASSWORD_ADMISSION', committed: false }
  }
  const { BrowserWindow, ipcMain } = require('electron')
  const file = path.resolve(__dirname, '../native-password.html')
  const dialog = new BrowserWindow({
    parent,
    modal: true,
    show: false,
    width: 560,
    height: 560,
    resizable: false,
    minimizable: false,
    maximizable: false,
    title: 'SYSTEM workspace password',
    webPreferences: {
      partition: 'native-password-' + require('node:crypto').randomUUID(),
      preload: path.resolve(__dirname, '../preload/native-password.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: false
    }
  })
  const lifecycle = new AbortController()
  let busy = false
  let terminal = false
  let outcome = { ok: false, code: 'ERR_NATIVE_PASSWORD_CANCELLED', committed: false }
  const refreshAfterCommit = async () => {
    if (!sameSelection()) return
    try {
      await onChanged()
    } catch {
      outcome = { ok: false, code: 'ERR_NATIVE_PASSWORD_COMMITTED_REFRESH_FAILED', committed: true }
    }
  }
  const trusted = event => event.sender === dialog.webContents &&
    event.senderFrame === dialog.webContents.mainFrame && event.senderFrame.url === pathToFileURL(file).href
  const sameSelection = () => {
    const current = getContext()
    return current?.contextId === selected.contextId &&
      current.identity.sid === selected.identity.sid &&
      current.identity.pid === selected.identity.pid && current.identity.sessionId === 0
  }
  ipcMain.handle('native-password-submit', async (event, input) => {
    if (!trusted(event)) return { ok: false, code: 'ERR_NATIVE_PASSWORD_ADMISSION', committed: false }
    if (busy || terminal) return { ok: false, code: 'ERR_NATIVE_PASSWORD_BUSY', committed: false }
    if (!sameSelection() || !input || typeof input !== 'object' || Array.isArray(input) ||
        Object.keys(input).sort().join(',') !== 'confirmPassword,newPassword,oldPassword' ||
        input.confirmPassword !== input.newPassword) {
      return { ok: false, code: 'ERR_NATIVE_PASSWORD_INVALID_INPUT', committed: false }
    }
    busy = true
    try {
      await executeNativePassword(helper, serviceName, {
        version: 1,
        operation: 'native-password-update',
        target: 'system',
        contextId: selected.contextId,
        oldPassword: input.oldPassword,
        newPassword: input.newPassword
      }, { signal: lifecycle.signal })
      terminal = true
      outcome = { ok: true, committed: true }
      await refreshAfterCommit()
      return outcome
    } catch (error) {
      const known = typeof error.code === 'string' && error.code.startsWith('ERR_NATIVE_PASSWORD_')
      const code = known ? error.code : 'ERR_NATIVE_PASSWORD_OUTCOME_UNKNOWN'
      terminal = error.committed === true || code === 'ERR_NATIVE_PASSWORD_OUTCOME_UNKNOWN'
      outcome = { ok: false, code, ...(typeof error.committed === 'boolean' ? { committed: error.committed } : {}) }
      if (error.committed === true) await refreshAfterCommit()
      return outcome
    } finally {
      input.oldPassword = undefined
      input.newPassword = undefined
      input.confirmPassword = undefined
      busy = false
    }
  })
  ipcMain.handle('native-password-close', event => {
    if (trusted(event) && !busy) dialog.close()
  })
  dialog.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  dialog.webContents.on('will-navigate', event => event.preventDefault())
  dialog.on('close', event => {
    if (busy && !parent.isDestroyed()) event.preventDefault()
  })
  const closed = new Promise(resolve => {
    dialog.once('closed', () => {
      if (busy && !terminal) outcome = { ok: false, code: 'ERR_NATIVE_PASSWORD_OUTCOME_UNKNOWN' }
      lifecycle.abort()
      ipcMain.removeHandler('native-password-submit')
      ipcMain.removeHandler('native-password-close')
      resolve(outcome)
    })
  })
  try {
    await dialog.loadFile(file)
    dialog.show()
    return await closed
  } catch {
    dialog.destroy()
    await closed
    return { ok: false, code: 'ERR_NATIVE_PASSWORD_REQUEST', committed: false }
  }
}

module.exports = { openNativePasswordSettings }
