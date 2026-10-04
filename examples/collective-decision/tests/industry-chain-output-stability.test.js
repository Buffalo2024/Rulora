const test = require('node:test')
const assert = require('node:assert/strict')
const { recoverCompetitionOutput } = require('../src/competition-output-recovery')
const { competitionActionPrompt, competitionRiskPrompt } = require('../src/prompts')

const agent = { agent_id: 'industry_chain_analyst', label: '上下游产业链分析师', method_family: 'industry_chain_transmission', version: 'test' }
const caseData = { company: { company_id: 'T01', name: '测试企业' }, as_of_date: '2026-08-09', evidence: [], operator_task: null }
const industryPlan = { 产业链: { nodes: [], edges: [] }, 传导逻辑: [] }

test('industry core block extracts Action before long or malformed analysis', () => {
  const raw = `## FINAL_DECISION\naction_candidate:\n0\ndecision_confidence:\nmedium\n## END_FINAL_DECISION\n## INDUSTRY_CHAIN_ANALYSIS\n${'产业链分析“未闭合 { '.repeat(5000)}`
  const recovered = recoverCompetitionOutput(raw, { stagePhase: 'decision_direction', operation: 'decideStage' })
  assert.deepEqual(recovered.value, { action_candidate: 0 })
  assert.equal(recovered.output_recovery.mode, 'decision_block')
  assert.equal(recovered.output_recovery.repair_applied, false)
})

test('industry core block extracts explicit Risk including empty set', () => {
  const nonEmpty = recoverCompetitionOutput('## FINAL_DECISION\nrisk_control_advice:\n[3,"6"]\n## END_FINAL_DECISION\n## INDUSTRY_CHAIN_ANALYSIS\n说明', { stagePhase: 'risk_control_advice' })
  const empty = recoverCompetitionOutput('## FINAL_DECISION\nrisk_control_advice:\n[]\n## END_FINAL_DECISION\n## INDUSTRY_CHAIN_ANALYSIS\n说明', { stagePhase: 'risk_control_advice' })
  assert.deepEqual(nonEmpty.value.risk_control_advice, ['3', '6'])
  assert.deepEqual(empty.value.risk_control_advice, [])
})

test('industry core block refuses invalid core values rather than reading analysis prose', () => {
  assert.throws(() => recoverCompetitionOutput('## FINAL_DECISION\naction_candidate:\n谨慎\n## END_FINAL_DECISION\n## INDUSTRY_CHAIN_ANALYSIS\n建议收紧', { stagePhase: 'decision_direction' }), /recoverable/)
})

test('industry initial prompts preserve seat independence and stage separation', () => {
  const action = competitionActionPrompt({ agent, caseData, industryPlan })
  const risk = competitionRiskPrompt({ agent, caseData, industryPlan, frozenDirection: 'risk_flat' })
  const actionText = action.map(item => item.content).join('\n')
  const riskText = risk.map(item => item.content).join('\n')
  for (const forbidden of ['risk_factor_analyst', 'adversarial_reviewer', 'competition_calibration_reviewer', 'candidate_pool']) {
    assert.equal(actionText.includes(forbidden), false)
    assert.equal(riskText.includes(forbidden), false)
  }
  assert.match(actionText, /FINAL_DECISION/)
  assert.match(actionText, /禁止预想或输出下一阶段风控建议/)
  assert.match(riskText, /经营方向已经冻结/)
})

