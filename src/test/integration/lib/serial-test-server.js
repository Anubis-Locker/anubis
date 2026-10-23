const { spawn } = require('node:child_process')
const { existsSync, readFileSync } = require('node:fs')
const { join } = require('node:path')

async function startTestSerialServer ({ rootDir }) {
  const child = spawn('python3', [join(__dirname, 'serial-test-server.py'), rootDir], {
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let failure
  let diagnostics = ''
  child.on('error', error => { failure = error })
  child.stderr.on('data', chunk => { diagnostics += chunk })
  const exit = new Promise(resolve => child.once('close', resolve))
  async function close () {
    if (child.exitCode !== null || child.signalCode !== null) return exit
    child.kill('SIGTERM')
    await exit
  }
  try {
    const pathFile = join(rootDir, 'serial-path')
    for (let attempt = 0; attempt < 100 && !existsSync(pathFile); attempt++) {
      if (failure) throw failure
      if (child.exitCode !== null) throw new Error(`Serial fixture exited: ${diagnostics}`)
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    if (!existsSync(pathFile)) throw new Error(`Serial fixture did not become ready: ${diagnostics}`)
    return {
      path: readFileSync(pathFile, 'utf8'),
      readInput: async () => JSON.parse(readFileSync(join(rootDir, 'serial-input.json'), 'utf8')),
      close
    }
  } catch (error) {
    await close()
    throw error
  }
}

module.exports = { startTestSerialServer }
