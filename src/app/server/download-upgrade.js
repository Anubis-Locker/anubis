/**
 * download upgrade class
 */

const fs = require('fs')
const { resolve, basename, win32 } = require('path')
const { Transform } = require('stream')
const { pipeline } = require('stream/promises')
const _ = require('../lib/lodash.js')
const rp = require('axios')
const { tempDir, isWin } = require('../common/runtime-constants')
const installSrc = require('../lib/install-src')
const { fsExport } = require('../lib/fs')
const { createProxyAgent } = require('../lib/proxy-agent')
const { openFile, rmrf } = fsExport
const launchWindowsInstaller = require('../lib/launch-windows-installer')
const log = require('../common/log')
const globalState = require('./global-state')

const brand = require('../common/brand')

rp.defaults.proxy = false

// mirrors come from brand.update.mirrors; a template may use {url}, {tag}, {file}
function getUrl (url, mirror) {
  const m = brand.update.mirrors.find(d => d.id === mirror)
  if (!m) {
    return url
  }
  const arr = url.split('/')
  const len = arr.length
  return m.template
    .replace('{url}', url)
    .replace('{tag}', arr[len - 2])
    .replace('{file}', arr[len - 1])
}

function getReleaseInfo (
  filter, releaseInfoUrl, agent, signal
) {
  const conf = {
    url: releaseInfoUrl,
    timeout: 15000,
    signal
  }
  if (agent) {
    conf.httpAgent = agent
    conf.httpsAgent = agent
  }
  return rp(conf)
    .then((res) => {
      return res.data
        .release
        .assets
        .filter(filter)[0]
    })
}

class Upgrade {
  constructor (options) {
    this.options = options
    this.id = options.id
    this.ws = options.ws
    this.controller = new AbortController()
    this.pausing = false
  }

  async init () {
    try {
      if (this.onDestroy) {
        return
      }
      const { proxy, mirror } = this.options
      const agent = createProxyAgent(proxy)
      const { signal } = this.controller
      const releaseInfoUrl = `${brand.update.baseUrls[0]}${brand.update.releaseJson}?_=${+new Date()}`
      const filter = r => typeof r.name === 'string' && r.name.endsWith(installSrc)
      const releaseInfo = await getReleaseInfo(filter, releaseInfoUrl, agent, signal)
      if (!releaseInfo) {
        throw new Error('No compatible update asset found')
      }
      const { name, size, browser_download_url: url } = releaseInfo
      if (basename(name) !== name || win32.basename(name) !== name ||
          /[<>:"/\\|?*]/.test(name) || /[. ]$/.test(name) ||
          Array.from(name).some(char => char.charCodeAt(0) < 32)) {
        throw new Error('Invalid update asset filename')
      }
      if (!Number.isSafeInteger(size) || size <= 0) {
        throw new Error('Invalid update asset size')
      }
      const remotePath = getUrl(url, mirror)
      const parsedUrl = new URL(remotePath)
      if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
        throw new Error('Invalid update asset URL')
      }
      this.dir = await fs.promises.mkdtemp(resolve(tempDir, 'anubis-upgrade-'))
      this.localPath = resolve(this.dir, name)
      const response = await rp({
        url: remotePath,
        httpAgent: agent,
        httpsAgent: agent,
        responseType: 'stream',
        timeout: 15000,
        signal
      })
      this.readSteam = response.data
      this.writeSteam = fs.createWriteStream(this.localPath, { flags: 'wx' })
      let count = 0
      this.onData = _.throttle(() => {
        if (!this.onDestroy) {
          this.ws.s({
            id: 'upgrade:data:' + this.id,
            data: Math.min(99, Math.floor(count * 100 / size))
          })
        }
      }, 1000, { trailing: false })
      const meter = new Transform({
        transform: (chunk, encoding, callback) => {
          count += chunk.length
          if (count > size) {
            callback(new Error('Update download exceeds expected size'))
            return
          }
          this.onData()
          if (this.pausing) {
            this.continueDownload = () => callback(null, chunk)
          } else {
            callback(null, chunk)
          }
        }
      })
      await pipeline(this.readSteam, meter, this.writeSteam, { signal })
      if (count !== size || (await fs.promises.stat(this.localPath)).size !== size) {
        throw new Error('Update download size mismatch')
      }
      await this.onEnd()
    } catch (err) {
      if (!this.onDestroy) {
        this.onError(err)
      }
    } finally {
      this.continueDownload = null
      globalState.removeUpgradeInst(this.id)
      if (this.dir && !this.launched) {
        await rmrf(this.dir).catch(log.error)
      }
    }
  }

  async onEnd () {
    if (!this.onDestroy) {
      const windowsInstaller = isWin && installSrc.endsWith('-installer.exe')
      if (windowsInstaller) {
        await launchWindowsInstaller(this.localPath)
      } else {
        await openFile(this.localPath)
      }
      this.launched = true
      if (this.onDestroy) {
        return
      }
      if (process.send) {
        process.send({
          showFileInFolder: this.localPath
        })
      }
      this.ws.s({
        id: 'upgrade:end:' + this.id,
        data: this.dir
      })
      if (windowsInstaller && process.send) {
        process.send({ upgradeInstallerLaunched: true })
      }
    }
  }

  onError (err) {
    this.ws.s({
      id: 'upgrade:err:' + this.id,
      error: {
        message: err.message,
        stack: err.stack
      }
    })
  }

  pause () {
    this.pausing = true
  }

  resume () {
    this.pausing = false
    const next = this.continueDownload
    this.continueDownload = null
    next && next()
  }

  destroy () {
    if (this.onDestroy) {
      return
    }
    this.onDestroy = true
    this.controller.abort()
    globalState.removeUpgradeInst(this.id)
    this.ws.close()
  }

  // end
}

exports.Upgrade = Upgrade
