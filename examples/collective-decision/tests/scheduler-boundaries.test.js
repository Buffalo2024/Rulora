const test = require('node:test')
const assert = require('node:assert/strict')
const { GlobalProviderScheduler, applySchedulerConcurrency } = require('../src/global-provider-scheduler')

test('partial patches retain omitted limits and reject unlimited values atomically', () => {
  const s = new GlobalProviderScheduler()
  applySchedulerConcurrency(s, { maximumConcurrent: 2, maximumConcurrentPerProfile: undefined })
  assert.equal(s.maximumConcurrent, 2)
  assert.equal(s.maximumConcurrentPerProfile, 1)
  applySchedulerConcurrency(s, { maximumConcurrent: undefined, maximumConcurrentPerProfile: 2 })
  assert.equal(s.maximumConcurrent, 2)
  for (const value of [null, Infinity, 0, -1]) {
    assert.throws(() => applySchedulerConcurrency(s, { maximumConcurrent: 4, maximumConcurrentPerProfile: value }))
    assert.equal(s.maximumConcurrent, 2)
    assert.equal(s.maximumConcurrentPerProfile, 2)
  }
})

test('queued cancellation preserves the running request and other owners', async () => {
  const s = new GlobalProviderScheduler({ maximumConcurrent: 1 })
  let release
  const first = s.schedule('model', 'first', () => new Promise(resolve => { release = resolve }))
  const owner = new AbortController()
  let invoked = false
  const queued = s.schedule('model', 'queued', () => { invoked = true }, { signal: owner.signal })
  const rejected = assert.rejects(queued, { code: 'MODEL_API_CANCELLED' })
  owner.abort()
  await rejected
  assert.equal(invoked, false)
  assert.equal(s.active, 1)
  assert.equal(s.queue.length, 0)
  release()
  await first
  assert.equal(s.active, 0)
})

test('caller and resource failures do not open provider circuits', async () => {
  const s = new GlobalProviderScheduler({ circuitFailureThreshold: 1 })
  for (const code of ['MODEL_API_CANCELLED', 'MODEL_API_RESPONSE_TOO_LARGE', 'MODEL_API_BUDGET_EXHAUSTED']) {
    await assert.rejects(s.schedule('model', 'request', () => { throw Object.assign(new Error(code), { code }) }), { code })
    assert.equal(s.healthByProfile.size, 0)
    assert.equal(s.active, 0)
  }
})
