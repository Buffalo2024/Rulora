'use strict'
const assert = require('node:assert/strict')
const { CollectiveControl } = require('../../../src')
function main() {
  const controller = new CollectiveControl({ quorum: 2 })
  const submissions = [{ id: 'a', answer: { plan: '先验证再执行', evidence: ['E1'] } }, { id: 'b', answer: { plan: '先补充证据', evidence: ['E2'] } }]
  const pool = controller.freezeCandidates(submissions)
  submissions[0].answer.evidence.push('changed-after-freeze')
  assert.deepEqual(pool[0].answer.evidence, ['E1'])
  assert.throws(() => controller.select(pool, 'invented'), { code: 'UNKNOWN_CANDIDATE' })
  const selected = controller.select(pool, 'b')
  assert.throws(() => { selected.answer.plan = 'rewritten' }, TypeError)
  console.log(JSON.stringify({ example: 'candidate-selection', selected, note: '冻结和合法选择不证明方案最优；法定人数不证明来源独立。' }))
}
if (require.main === module) main()
module.exports = { main }
