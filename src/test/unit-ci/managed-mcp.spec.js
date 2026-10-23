const { test } = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const { once } = require('node:events')
const express = require('express')
const { createManagedMcpProxy } = require('../../app/server/managed-mcp')
const { HEADER } = require('../../app/server/managed-browser')

test('managed MCP streams to the actual local endpoint without exposing or accepting its token', async t => {
  const localToken = 'a'.repeat(64)
  const calls = []
  const upstream = http.createServer((req, res) => {
    calls.push({ method: req.method, headers: req.headers, chunks: [] })
    const current = calls.at(-1)
    req.on('data', chunk => current.chunks.push(chunk))
    req.on('end', () => {
      if (req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'mcp-session-id': 'native-session' })
        res.write('event: message\ndata: first\n\n')
        setTimeout(() => res.end('event: message\ndata: second\n\n'), 50)
      } else {
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'mcp-session-id': 'native-session' })
        res.end(Buffer.concat(current.chunks))
      }
    })
  })
  upstream.listen(0, '127.0.0.1')
  await once(upstream, 'listening')
  t.after(() => new Promise(resolve => upstream.close(resolve)))
  let disabled = false
  const app = express()
  app.all('/mcp', createManagedMcpProxy({
    secret: 'transport-secret',
    log: { warn () {} },
    rpc: async func => {
      assert.equal(func, 'managedMcpEndpoint')
      if (disabled) throw new Error('disabled')
      return { host: '127.0.0.1', port: upstream.address().port, token: localToken }
    }
  }))
  app.use(express.json())
  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise(resolve => server.close(resolve)))
  const origin = `http://127.0.0.1:${server.address().port}/mcp`
  assert.equal((await fetch(origin)).status, 403)
  const headers = {
    [HEADER]: 'transport-secret',
    authorization: 'Bearer remote-scoped-grant',
    'mcp-session-id': 'native-session',
    'content-type': 'application/octet-stream'
  }
  const payload = Buffer.alloc(512 * 1024)
  assert.equal((await fetch(origin, {
    headers: { ...headers, 'x-anubis-managed-context': 'b'.repeat(32) }
  })).status, 403)
  assert.equal(calls.length, 0)
  for (let i = 0; i < payload.length; i++) payload[i] = i % 256
  const post = await fetch(origin, { method: 'POST', headers, body: payload })
  assert.equal(post.status, 200)
  assert.equal(post.headers.get('mcp-session-id'), 'native-session')
  assert.equal(post.headers.get('connection'), 'close')
  assert.deepEqual(Buffer.from(await post.arrayBuffer()), payload)
  assert.equal(calls[0].headers.authorization, `Bearer ${localToken}`)
  assert.equal(calls[0].headers[HEADER], undefined)
  const sse = await fetch(origin, { headers: { ...headers, accept: 'text/event-stream' } })
  const reader = sse.body.getReader()
  const first = await reader.read()
  assert.match(Buffer.from(first.value).toString(), /data: first/)
  let rest = ''
  while (true) {
    const chunk = await reader.read()
    if (chunk.done) break
    rest += Buffer.from(chunk.value).toString()
  }
  assert.match(rest, /data: second/)
  assert.ok(!(JSON.stringify([...sse.headers]) + rest).includes(localToken))
  const deletion = await fetch(origin, { method: 'DELETE', headers })
  assert.equal(deletion.status, 200)
  await deletion.arrayBuffer()
  assert.equal(calls.at(-1).method, 'DELETE')
  disabled = true
  assert.equal((await fetch(origin, { headers })).status, 503)
})
