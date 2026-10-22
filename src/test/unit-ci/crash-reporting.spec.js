const { describe, it, before, after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const { ensureInstallId } = require('../../app/common/install-id')

describe('management reports and installation identity', () => {
  let dir
  let server
  let reporter
  let status = 200
  let acknowledgment = { ok: true, id: 'report-1' }
  let reports = []
  const warnings = []
  const previous = {}
  const originalModules = new Map()

  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anubis-reports-'))
    server = http.createServer((req, res) => {
      let body = ''
      req.on('data', chunk => { body += chunk })
      req.on('end', () => {
        reports.push(JSON.parse(body))
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(acknowledgment))
      })
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    for (const key of ['ANUBIS_ADMIN_ERROR_REPORT', 'ANUBIS_ADMIN_ERROR_REPORT_URL']) {
      previous[key] = process.env[key]
    }
    process.env.ANUBIS_ADMIN_ERROR_REPORT = '1'
    process.env.ANUBIS_ADMIN_ERROR_REPORT_URL = `http://127.0.0.1:${server.address().port}/api/report`
    const mocks = {
      electron: { app: { getVersion: () => '5.6.10', getPath: () => dir } },
      '../../app/common/log': {
        error: () => {},
        warn: (...args) => warnings.push(args.join(' '))
      }
    }
    for (const [name, exports] of Object.entries(mocks)) {
      const id = require.resolve(name)
      originalModules.set(id, require.cache[id])
      require.cache[id] = { id, filename: id, loaded: true, exports }
    }
    reporter = require('../../app/lib/crash-reporter')
  })

  after(async () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    for (const [id, value] of originalModules) {
      if (value === undefined) delete require.cache[id]
      else require.cache[id] = value
    }
    if (server) await new Promise(resolve => server.close(resolve))
    if (dir) fs.rmSync(dir, { recursive: true, force: true })
  })

  it('persists the same UUID without replacing an existing identity', () => {
    const id = ensureInstallId(dir)
    assert.match(id, /^[0-9a-f-]{36}$/)
    assert.equal(ensureInstallId(dir), id)
  })

  it('rejects corrupt identities instead of silently replacing them', () => {
    const corrupt = path.join(dir, 'corrupt')
    fs.mkdirSync(corrupt)
    fs.writeFileSync(path.join(corrupt, 'install-id'), 'bad')
    assert.throws(() => ensureInstallId(corrupt), /Invalid installation id/)
    assert.equal(fs.readFileSync(path.join(corrupt, 'install-id'), 'utf8'), 'bad')
  })

  it('does not create a success-shaped identity when persistence fails', () => {
    const blocked = path.join(dir, 'not-a-directory')
    fs.writeFileSync(blocked, '')
    assert.throws(() => ensureInstallId(blocked), error => ['ENOTDIR', 'EEXIST'].includes(error.code))
  })

  it('sends heartbeat and bounded error fields with the same persisted UUID', async () => {
    reports = []
    assert.deepEqual(await reporter.sendInstallHeartbeat(), acknowledgment)
    const error = new Error('x'.repeat(2500))
    error.stack = 's'.repeat(9000)
    assert.deepEqual(await reporter.sendErrorReport(error), acknowledgment)
    assert.equal(reports.length, 2)
    assert.equal(reports[0].type, 'heartbeat')
    assert.equal(reports[0].message, undefined)
    assert.equal(reports[1].type, 'error')
    assert.equal(reports[1].message.length, 2000)
    assert.equal(reports[1].stack.length, 8000)
    assert.equal(reports[0].installId, reports[1].installId)
    assert.equal(reports[0].version, '5.6.10')
  })

  it('logs rejected and malformed acknowledgments instead of ignoring them', async () => {
    warnings.length = 0
    status = 503
    assert.equal(await reporter.sendInstallHeartbeat(), undefined)
    assert.match(warnings.at(-1), /HTTP 503/)
    status = 200
    acknowledgment = { ok: false }
    assert.equal(await reporter.sendInstallHeartbeat(), undefined)
    assert.match(warnings.at(-1), /invalid report acknowledgment/)
    acknowledgment = { ok: true, id: 'report-1' }
  })

  it('does not transmit reports when the administrator disables reporting', async () => {
    process.env.ANUBIS_ADMIN_ERROR_REPORT = '0'
    const count = reports.length
    await reporter.sendInstallHeartbeat()
    assert.equal(reports.length, count)
    process.env.ANUBIS_ADMIN_ERROR_REPORT = '1'
  })
})
