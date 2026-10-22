#!/usr/bin/env node
// Anubis AI stub service.
// Serves an OpenAI-compatible surface so the desktop client (brand.ai.baseURL =
// https://ai.anubis.locker/api/ai) always gets a usable response while the
// real backend is not built yet. Replace the canned reply in `STUB_REPLY`
// once a real model is wired in.
'use strict'

const http = require('http')
const crypto = require('crypto')

const PORT = process.env.PORT || 7105
const STUB_REPLY = '\u0417\u0430\u0433\u043b\u0443\u0448\u043a\u0430'

function json (res, status, body) {
  const data = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS'
  })
  res.end(data)
}

function readBody (req) {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', chunk => {
      body += chunk
      if (body.length > 2 * 1024 * 1024) {
        reject(new Error('payload too large'))
        req.destroy()
      }
    })
    req.on('end', () => resolve(body))
    req.on('error', reject)
  })
}

function chatCompletion (model) {
  const now = Math.floor(Date.now() / 1000)
  return {
    id: 'chatcmpl-' + crypto.randomBytes(12).toString('hex'),
    object: 'chat.completion',
    created: now,
    model: model || 'anubis-stub',
    choices: [{
      index: 0,
      message: { role: 'assistant', content: STUB_REPLY },
      finish_reason: 'stop'
    }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
  }
}

function streamCompletion (res, completion, anthropic = false) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    'X-Accel-Buffering': 'no',
    'Access-Control-Allow-Origin': '*'
  })
  const send = (data, event) => {
    if (event) res.write(`event: ${event}\n`)
    res.write(`data: ${JSON.stringify(data)}\n\n`)
  }
  if (anthropic) {
    send({
      type: 'message_start',
      message: {
        id: completion.id,
        type: 'message',
        role: 'assistant',
        model: completion.model,
        content: [],
        stop_reason: null,
        usage: { input_tokens: 0, output_tokens: 0 }
      }
    }, 'message_start')
    send({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, 'content_block_start')
    send({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: STUB_REPLY } }, 'content_block_delta')
    send({ type: 'content_block_stop', index: 0 }, 'content_block_stop')
    send({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 0 } }, 'message_delta')
    send({ type: 'message_stop' }, 'message_stop')
  } else {
    const chunk = { ...completion, object: 'chat.completion.chunk' }
    delete chunk.usage
    send({ ...chunk, choices: [{ index: 0, delta: { role: 'assistant', content: STUB_REPLY }, finish_reason: null }] })
    send({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
    res.write('data: [DONE]\n\n')
  }
  res.end()
}

function createServer () {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    const path = url.pathname.replace(/^\/api\/ai/, '') || '/'

    if (req.method === 'OPTIONS') {
      return json(res, 204, {})
    }

    if (path === '/health' || path === '/') {
      return json(res, 200, { status: 'ok', service: 'anubis-ai-stub' })
    }

    // OpenAI-compatible chat completions (also covers Anthropic-style /messages,
    // normalized to the same stub reply shape the client already understands
    // via its openai-chat parser fallback).
    if (path === '/chat/completions' && req.method === 'POST') {
      let payload
      try {
        payload = JSON.parse(await readBody(req) || '{}')
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('object required')
      } catch (e) {
        return json(res, 400, { error: 'invalid JSON request' })
      }
      const completion = chatCompletion(payload.model)
      if (payload.stream === true) return streamCompletion(res, completion)
      return json(res, 200, completion)
    }

    if (path === '/messages' && req.method === 'POST') {
      let payload
      try {
        payload = JSON.parse(await readBody(req) || '{}')
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('object required')
      } catch (e) {
        return json(res, 400, { error: 'invalid JSON request' })
      }
      if (payload.stream === true) return streamCompletion(res, chatCompletion(payload.model), true)
      return json(res, 200, {
        id: 'msg-' + crypto.randomBytes(12).toString('hex'),
        type: 'message',
        role: 'assistant',
        model: payload.model || 'anubis-stub',
        content: [{ type: 'text', text: STUB_REPLY }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 0, output_tokens: 0 }
      })
    }

    if (path === '/models' && req.method === 'GET') {
      return json(res, 200, {
        object: 'list',
        data: [{ id: 'anubis-stub', object: 'model', owned_by: 'anubis-security-tool' }]
      })
    }

    return json(res, 404, { error: 'not found' })
  })
}

if (require.main === module) {
  createServer().listen(PORT, '127.0.0.1', () => {
    console.log(`anubis-ai-stub listening on 127.0.0.1:${PORT}`)
  })
}

module.exports = { createServer, STUB_REPLY }
