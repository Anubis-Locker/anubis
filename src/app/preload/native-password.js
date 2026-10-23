const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('nativePasswordSettings', {
  submit: input => ipcRenderer.invoke('native-password-submit', input),
  close: () => ipcRenderer.invoke('native-password-close')
})
