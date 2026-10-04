'use strict'
const assert = require('node:assert/strict')
const Ajv = require('ajv')
const { OutputBoundary } = require('../../src')

const schema = {
  type: 'object', additionalProperties: false,
  required: ['summary', 'evidence_ids'],
  properties: {
    summary: { type: 'string', minLength: 1, pattern: '\\S' },
    evidence_ids: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string' } }
  }
}

function createBoundary() {
  // Compile once. Do not coerce values, apply defaults, or remove unknown fields.
  const validate = new Ajv({ allErrors: true, coerceTypes: false, useDefaults: false, removeAdditional: false }).compile(schema)
  return new OutputBoundary({
    recover: raw => JSON.parse(raw),
    validateCore: value => validate(value) === true ? true : { errors: structuredClone(validate.errors) },
    validateAudit: (value, context) => value.evidence_ids.every(id => context.allowedEvidence.has(id))
      ? true : { reason: 'unknown evidence reference' }
  })
}

async function demonstrate() {
  const boundary = createBoundary()
  const context = { allowedEvidence: new Set(['E1']) }
  const accepted = await boundary.process('{"summary":"合成证据摘要","evidence_ids":["E1"]}', context)
  await assert.rejects(boundary.process('{"summary":7,"evidence_ids":["E1"]}', context), { stage: 'core' })
  await assert.rejects(boundary.process('{"summary":"合成证据摘要","evidence_ids":["E9"]}', context), { stage: 'audit' })
  console.log(JSON.stringify({ accepted, rejected: ['invalid schema', 'unknown evidence'], synthetic: true }, null, 2))
}
if (require.main === module) demonstrate().catch(error => { console.error(error); process.exitCode = 1 })
module.exports = { schema, createBoundary }
