const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('anubisHost', {
  list: () => ipcRenderer.invoke('machine-client-list'),
  connect: selection => ipcRenderer.invoke('machine-client-connect', selection),
  elevate: () => ipcRenderer.invoke('machine-client-elevate'),
  update: () => ipcRenderer.invoke('machine-client-update'),
  openIntent: () => ipcRenderer.invoke('machine-client-intent'),
  clearIntents: () => ipcRenderer.invoke('machine-client-intent-clear'),
  onIntent: callback => {
    ipcRenderer.on('machine-client-intent-state', (_event, value) => callback(value))
  },
  onUpdate: callback => {
    ipcRenderer.on('machine-client-update-state', (_event, value) => callback(value))
  },
  onState: callback => {
    ipcRenderer.on('machine-client-state', (_event, value) => callback(value))
  }
})
