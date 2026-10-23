const express = require('express')
const globalState = require('./global-state')
const app = express()
const log = require('../common/log')
const { initWs } = require('./dispatch-center')
const {
  isDev
} = require('../common/runtime-constants')
const initFileServer = require('../lib/file-server')
const appDec = require('./app-wrap')

const managedRpc = process.env.ANUBIS_MANAGED_TRANSPORT_SECRET
  ? require('./managed-rpc').createRpcChannel(process)
  : null
if (managedRpc) {
  app.all('/mcp', require('./managed-mcp').createManagedMcpProxy({
    secret: process.env.ANUBIS_MANAGED_TRANSPORT_SECRET,
    rpc: managedRpc.call
  }))
}
appDec(app)

if (managedRpc) {
  const { initManagedBrowser } = require('./managed-browser')
  const browser = initManagedBrowser(app, {
    secret: process.env.ANUBIS_MANAGED_TRANSPORT_SECRET,
    rpc: managedRpc.call,
    nativeToken: process.env.tokenElecterm,
    getSessionPort: require('./session-process').getSessionPort
  })
  process.on('message', message => {
    if (message?.type === 'managed-auth-changed') browser.invalidateSessions()
  })
  process.once('disconnect', () => browser.close())
  process.once('exit', () => browser.close())
}

app.get('/run', function (req, res) {
  res.send('ok')
})
app.post('/auth', function (req, res) {
  const { token } = req.body
  if (token === process.env.requireAuth) {
    globalState.authed = true
  }
  res.send('ok')
})
if (!isDev) {
  initFileServer(app)
}
initWs(app)

const runServer = function () {
  const { electermPort, electermHost } = process.env
  app.listen(electermPort, electermHost, () => {
    log.info('server', 'runs on', electermHost, electermPort)
    process.send({ serverInited: true })
  })
}

// start
runServer()

process.on('uncaughtException', (err) => {
  log.error('uncaughtException', err)
})
process.on('unhandledRejection', (err) => {
  log.error('unhandledRejection', err)
})

process.on('SIGTERM', () => {
  process.exit(0)
})
