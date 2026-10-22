#!/usr/bin/env node
'use strict'

const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { publishUpdate } = require('./publish-update')

function createServer ({
  secret = process.env.ANUBIS_WEBHOOK_SECRET,
  route = process.env.ANUBIS_RELEASE_PATH,
  releaseFile = process.env.ANUBIS_RELEASE_JSON || '/var/lib/anubis-release/anubis-github-release.json',
  updateDir = process.env.ANUBIS_UPDATE_DIR || '/var/www/anubis/update'
} = {}) {
  if (!secret) throw new Error('ANUBIS_WEBHOOK_SECRET is required')
  if (!route || !route.startsWith('/github-anubis-api/')) throw new Error('ANUBIS_RELEASE_PATH must identify the release webhook')
  return http.createServer(async (req, res) => {
    const reply = (status, text) => {
      res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end(text)
    }
    const url = new URL(req.url, 'http://localhost')
    if (req.method === 'GET' && req.url === '/health') return reply(200, 'ok')
    if (req.method === 'GET' && ['/data/anubis-release.json', '/data/anubis-github-release.json'].includes(url.pathname)) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(updateDir, 'data', path.basename(url.pathname)), 'utf8'))
        const src = url.searchParams.get('src')
        if (src) {
          const key = asset => asset.name.replace(/-v?\d+\.\d+\.\d+/, '').replace(/^anubis-/, '')
          const stem = name => name.replace(/(\.tar\.gz|\.tar\.xz|\.[A-Za-z0-9]+)$/, '')
          const assets = data.release.assets.filter(asset => src.includes('.blockmap') || !asset.name.endsWith('.blockmap'))
          const tiers = [
            asset => asset.name === src,
            asset => key(asset) === src,
            asset => stem(key(asset)) === src,
            asset => asset.name.endsWith(src)
          ]
          data.release.assets = []
          for (const match of tiers) {
            const matches = assets.filter(match)
            if (matches.length) {
              data.release.assets = matches
              break
            }
          }
        }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
        return res.end(JSON.stringify(data))
      } catch (error) {
        console.error('Release metadata unavailable:', error)
        return reply(500, 'release metadata unavailable')
      }
    }
    if (req.method !== 'POST' || url.pathname !== route) return reply(404, 'not found')
    try {
      const body = await new Promise((resolve, reject) => {
        const chunks = []
        let bytes = 0
        req.on('data', chunk => {
          bytes += chunk.length
          if (bytes > 25 * 1024 * 1024) {
            chunks.length = 0
            reject(Object.assign(new Error('payload too large'), { status: 413 }))
          } else {
            chunks.push(chunk)
          }
        })
        req.on('end', () => resolve(Buffer.concat(chunks)))
        req.on('error', reject)
      })
      const signature = req.headers['x-hub-signature-256'] || ''
      const expected = crypto.createHmac('sha256', secret).update(body).digest()
      const supplied = /^sha256=[0-9a-f]{64}$/.test(signature) ? Buffer.from(signature.slice(7), 'hex') : Buffer.alloc(0)
      if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) return reply(401, 'invalid signature')
      let payload
      try {
        payload = JSON.parse(body)
      } catch (error) {
        return reply(400, 'invalid json')
      }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return reply(400, 'object required')
      if (payload.action !== 'published' || !payload.release || payload.release.draft || payload.release.prerelease) {
        return reply(200, 'no')
      }
      const temporary = releaseFile + '.' + crypto.randomBytes(8).toString('hex') + '.tmp'
      try {
        fs.mkdirSync(path.dirname(releaseFile), { recursive: true })
        fs.writeFileSync(temporary, body, { flag: 'wx', mode: 0o600 })
        fs.renameSync(temporary, releaseFile)
        publishUpdate(releaseFile, updateDir)
      } finally {
        if (fs.existsSync(temporary)) fs.unlinkSync(temporary)
      }
      reply(200, 'ok')
    } catch (error) {
      if (error.status === 413) return reply(413, 'payload too large')
      console.error('Release publication failed:', error)
      if (!res.headersSent) return reply(500, 'publication failed')
      res.destroy(error)
    }
  })
}

if (require.main === module) {
  const port = process.env.PORT || 7102
  createServer().listen(port, '127.0.0.1', () => {
    console.log(`anubis-release-api listening on 127.0.0.1:${port}`)
  })
}

module.exports = { createServer }
