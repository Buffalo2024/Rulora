const test = require('node:test')
const assert = require('node:assert/strict')
const { fixture, runMinimalExample } = require('../examples/langgraph-governed-minimal')
const { adaptCompetitionReviewerOutput } = require('../src/competition-output-adapter')
const { projectRoleContext } = require('../src/role-disclosure')
const { competitionActionPrompt, competitionCalibrationPrompt, selfImpactReviewPrompt } = require('../src/prompts')

test('minimal LangGraph example preserves decisions across deterministic carrier repair', async () => {
  const result = await runMinimalExample(fixture)
  assert.deepEqual(result.final_decision, {
    action: -1,
    risk_control_advice: ['3'],
    source: 'program_expansion_of_frozen_candidate_ids'
  })
  assert.deepEqual(result.normalized_seats.map(item => item.action), [-1, -1, 0])
  assert.deepEqual(result.normalized_seats.map(item => item.risk_control_advice), [['3'], ['3'], ['6']])
  assert.ok(result.normalized_seats.some(item => item.recovery.repair_applied === true))
})

test('constrained reviewer cannot invent a decision outside frozen IDs', async () => {
  const result = await runMinimalExample(fixture)
  assert.throws(() => adaptCompetitionReviewerOutput({
    selected_action_candidate_id: 'candidate:invented:action',
    selected_risk_candidate_id: 'candidate:invented:risk',
    challenge_intent: true,
    evidence_strength: 'strong'
  }, { reviewCandidatePool: result.frozen_candidate_pool }), /outside the frozen candidate pool/)
})

test('role disclosure is an allowlist projection, not a prompt convention', () => {
  const source = {
    case_id: 'x', task: 'y', evidence: [], raw_seat_outputs: ['secret'],
    peer_candidate_summary: [{ candidate: 1 }], frozen_candidate_pool: { candidates: [] },
    internal_trace: { token: 'secret' }
  }
  assert.deepEqual(Object.keys(projectRoleContext(source, 'independent_seat')), ['case_id', 'task', 'evidence'])
  assert.deepEqual(Object.keys(projectRoleContext(source, 'constrained_reviewer')), ['case_id', 'task', 'evidence', 'frozen_candidate_pool'])
})

test('full decision prompts enforce operation-specific disclosure allowlists', () => {
  const agent = { agent_id: 'seat-a', label: 'A', method_family: 'evidence', status: 'active' }
  const caseData = {
    contract_version: '1.0.0', case_id: 'case-1', as_of_date: '2026-01-01', competition_cutoff: '2026-01-01',
    company: { id: 'demo', name: 'Demo' }, operator_task: 'focus',
    evidence: [{ id: 'E1', source_type: 'public', publisher: 'Example', title: 'Fact', summary: 'Summary', published_at: '2026-01-01', evidence_grade: 'A' }],
    internal_trace: { secret: true }, raw_model_output: 'forbidden'
  }
  const independent = JSON.parse(competitionActionPrompt({ agent, caseData, industryPlan: { nodes: [] } })[1].content)
  assert.deepEqual(Object.keys(independent), [
    'task', 'decision_mode', 'operator_task', 'agent_protocol', 'industry_plan',
    'frozen_decision_direction', 'final_action_candidate', 'case'
  ])
  assert.equal(independent.case.internal_trace, undefined)
  assert.equal(independent.case.raw_model_output, undefined)

  const broadcast = JSON.parse(selfImpactReviewPrompt({
    agent, phase: 'decision_direction', ownDecision: { action_candidate: 0 },
    peerDecisions: [{ action_candidate: -1 }], differencePacket: { changed: true },
    evidenceIndex: { E1: { title: 'Fact' } }
  })[1].content)
  assert.deepEqual(Object.keys(broadcast), [
    'task', 'decision_mode', 'agent_protocol', 'own', 'peers', 'differences',
    'frozen_decision_direction', 'selected_action', 'evidence_index'
  ])

  const reviewer = JSON.parse(competitionCalibrationPrompt({
    agent: { ...agent, agent_id: 'competition_calibration_reviewer' }, frozenCase: caseData,
    initialOutputs: {}, postBroadcastOutputs: {}, actionCalibration: {},
    reviewCandidatePool: {
      action_candidates: [{ id: 'a', value: 0 }], risk_candidates: [{ id: 'r', value: ['3'] }],
      champion_decision: null, support_statistics: {}, review_candidate_pool_hash: 'hash'
    }
  })[1].content)
  assert.deepEqual(Object.keys(reviewer), [
    'task', 'action_candidates', 'risk_candidates', 'champion_decision',
    'support_statistics', 'evidence_summary', 'review_candidate_pool_hash'
  ])
  assert.equal(reviewer.initialOutputs, undefined)
  assert.equal(reviewer.postBroadcastOutputs, undefined)
})
