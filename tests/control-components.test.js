'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { LoopControl, OutputBoundary, CollectiveControl } = require('../src')

test('loop control stops repeated no-progress attempts', () => {
  const loop = new LoopControl({ kind: 'constraint_revision', maxAttempts: 5, maxNoProgress: 2 })
  assert.equal(loop.snapshot().kind, 'constraint_revision')
  assert.equal(loop.record({ progressed: false }).status, 'active')
  assert.equal(loop.record({ progressed: false }).status, 'human_handoff')
})

test('loop types are explicit and each receives an independent hard budget', () => {
  const network = new LoopControl({ kind: 'network_reconnect', maxAttempts: 1 })
  const broadcast = new LoopControl({ kind: 'business_broadcast', maxAttempts: 2 })
  assert.equal(network.record({ progressed: true }).status, 'exhausted')
  assert.equal(broadcast.record({ progressed: true }).status, 'active')
  assert.throws(() => new LoopControl({ kind: 'unbounded' }), /kind must be/)
})

test('output boundary applies recovery, adaptation and both contracts', async () => {
  const boundary = new OutputBoundary({
    recover: raw => JSON.parse(raw),
    adapt: value => ({ answer: Number(value.answer) }),
    validateCore: value => Number.isFinite(value.answer) || ['answer must be numeric'],
    validateAudit: value => value.answer >= 0 || ['answer must be non-negative']
  })
  assert.deepEqual(await boundary.process('{"answer":"2"}'), { value: { answer: 2 }, accepted: true })
  await assert.rejects(() => boundary.process('{"answer":"-1"}'), error => error.stage === 'audit')
})

test('collective reviewer can only select from a quorum-approved frozen pool', () => {
  const control = new CollectiveControl({ quorum: 2 })
  const pool = control.freezeCandidates([{ id: 'a', value: 0 }, { id: 'b', value: 1 }])
  assert.equal(control.select(pool, 'b').value, 1)
  assert.throws(() => control.select(pool, 'x'), /frozen pool/)
})
