#!/usr/bin/env node
'use strict'

const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

function json (res, status, body) {
  const data = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS'
  })
  res.end(data)
}

function readBody (req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', chunk => {
      size += chunk.length
      if (size > 1024 * 1024) {
        chunks.length = 0
        reject(Object.assign(new Error('payload too large'), { status: 413 }))
      } else {
        chunks.push(chunk)
      }
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function createServer ({
  dataDir = process.env.DATA_DIR || '/var/lib/anubis-mgmt',
  adminToken = process.env.ADMIN_TOKEN || ''
} = {}) {
  const dashboard = fs.readFileSync(path.join(__dirname, 'management-dashboard.html'), 'utf8').replace(/\r\n?/g, '\n')
  const hashes = tag => [...dashboard.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g'))]
    .map(match => `'sha256-${crypto.createHash('sha256').update(match[1]).digest('base64')}'`)
    .join(' ')
  const dashboardPolicy = [
    "default-src 'none'",
    `script-src ${hashes('script')}`,
    `style-src ${hashes('style')}`,
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'"
  ].join('; ')
  fs.mkdirSync(dataDir, { recursive: true })
  const reportsFile = path.join(dataDir, 'reports.jsonl')
  fs.closeSync(fs.openSync(reportsFile, 'a', 0o600))
  const expectedAuth = Buffer.from(`Bearer ${adminToken}`)
  function isAdmin (req) {
    const actualAuth = Buffer.from(req.headers.authorization || '')
    return !!adminToken && expectedAuth.length === actualAuth.length &&
      crypto.timingSafeEqual(expectedAuth, actualAuth)
  }
  function reports () {
    return fs.readFileSync(reportsFile, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
  }
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost')
      const route = url.pathname
      if (req.method === 'OPTIONS') return json(res, 204, {})
      if (req.method === 'GET' && ['/admin', '/admin/'].includes(route)) {
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Length': Buffer.byteLength(dashboard),
          'Cache-Control': 'no-store',
          'Content-Security-Policy': dashboardPolicy,
          'X-Content-Type-Options': 'nosniff',
          'Referrer-Policy': 'no-referrer'
        })
        return res.end(dashboard)
      }
      if (req.method === 'GET' && (route === '/' || route === '/health')) {
        return json(res, 200, { status: 'ok', service: 'anubis-mgmt-api' })
      }
      if (route === '/api/report' && req.method === 'POST') {
        let payload
        try {
          payload = JSON.parse(await readBody(req))
        } catch (error) {
          return json(res, error.status || 400, { error: error.status === 413 ? error.message : 'invalid json' })
        }
        if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
            typeof payload.installId !== 'string' || !payload.installId.trim() || payload.installId.length > 128) {
          return json(res, 400, { error: 'installId required (nonempty string, at most 128 characters)' })
        }
        const entry = {
          id: crypto.randomBytes(8).toString('hex'),
          installId: payload.installId,
          type: String(payload.type || 'heartbeat').slice(0, 128),
          app: String(payload.app || 'unknown').slice(0, 256),
          version: String(payload.version || '').slice(0, 128),
          platform: String(payload.platform || '').slice(0, 128),
          arch: String(payload.arch || '').slice(0, 128),
          message: payload.message ? String(payload.message).slice(0, 4000) : '',
          stack: payload.stack ? String(payload.stack).slice(0, 8000) : '',
          meta: payload.meta && typeof payload.meta === 'object' && !Array.isArray(payload.meta) ? payload.meta : {},
          ip: req.socket.remoteAddress,
          receivedAt: Date.now()
        }
        fs.appendFileSync(reportsFile, JSON.stringify(entry) + '\n')
        return json(res, 200, { ok: true, id: entry.id })
      }
      if (req.method === 'GET' && ['/api/installs', '/api/reports'].includes(route)) {
        if (!isAdmin(req)) return json(res, 401, { error: 'unauthorized' })
        const all = reports().reverse().sort((a, b) => b.receivedAt - a.receivedAt)
        if (route === '/api/installs') {
          const latest = new Map()
          for (const report of all) {
            if (!latest.has(report.installId)) latest.set(report.installId, report)
          }
          return json(res, 200, { installs: [...latest.values()] })
        }
        const value = url.searchParams.get('limit')
        const limit = value === null ? 200 : Number(value)
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 2000) {
          return json(res, 400, { error: 'limit must be an integer between 1 and 2000' })
        }
        const installId = url.searchParams.get('installId')
        if (installId !== null && (!installId.trim() || installId.length > 128)) {
          return json(res, 400, { error: 'installId must be a nonempty string of at most 128 characters' })
        }
        const matching = installId === null ? all : all.filter(report => report.installId === installId)
        return json(res, 200, { reports: matching.slice(0, limit) })
      }
      return json(res, 404, { error: 'not found' })
    } catch (error) {
      console.error('anubis-mgmt-api request failed:', error)
      if (!res.headersSent) return json(res, 500, { error: 'report storage unavailable' })
      res.destroy(error)
    }
  })
}

if (require.main === module) {
  if (!process.env.ADMIN_TOKEN) console.error('ADMIN_TOKEN is not configured; administrative read endpoints are disabled')
  const port = process.env.PORT || 7106
  createServer().listen(port, '127.0.0.1', () => {
    console.log(`anubis-mgmt-api listening on 127.0.0.1:${port}`)
  })
}

module.exports = { createServer }
