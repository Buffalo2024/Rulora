const test = require('node:test')
const assert = require('node:assert/strict')
const { runControlledCollective } = require('../examples/controlled-collective')

test('revisions reject unknown evidence and stop a seat before its third response', async () => {
  const result = await runControlledCollective()
  assert.deepEqual(result.pool.map(value => value.id), ['seat-a', 'seat-b'])
  assert.equal(result.trace[0].stage, 'audit')
  assert.equal(result.trace.at(-1).status, 'human_handoff')
  assert.ok(Object.isFrozen(result.decision.evidence_ids))
})

test('reviewer cannot invent candidates and insufficient accepted seats cannot deliver', async () => {
  await assert.rejects(runControlledCollective({ selectedId: 'new-answer' }), { code: 'UNKNOWN_CANDIDATE' })
  await assert.rejects(runControlledCollective({ responses: { a: ['broken'] } }), { code: 'QUORUM_NOT_MET' })
})
