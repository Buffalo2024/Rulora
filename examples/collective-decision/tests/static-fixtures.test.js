const test = require('node:test')
const assert = require('node:assert/strict')
const { verifyStaticFixtures } = require('../examples/static-fixtures')

test('checked-in input produces the expected report and checkpoint restores without another call', async () => {
  const result = await verifyStaticFixtures()
  assert.equal(result.expected_report_matches, true)
  assert.ok(result.first_run_model_calls > 0)
  assert.equal(result.replay_additional_model_calls, 0)
  assert.equal(result.checked_in_checkpoint, 'reused')
})
