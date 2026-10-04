const test = require('node:test')
const assert = require('node:assert/strict')
const { createBoundary } = require('../examples/integrations/json-schema')

test('schema gate rejects coercion, missing fields and additional properties without changing diagnostics', async () => {
  const boundary = createBoundary()
  const context = { allowedEvidence: new Set(['E1']) }
  let first
  await assert.rejects(boundary.process('{"summary":42,"evidence_ids":["E1"]}', context), error => {
    first = error.details
    return error.stage === 'core' && first.errors[0].keyword === 'type'
  })
  await assert.rejects(boundary.process('{"summary":"ok"}', context), { stage: 'core' })
  assert.equal(first.errors[0].keyword, 'type')
  await assert.rejects(boundary.process('{"summary":"ok","evidence_ids":["E1"],"extra":true}', context), { stage: 'core' })
  await assert.rejects(boundary.process('{"summary":"   ","evidence_ids":["E1"]}', context), { stage: 'core' })
})

test('valid schema still fails audit for unknown evidence', async () => {
  const boundary = createBoundary()
  const context = { allowedEvidence: new Set(['E1']) }
  await assert.rejects(boundary.process('{"summary":"ok","evidence_ids":["E9"]}', context), { stage: 'audit' })
  const result = await boundary.process('{"summary":"ok","evidence_ids":["E1"]}', context)
  assert.equal(result.accepted, true)
})
