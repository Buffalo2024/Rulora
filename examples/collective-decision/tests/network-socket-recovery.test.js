'use strict'
// Synthetic transport only. No private provider configuration or real requests.
const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const { requestWithRetry } = require('../src/providers/multi-model-provider')
const { createModelFetch } = require('../src/model-http')
const options = { url: 'https://example.invalid/v1/chat/completions', init: { method: 'POST' }, timeoutMs: 500, maxRetries: 1, delayImpl: async () => {} }
const disconnected = (code = 'UND_ERR_SOCKET', message = 'terminated') => Object.assign(new TypeError(message), { cause: { code } })
function brokenBody() {
  let reads = 0
  return new Response(new ReadableStream({ pull(controller) {
    if (reads++ === 0) controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'))
    else controller.error(disconnected())
  } }), { headers: { 'content-type': 'text/event-stream' } })
}

for (const requestPolicy of [null, { mode: 'liveness', stream: true }]) {
  const label = requestPolicy ? 'liveness' : 'deadline'
  test(`${label}: interrupted body retries and never returns partial output`, async () => {
    let calls = 0
    const r = await requestWithRetry({ ...options, requestPolicy, fetchImpl: async () => ++calls === 1 ? brokenBody() : new Response('{"ok":true}') })
    assert.equal(calls, 2)
    assert.equal(await r.text(), '{"ok":true}')
    assert.equal(r.transport_diagnostics[0].network_cause_code, 'UND_ERR_SOCKET')
  })
  test(`${label}: repeated disconnect ends at the retry limit`, async () => {
    let calls = 0
    await assert.rejects(requestWithRetry({ ...options, requestPolicy, fetchImpl: async () => { calls++; return brokenBody() } }), e => {
      assert.equal(e.code, 'MODEL_API_NETWORK_FAILURE')
      assert.equal(e.retryable, true)
      assert.equal(e.connection_attempts, 2)
      return true
    })
    assert.equal(calls, 2)
  })
}

test('transient cause codes retry without relying on message text', async () => {
  for (const code of ['UND_ERR_SOCKET', 'ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'EHOSTUNREACH', 'ENETUNREACH', 'ENETDOWN', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN']) {
    let calls = 0
    await assert.rejects(requestWithRetry({ ...options, fetchImpl: async () => { calls++; throw disconnected(code) } }), e => e.retryable === true)
    assert.equal(calls, 2, code)
  }
})
test('TLS and invalid configuration are not retried', async () => {
  for (const code of ['CERT_HAS_EXPIRED', 'ERR_INVALID_URL']) {
    let calls = 0
    await assert.rejects(requestWithRetry({ ...options, fetchImpl: async () => { calls++; throw disconnected(code) } }), e => e.retryable === false)
    assert.equal(calls, 1)
  }
})
test('authentication and permission failures are not retried', async () => {
  for (const status of [401, 403]) {
    let calls = 0
    await assert.rejects(requestWithRetry({ ...options, fetchImpl: async () => { calls++; return new Response('{}', { status }) } }), e => e.http_status === status && !e.retryable)
    assert.equal(calls, 1)
  }
})
test('liveness: already cancelled request never reaches the provider', async () => {
  const owner = new AbortController(); owner.abort(); let calls = 0
  await assert.rejects(requestWithRetry({ ...options, init: { ...options.init, signal: owner.signal }, requestPolicy: { mode: 'liveness' }, fetchImpl: async () => { calls++; return new Response('{}') } }), { code: 'MODEL_API_CANCELLED' })
  assert.equal(calls, 0)
})
test('liveness: caller cancellation wins over a simultaneous socket failure', async () => {
  const owner = new AbortController(); let calls = 0
  await assert.rejects(requestWithRetry({ ...options, init: { ...options.init, signal: owner.signal }, requestPolicy: { mode: 'liveness' }, fetchImpl: async () => { calls++; owner.abort(); throw disconnected() } }), { code: 'MODEL_API_CANCELLED' })
  assert.equal(calls, 1)
})
test('a response that fails post-read inspection cannot enter the success branch', async () => {
  let calls = 0
  const invalid = { ok: true, status: 200, headers: { get(name) {
    if (name === 'content-type') throw disconnected('UND_ERR_SOCKET', 'fetch failed')
    return null
  } }, text: async () => '{"stale":true}' }
  const r = await requestWithRetry({ ...options, fetchImpl: async () => ++calls === 1 ? invalid : new Response('{"ok":true}') })
  assert.equal(calls, 2)
  assert.equal(await r.text(), '{"ok":true}')
})
test('liveness: an incomplete SSE response fails closed within the retry budget', async () => {
  let calls = 0
  await assert.rejects(requestWithRetry({ ...options, requestPolicy: { mode: 'liveness' }, fetchImpl: async () => {
    calls++; return new Response('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n', { headers: { 'content-type': 'text/event-stream' } })
  } }), e => e.code === 'MODEL_API_NETWORK_FAILURE' && e.connection_attempts === 2)
  assert.equal(calls, 2)
})
test('liveness: successful peer request remains independent of a cancelled owner', async () => {
  const owner = new AbortController()
  let peerCalls = 0
  const cancelled = requestWithRetry({ ...options, init: { ...options.init, signal: owner.signal }, requestPolicy: { mode: 'liveness' }, fetchImpl: async () => { owner.abort(); throw disconnected() } })
  const peer = requestWithRetry({ ...options, requestPolicy: { mode: 'liveness' }, fetchImpl: async () => { peerCalls++; return new Response('{"peer":true}') } })
  const results = await Promise.allSettled([cancelled, peer])
  assert.equal(results[0].status, 'rejected')
  assert.equal(results[0].reason.code, 'MODEL_API_CANCELLED')
  assert.equal(results[1].status, 'fulfilled')
  assert.equal(await results[1].value.text(), '{"peer":true}')
  assert.equal(peerCalls, 1)
})

// Exercise the actual HTTP client and a real interrupted TCP socket on loopback.
// This is not a live model-service test.
for (const requestPolicy of [null, { mode: 'liveness', stream: true }]) {
  test(`${requestPolicy ? 'liveness' : 'deadline'}: real local socket disconnect recovers without partial output`, async t => {
    let calls = 0
    const server = http.createServer((req, res) => {
      req.resume()
      if (++calls === 1) {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n')
        setTimeout(() => res.destroy(), 20)
      } else {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{"complete":true}')
      }
    })
    const fetchImpl = createModelFetch()
    t.after(async () => {
      await fetchImpl.close()
      server.closeAllConnections()
      await new Promise(resolve => server.close(resolve))
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const r = await requestWithRetry({ ...options, timeoutMs: 2000, requestPolicy, fetchImpl, url: `http://127.0.0.1:${server.address().port}/v1/chat/completions` })
    assert.equal(calls, 2)
    assert.deepEqual(await r.json(), { complete: true })
    assert.equal(r.transport_diagnostics[0].network_cause_code, 'UND_ERR_SOCKET')
  })
}
