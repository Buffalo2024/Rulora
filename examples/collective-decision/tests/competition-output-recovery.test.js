const test = require('node:test')
const assert = require('node:assert/strict')
const { recoverCompetitionOutput } = require('../src/competition-output-recovery')
const { adaptCompetitionRiskOutput, adaptCompetitionSeatOutput } = require('../src/competition-output-adapter')

test('recovery T1 accepts normal JSON without repair', () => {
  const recovered = recoverCompetitionOutput('{"action_candidate":0,"risk_control_advice":["3"]}')
  assert.equal(recovered.output_recovery.mode, 'json')
  assert.equal(recovered.output_recovery.repair_applied, false)
})

test('recovery T2 strips a JSON fence deterministically', () => {
  const recovered = recoverCompetitionOutput('```json\n{"action_candidate":0,"risk_control_advice":["3"]}\n```')
  assert.equal(recovered.value.action_candidate, 0)
  assert.ok(recovered.output_recovery.operations.includes('strip_markdown_fence'))
})

test('recovery T3 inserts a missing property comma without changing Action or Risk', () => {
  const recovered = recoverCompetitionOutput('{\n"action_candidate":0\n"risk_control_advice":["3"]\n}')
  const adapted = adaptCompetitionSeatOutput(recovered.value)
  assert.equal(adapted.value.action, 0)
  assert.deepEqual(adapted.value.risk_control_advice, ['3'])
  assert.ok(recovered.output_recovery.operations.includes('insert_missing_property_comma'))
})

test('recovery T4 parses explicit Markdown fields only', () => {
  const recovered = recoverCompetitionOutput('Action:\n0\n\nRisk:\n- 3\n- 6\n')
  const adapted = adaptCompetitionSeatOutput(recovered.value)
  assert.equal(adapted.value.action, 0)
  assert.deepEqual(adapted.value.risk_control_advice, ['3', '6'])
  assert.equal(recovered.output_recovery.mode, 'markdown')
})

test('recovery T5 rejects explanation-only prose', () => {
  assert.throws(() => recoverCompetitionOutput('风险较高，需要关注。'), /not return recoverable/)
})

test('recovery T6 does not select a conditional Risk tree', () => {
  const recovered = recoverCompetitionOutput('{"risk_up":["3"],"risk_flat":[],"risk_down":["6"]}')
  assert.throws(() => adaptCompetitionRiskOutput(recovered.value), /SEMANTIC_AMBIGUITY/)
})

test('recovery T7 recovers the 006 class of malformed Risk JSON', () => {
  const raw = `{\n"execution_agent":"industry_chain_analyst",\n"risk_mitigation_recommendations":["3","6"]\n"reason":["公开证据支持必要措施"]\n}`
  const recovered = recoverCompetitionOutput(raw, { stagePhase: 'risk_control_advice' })
  const adapted = adaptCompetitionRiskOutput(recovered.value, { expectedAgentId: 'industry_chain_analyst' })
  assert.deepEqual(adapted.value.risk_control_advice, ['3', '6'])
  assert.equal(recovered.output_recovery.repair_applied, true)
})

test('recovery preserves empty Risk as an explicit final set', () => {
  const recovered = recoverCompetitionOutput('Risk:\n', { stagePhase: 'risk_control_advice' })
  assert.deepEqual(recovered.value.risk_control_advice, [])
})

test('reviewer recovery preserves explicit Markdown Action, Risk, and Challenge', () => {
  const recovered = recoverCompetitionOutput('Action:\n0\n\nRisk:\n3\n\nChallenge:\nHIGH\n', { operation: 'reviewCalibration' })
  assert.deepEqual(recovered.value, { action_candidate: 0, risk_control_advice: ['3'], challenge_level: 'HIGH' })
})
