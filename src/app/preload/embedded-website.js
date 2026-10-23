const { contextBridge, ipcRenderer } = require('electron')

const channel = 'anubis-website'
contextBridge.exposeInMainWorld('anubisWebsite', {
  version: 1,
  embedded: true,
  allocate: () => ipcRenderer.invoke(channel + '-allocate'),
  release: partition => ipcRenderer.invoke(channel + '-release', partition),
  authenticate: value => ipcRenderer.invoke(channel + '-auth', value),
  onAuth: callback => {
    const listener = (_event, value) => callback(value)
    ipcRenderer.on('anubis-website-auth', listener)
    return () => ipcRenderer.removeListener('anubis-website-auth', listener)
  },
  onError: callback => {
    const listener = (_event, value) => callback(value)
    ipcRenderer.on('anubis-website-error', listener)
    return () => ipcRenderer.removeListener('anubis-website-error', listener)
  }
})
