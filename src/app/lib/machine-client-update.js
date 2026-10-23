const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { Readable, Transform } = require('node:stream')
const { pipeline } = require('node:stream/promises')

const maxInstallerSize = 2 * 1024 ** 3
const errorCodes = new Set([
  'VERSION', 'URL', 'METADATA', 'COMPATIBILITY', 'INTEGRITY', 'DISABLED',
  'DOWNLOAD', 'PREPARE', 'LAUNCH', 'CLEANUP'
].map(code => 'ERR_HOST_UPDATE_' + code))

function updateError (code) {
  return Object.assign(new Error('Windows machine update could not be verified or started'), { code })
}

function versionParts (value) {
  const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value)
  if (!match || match.slice(1).some(value => !Number.isSafeInteger(Number(value)))) {
    throw updateError('ERR_HOST_UPDATE_VERSION')
  }
  return match.slice(1).map(Number)
}

function newerVersion (version, current) {
  const next = versionParts(version)
  const previous = versionParts(current.split('-')[0])
  for (let index = 0; index < 3; index++) {
    if (next[index] !== previous[index]) return next[index] > previous[index]
  }
  return false
}

function secureUrl (value, origin) {
  let url
  try { url = new URL(value) } catch { throw updateError('ERR_HOST_UPDATE_URL') }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash ||
      (origin && url.origin !== new URL(origin).origin)) {
    throw updateError('ERR_HOST_UPDATE_URL')
  }
  return url.href
}

function selectMachineUpdate (metadata, brand, currentVersion) {
  const release = metadata?.release
  if (!release || release.draft || release.prerelease || typeof release.tag_name !== 'string') {
    throw updateError('ERR_HOST_UPDATE_METADATA')
  }
  if (!newerVersion(release.tag_name, currentVersion)) return { available: false }
  const version = release.tag_name.replace(/^v/, '')
  const name = `${brand.id}-${version}-win-x64-installer.exe`
  const assets = Array.isArray(release.assets) && release.assets.filter(asset => asset?.name === name)
  if (!Array.isArray(assets) || assets.length !== 1 || assets[0].windows_machine_host !== 1) {
    throw updateError('ERR_HOST_UPDATE_COMPATIBILITY')
  }
  const asset = assets[0]
  if (!Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > maxInstallerSize ||
      !/^sha256:[a-f0-9]{64}$/i.test(asset.digest)) {
    throw updateError('ERR_HOST_UPDATE_INTEGRITY')
  }
  return {
    available: true,
    version,
    name,
    size: asset.size,
    sha256: asset.digest.slice(7).toLowerCase(),
    url: secureUrl(asset.browser_download_url, brand.domains.download)
  }
}

async function checkMachineUpdate (brand, version, fetcher = fetch) {
  if (!brand.update.enabled) throw updateError('ERR_HOST_UPDATE_DISABLED')
  let failure = updateError('ERR_HOST_UPDATE_METADATA')
  for (const base of brand.update.baseUrls) {
    try {
      const url = secureUrl(new URL(brand.update.releaseJson, base).href)
      const response = await fetcher(url, {
        redirect: 'error', signal: AbortSignal.timeout(15000), headers: { accept: 'application/json' }
      })
      if (!response.ok || !response.body) throw updateError('ERR_HOST_UPDATE_METADATA')
      const chunks = []
      let size = 0
      for await (const chunk of response.body) {
        size += chunk.length
        if (size > 1024 * 1024) throw updateError('ERR_HOST_UPDATE_METADATA')
        chunks.push(Buffer.from(chunk))
      }
      let metadata
      try { metadata = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch {
        throw updateError('ERR_HOST_UPDATE_METADATA')
      }
      return selectMachineUpdate(metadata, brand, version)
    } catch (error) {
      failure = errorCodes.has(error.code) ? error : updateError('ERR_HOST_UPDATE_METADATA')
    }
  }
  throw failure
}

async function installMachineUpdate (update, {
  tempDir, prepare, discard, launch, notify, signal, fetcher = fetch
}) {
  const dir = await fs.promises.mkdtemp(path.join(tempDir, 'anubis-machine-update-'))
  let phase = 'DOWNLOAD'
  let failure
  let protectedFile
  let cleaned = false
  try {
    const response = await fetcher(update.url, {
      redirect: 'error',
      signal: AbortSignal.any([signal, AbortSignal.timeout(300000)].filter(Boolean))
    })
    if (!response.ok || !response.body) throw updateError('ERR_HOST_UPDATE_DOWNLOAD')
    const file = path.join(dir, update.name)
    const hash = crypto.createHash('sha256')
    let size = 0
    let percent = -1
    const meter = new Transform({
      transform (chunk, _encoding, done) {
        size += chunk.length
        if (size > update.size) return done(updateError('ERR_HOST_UPDATE_INTEGRITY'))
        hash.update(chunk)
        const next = Math.min(99, Math.floor(size * 100 / update.size))
        if (next !== percent) {
          percent = next
          notify({ phase: 'download', percent })
        }
        done(null, chunk)
      }
    })
    await pipeline(Readable.fromWeb(response.body), meter, fs.createWriteStream(file, { flags: 'wx' }), { signal })
    if (size !== update.size || hash.digest('hex') !== update.sha256) {
      throw updateError('ERR_HOST_UPDATE_INTEGRITY')
    }
    signal?.throwIfAborted()
    phase = 'PREPARE'
    notify({ phase: 'prepare' })
    protectedFile = await prepare(file, update)
    signal?.throwIfAborted()
    phase = 'CLEANUP'
    await fs.promises.rm(dir, { recursive: true, force: true })
    cleaned = true
    phase = 'LAUNCH'
    notify({ phase: 'launch' })
    await launch(protectedFile)
  } catch (error) {
    failure = errorCodes.has(error.code) ? error : updateError('ERR_HOST_UPDATE_' + phase)
  }
  try {
    if (!cleaned) await fs.promises.rm(dir, { recursive: true, force: true })
    if (failure && protectedFile) await discard(protectedFile)
  } catch {
    throw updateError('ERR_HOST_UPDATE_CLEANUP')
  }
  if (failure) throw failure
}

module.exports = { checkMachineUpdate, selectMachineUpdate, installMachineUpdate }
