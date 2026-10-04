'use strict'
const assert = require('node:assert/strict')
// Exercise this checkout rather than an older installed npm release.
const { OutputBoundary, LoopControl, CollectiveControl } = require('../../../src')

async function runControlledCollective({ responses = defaultResponses(), selectedId = 'seat-a' } = {}) {
  const evidence = new Set(['E1', 'E2'])
  const boundary = new OutputBoundary({
    recover: raw => JSON.parse(raw),
    adapt: value => value,
    validateCore: value => value !== null && typeof value === 'object' &&
      typeof value.id === 'string' && ['expand', 'maintain', 'contract'].includes(value.direction) &&
      Array.isArray(value.evidence_ids) && value.evidence_ids.length > 0,
    validateAudit: value => value.evidence_ids.every(id => evidence.has(id))
  })
  const accepted = []
  const trace = []
  // The host owns scheduling; each seat has a separate revision budget.
  for (const [seatId, outputs] of Object.entries(responses)) {
    const loop = new LoopControl({ kind: 'constraint_revision', maxAttempts: 2, maxNoProgress: 2 })
    for (const raw of outputs) {
      if (loop.status !== 'active') break
      try {
        const result = await boundary.process(raw)
        if (result.value.id !== seatId) throw new Error('Seat identity mismatch')
        accepted.push(result.value)
        trace.push({ seat: seatId, accepted: true, preceding_revisions: loop.attempts })
        break
      } catch (error) {
        trace.push({ seat: seatId, accepted: false, stage: error.stage || 'carrier', ...loop.record({ progressed: false }) })
      }
    }
  }
  const collective = new CollectiveControl({ quorum: 2 })
  const pool = collective.freezeCandidates(accepted)
  const decision = collective.select(pool, selectedId)
  return { decision, pool, trace }
}

function defaultResponses() {
  return {
    'seat-a': ['{"id":"seat-a","direction":"expand","evidence_ids":["unknown"]}', '{"id":"seat-a","direction":"expand","evidence_ids":["E1"]}'],
    'seat-b': ['{"id":"seat-b","direction":"maintain","evidence_ids":["E2"]}'],
    'seat-c': ['broken JSON', '{"id":"seat-c"}', '{"id":"seat-c","direction":"contract","evidence_ids":["E1"]}']
  }
}

async function demonstrate() {
  const result = await runControlledCollective()
  assert.equal(result.pool.length, 2)
  assert.equal(result.trace.filter(row => row.seat === 'seat-c').length, 2)
  assert.equal(result.trace.at(-1).status, 'human_handoff')
  assert.equal(result.decision.id, 'seat-a')
  assert.ok(Object.isFrozen(result.decision.evidence_ids))
  await assert.rejects(runControlledCollective({ selectedId: 'invented' }), { code: 'UNKNOWN_CANDIDATE' })
  console.log(JSON.stringify({ synthetic: true, ...result }, null, 2))
}

if (require.main === module) demonstrate().catch(error => { console.error(error); process.exitCode = 1 })
module.exports = { runControlledCollective, defaultResponses }
