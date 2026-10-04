'use strict'
const assert = require('node:assert/strict')
const { OutputBoundary } = require('../../../src')
async function main() {
  const boundary = new OutputBoundary({
    recover: raw => JSON.parse(raw),
    adapt: value => value,
    validateCore: value => typeof value.summary === 'string' && value.summary.trim().length > 0,
    validateAudit: value => Array.isArray(value.evidenceIds) && value.evidenceIds.every(id => ['E1', 'E2'].includes(id))
  })
  const accepted = await boundary.process('{"summary":"合成经营摘要","evidenceIds":["E1"]}')
  await assert.rejects(boundary.process('{"summary":"","evidenceIds":[]}'), error => error.stage === 'core')
  await assert.rejects(boundary.process('{"summary":"未绑定证据","evidenceIds":["unknown"]}'), error => error.stage === 'audit')
  console.log(JSON.stringify({ example: 'output-boundary', accepted, rejectedCases: 2, note: '结构与引用校验不证明内容真实。' }))
}
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1 })
module.exports = { main }
