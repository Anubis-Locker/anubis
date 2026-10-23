const FtpSrv = require('@ai-security-tool/ftp-srv')

async function startTestFtpServer ({ rootDir, username, password }) {
  const errors = []
  const log = {
    child: () => log,
    trace: () => {},
    debug: () => {},
    info: () => {},
    warn: (...args) => console.warn('FTP fixture:', ...args),
    error: (details, message) => {
      if (message === 'Satisfy Parameters Error' && details.error === 'Socket not writable') {
        console.info('FTP fixture: peer closed its control connection before a reply')
        return
      }
      errors.push({ details, message })
    }
  }
  const server = new FtpSrv({ url: 'ftp://127.0.0.1:0', pasv_url: '127.0.0.1', log })
  server.on('login', ({ username: user, password: pass }, resolve, reject) => {
    if (user !== username || pass !== password) {
      reject(new Error('Invalid fixture credentials'))
      return
    }
    resolve({ root: rootDir })
  })
  server.on('client-error', ({ error }) => errors.push(error))
  await server.listen()
  return { port: server.server.address().port, close: () => server.close(), errors }
}

module.exports = { startTestFtpServer }
