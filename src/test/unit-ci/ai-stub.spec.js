const { describe, it, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { createServer, STUB_REPLY } = require('../../../services/ai-stub')
const { createStreamParser } = require('../../app/lib/ai-format')

describe('hosted AI placeholder protocol', () => {
  let server
  let base

  before(async () => {
    server = createServer()
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${server.address().port}/api/ai`
  })
  after(async () => {
    await new Promise(resolve => server.close(resolve))
  })

  const request = (endpoint, body) => fetch(base + endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000)
  })

  it('returns the explicit placeholder through ordinary OpenAI requests', async () => {
    const response = await request('/chat/completions', { model: 'anubis-stub', stream: false })
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.choices[0].message.content, STUB_REPLY)
    assert.equal(body.choices[0].finish_reason, 'stop')
  })

  for (const [endpoint, format] of [['/chat/completions', 'openai-chat'], ['/messages', 'anthropic']]) {
    it(`finishes ${format} SSE with content understood by the desktop parser`, async () => {
      const response = await request(endpoint, { model: 'anubis-stub', stream: true })
      assert.equal(response.status, 200)
      assert.match(response.headers.get('content-type'), /^text\/event-stream/)
      const text = await response.text()
      const parser = createStreamParser(format)
      parser.feed(text)
      parser.flush()
      assert.equal(parser.content, STUB_REPLY)
      assert.equal(parser.completed, true)
      assert.ok(!parser.error)
      if (format === 'openai-chat') assert.match(text, /data: \[DONE\]/)
    })

    it(`rejects invalid JSON objects at ${endpoint}`, async () => {
      for (const body of [null, [], 'not an object']) {
        const response = await request(endpoint, body)
        assert.equal(response.status, 400)
      }
      const response = await fetch(base + endpoint, { method: 'POST', body: '{invalid' })
      assert.equal(response.status, 400)
    })
  }

  it('preserves non-streaming Anthropic responses and available model metadata', async () => {
    const response = await request('/messages', { stream: false })
    assert.equal((await response.json()).content[0].text, STUB_REPLY)
    const models = await fetch(base + '/models')
    assert.equal((await models.json()).data[0].id, 'anubis-stub')
  })
})
