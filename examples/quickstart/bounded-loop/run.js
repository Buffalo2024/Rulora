'use strict'
const assert = require('node:assert/strict')
const { LoopControl } = require('../../../src')
function main() {
  const loop = new LoopControl({ kind: 'constraint_revision', maxAttempts: 3, maxNoProgress: 2 })
  const trace = []
  // The host records each attempt and MUST stop when status leaves active.
  for (const progressed of [false, false, true]) {
    if (loop.snapshot().status !== 'active') break
    trace.push(loop.record({ progressed }))
  }
  assert.equal(trace.length, 2)
  assert.equal(loop.snapshot().status, 'human_handoff')
  assert.throws(() => loop.record({ progressed: true }), { code: 'LOOP_CLOSED' })
  console.log(JSON.stringify({ example: 'bounded-loop', trace, note: '不调模型；不自动调度、不自动休眠重试。' }))
}
if (require.main === module) main()
module.exports = { main }
