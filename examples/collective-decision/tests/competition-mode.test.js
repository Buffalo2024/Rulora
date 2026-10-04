const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const {
  CompetitionCallBudget,
  buildCandidateSupport,
  buildExactSetCandidatePool,
  buildReviewerCandidatePool,
  calibrateActionCandidate,
  evaluateActionRiskConsistency,
  finalizeCalibratedDecision,
  validateCalibrationReview
} = require('../src/competition-mode')
const { validateStageDecision } = require('../src/contracts')
const { applyTwoStageOutcome, auditPrimaryEvidence, gateCompetitionOpinion, gateOpinion, runTwoStageDebate } = require('../src/orchestrator')
const { loadRulora } = require('../src/rulora-loader')
const { loadSchemaValidators } = require('../src/schema-validator')
const { FixtureProvider } = require('../src/providers/fixture-provider')
const { MultiModelProvider } = require('../src/providers/multi-model-provider')
const { adaptCompetitionActionOutput, adaptCompetitionReviewerOutput, adaptCompetitionRiskOutput } = require('../src/competition-output-adapter')
const { ModelCallCheckpointStore } = require('../src/model-call-checkpoint-store')
const { validateSubmissionRow } = require('../src/submission')
const { normalizeBatchConfig, validateBatchConfig } = require('../src/batch-runner')
const { buildSubmissionSupervisorRecord } = require('../src/submission-supervisor')

const SEATS = ['industry_chain_analyst', 'risk_factor_analyst', 'adversarial_reviewer']

test('Competition opinion projection uses Core hard gate and downgrades legacy Opinion fields to Audit warnings', async () => {
  const schemas = await loadSchemaValidators(path.resolve(__dirname, '..'))
  const agent = { agent_id: 'industry_chain_analyst', version: 1, method_family: 'bottleneck_causal_graph' }
  const direction = { 执行员: agent.agent_id, 经营调整方向: 'risk_flat', 逻辑: [], 证据: [] }
  const advice = { 执行员: agent.agent_id, 风控建议: [], 逻辑: [], 证据: [] }
  const opinion = {
    agent_id: agent.agent_id, agent_version: 1, method_family: agent.method_family,
    result_candidate: 'risk_flat', probabilities: { risk_up: 0, risk_flat: 1, risk_down: 0 },
    factors: [], chain_map: { nodes: [], edges: [] }, recommended_advice: [], thesis: '', uncertainties: [],
    stage_decisions: { decision_direction: direction, risk_control_advice: advice }
  }
  const warnings = gateCompetitionOpinion(opinion, agent, new Set(['e1']), schemas.opinion)
  assert.ok(warnings.includes('OPINION_AUDIT_SCHEMA_MISMATCH:industry_chain_analyst'))
  assert.equal(opinion.audit_validation.core_contract_pass, true)
  assert.equal(opinion.audit_validation.audit_contract_pass, false)
  assert.throws(() => gateOpinion(structuredClone(opinion), agent, new Set(['e1']), schemas.opinion), /JSON Schema rejected/)
  assert.deepEqual(auditPrimaryEvidence([opinion], new Map([['e1', 'A']])), ['OPINION_AUDIT_PRIMARY_EVIDENCE_MISSING:industry_chain_analyst'])
})

test('Competition opinion Core gate still rejects Action or Risk drift', () => {
  const agent = { agent_id: 'industry_chain_analyst', version: 1, method_family: 'bottleneck_causal_graph' }
  const opinion = {
    agent_id: agent.agent_id, agent_version: 1, method_family: agent.method_family,
    result_candidate: 'risk_up', recommended_advice: ['3'],
    stage_decisions: {
      decision_direction: { 执行员: agent.agent_id, 经营调整方向: 'risk_flat', 逻辑: [], 证据: [] },
      risk_control_advice: { 执行员: agent.agent_id, 风控建议: [], 逻辑: [], 证据: [] }
    }
  }
  assert.throws(() => gateCompetitionOpinion(opinion, agent, new Set(), null), /core gate rejected/)
})

function direction(seat, value, { transmission = ['e1'], threshold = ['e1'] } = {}) {
  return {
    execution_agent: seat,
    action_candidate: { risk_up: -1, risk_flat: 0, risk_down: 1 }[value],
    action_confidence: 0.55,
    action_reason: ['合成测试判断。'],
    transmission_evidence: transmission,
    threshold_evidence: threshold,
    counter_evidence: [],
    '执行员': seat,
    '经营调整方向': value,
    '逻辑': [{ claim: '合成判断', mechanism: '公开证据经现金流传导。', evidence_refs: ['e1'] }],
    '证据': ['e1']
  }
}

function advice(seat, values) {
  return {
    execution_agent: seat,
    set_confidence: 0.55,
    label_assessments: values.map(code => ({ code, necessary: true, why_required: ['合成测试必要标签。'], why_deletable: [], counter_evidence: [] })),
    '执行员': seat,
    '风控建议': values,
    '逻辑': [{ claim: '合成建议', mechanism: '对应冻结经营方向。', evidence_refs: ['e1'] }],
    '证据': ['e1']
  }
}

function joint(seat, directionValue, adviceValues, options = {}) {
  return {
    ...direction(seat, directionValue, options),
    set_confidence: 0.55,
    label_assessments: adviceValues.map(code => ({ code, necessary: true, why_required: ['合成测试必要标签。'], why_deletable: [], counter_evidence: [] })),
    '风控建议': adviceValues
  }
}

async function fixtureCompetitionContext() {
  const roles = require('../config/agents.json').roles
  const agents = SEATS.map(id => ({ ...roles.find(item => item.id === id), agent_id: id, version: 1, status: 'champion' }))
  const calibrationReviewer = { ...roles.find(item => item.id === 'competition_calibration_reviewer'), agent_id: 'competition_calibration_reviewer', version: 1 }
  const fixture = new FixtureProvider()
  const caseData = {
    contract_version: '1.0.0', case_id: 'synthetic-competition-v2', as_of_date: '2026-08-09', competition_cutoff: '2026-08-09',
    company: { id: '900', name: '合成企业', industry: '测试' }, decision_horizon_days: 180,
    evidence: [
      { id: 'e1', evidence_grade: 'A' },
      { id: 'e2', evidence_grade: 'B' }
    ]
  }
  caseData.industry_plan = await fixture.planIndustry({ agent: { agent_id: 'industry_research_planner' }, caseData })
  return { agents, calibrationReviewer, caseData }
}

test('competition flow keeps three joint independent seats, one broadcast revision per seat, freezes, then reviews once', async () => {
  const schemas = await loadSchemaValidators(path.resolve(__dirname, '..'))
  const roles = require('../config/agents.json').roles
  const agents = SEATS.map(id => ({ ...roles.find(item => item.id === id), agent_id: id, version: 1, status: 'champion' }))
  const calibrationReviewer = { ...roles.find(item => item.id === 'competition_calibration_reviewer'), agent_id: 'competition_calibration_reviewer', version: 1 }
  const base = new FixtureProvider()
  const counts = { decide: 0, revise: 0, reviewer: 0, activeDecide: 0, activeRevise: 0, maxActiveDecide: 0, maxActiveRevise: 0 }
  const provider = {
    decideStage: async args => {
      counts.decide += 1
      counts.activeDecide += 1
      counts.maxActiveDecide = Math.max(counts.maxActiveDecide, counts.activeDecide)
      await new Promise(resolve => setTimeout(resolve, 5))
      const value = await base.decideStage(args)
      counts.activeDecide -= 1
      return value
    },
    reviewStage: async args => {
      counts.revise += 1
      counts.activeRevise += 1
      counts.maxActiveRevise = Math.max(counts.maxActiveRevise, counts.activeRevise)
      await new Promise(resolve => setTimeout(resolve, 5))
      const value = await base.reviewStage(args)
      counts.activeRevise -= 1
      return value
    },
    reviewCalibration: async args => { counts.reviewer += 1; return base.reviewCalibration(args) },
    diagnostics: () => ({ fallback_events: [] })
  }
  const caseData = {
    contract_version: '1.0.0', case_id: 'synthetic-competition-smoke', as_of_date: '2026-08-09', competition_cutoff: '2026-08-09',
    company: { id: '900', name: '合成企业' }, decision_horizon_days: 180,
    evidence: [
      { id: 'e1', evidence_grade: 'A' },
      { id: 'e2', evidence_grade: 'B' }
    ],
    industry_plan: await base.planIndustry({ agent: { agent_id: 'industry_research_planner' }, caseData: { company: { id: '900', name: '合成企业', industry: '测试' } } })
  }
  const budget = new CompetitionCallBudget()
  const result = await runTwoStageDebate({
    core: loadRulora().core, provider, agents, calibrationReviewer, caseData, industryPlan: caseData.industry_plan,
    evidenceIds: new Set(['e1', 'e2']), evidenceGrades: new Map([['e1', 'A'], ['e2', 'B']]),
    config: require('../config/debate.json'), opinionSchema: schemas.opinion, stageDecisionSchema: schemas.stageDecision,
    competitionStageDecisionSchema: schemas.competitionStageDecision, calibrationReviewSchema: schemas.competitionCoreDecision,
    decisionMode: 'competition_calibrated', competitionBudget: budget, champion: null
  })
  assert.equal(counts.decide, 3, '三席只进行一次联合并行首轮')
  assert.equal(counts.revise, 3, '一次广播后每席只修订一次')
  assert.equal(counts.maxActiveDecide, 3, '三席首轮必须并行而非串行')
  assert.equal(counts.maxActiveRevise, 3, '三席修订必须并行而非串行')
  assert.equal(counts.reviewer, 1)
  assert.equal(result.record.phases.joint_decision.review_output_count, 3)
  assert.equal(result.record.phases.decision_direction.review_output_count, 3)
  assert.equal(result.record.phases.risk_control_advice.review_output_count, 3)
  assert.equal(result.record.termination.decision_finalized, true)
  assert.deepEqual(result.competition_finalization.budget.counts.initial_seat, Object.fromEntries(SEATS.map(id => [id, 1])))
  assert.deepEqual(result.competition_finalization.budget.counts.revision, Object.fromEntries(SEATS.map(id => [id, 1])))
})

test('competition calibrated v2 runs Action first, conditions Risk on frozen Action, and finalizes one Core decision', async () => {
  const schemas = await loadSchemaValidators(path.resolve(__dirname, '..'))
  const { agents, calibrationReviewer, caseData } = await fixtureCompetitionContext()
  const base = new FixtureProvider()
  const counts = { actionInitial: 0, riskInitial: 0, actionRevision: 0, riskRevision: 0, reviewer: 0 }
  const frozenDirections = []
  const provider = {
    decideStage: async args => {
      if (args.phase === 'decision_direction') counts.actionInitial += 1
      else { counts.riskInitial += 1; frozenDirections.push(args.frozenDirection) }
      return base.decideStage(args)
    },
    reviewStage: async args => {
      if (args.phase === 'decision_direction') counts.actionRevision += 1
      else { counts.riskRevision += 1; frozenDirections.push(args.frozenDirection) }
      return base.reviewStage(args)
    },
    reviewCalibration: async args => { counts.reviewer += 1; return base.reviewCalibration(args) },
    diagnostics: () => ({ fallback_events: [] })
  }
  const result = await runTwoStageDebate({
    core: loadRulora().core, provider, agents, calibrationReviewer, caseData, industryPlan: caseData.industry_plan,
    evidenceIds: new Set(['e1', 'e2']), evidenceGrades: new Map([['e1', 'A'], ['e2', 'B']]),
    config: require('../config/debate.json'), opinionSchema: schemas.opinion, stageDecisionSchema: schemas.stageDecision,
    competitionStageDecisionSchema: schemas.competitionStageDecision,
    competitionActionDecisionSchema: schemas.competitionActionDecision,
    competitionRiskDecisionSchema: schemas.competitionRiskDecision,
    calibrationReviewSchema: schemas.competitionCoreDecision,
    decisionMode: 'competition_calibrated_v2', competitionBudget: new CompetitionCallBudget({ limits: { initial_seat: 6, revision: 6 } }), champion: null
  })
  assert.deepEqual(counts, { actionInitial: 3, riskInitial: 3, actionRevision: 3, riskRevision: 3, reviewer: 1 })
  assert.equal(new Set(frozenDirections).size, 1)
  assert.equal(frozenDirections[0], result.record.two_stage_outcome.direction.value)
  assert.equal(result.record.contract_version, '7.0.0')
  assert.equal(result.record.same_seats_in_both_stages, true)
  assert.equal(result.record.action_first_conditioned_risk, true)
  assert.equal(result.competition_finalization.decision_mode, 'competition_calibrated_v2')
  assert.equal(result.competition_finalization.decision_finalized, true)
  assert.ok([-1, 0, 1].includes(Number(result.competition_finalization.action)))
  assert.ok(Array.isArray(result.competition_finalization.risk_control_advice))
})

test('competition calibrated v2 pauses on one failed Risk seat and resumes only that seat', async () => {
  const schemas = await loadSchemaValidators(path.resolve(__dirname, '..'))
  const { agents, calibrationReviewer, caseData } = await fixtureCompetitionContext()
  const base = new FixtureProvider()
  const checkpointRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'competition-v2-checkpoint-'))
  const counts = new Map()
  let failRiskSeat = true
  const count = key => counts.set(key, (counts.get(key) || 0) + 1)
  const provider = {
    decideStage: async args => {
      const key = `initial:${args.phase}:${args.agent.agent_id}`
      count(key)
      if (failRiskSeat && args.phase === 'risk_control_advice' && args.agent.agent_id === SEATS[2]) {
        const error = new Error('synthetic Risk stage failure')
        error.code = 'PAUSED_SEAT_FAILURE'
        throw error
      }
      return base.decideStage(args)
    },
    reviewStage: async args => { count(`revision:${args.phase}:${args.agent.agent_id}`); return base.reviewStage(args) },
    reviewCalibration: async args => { count('reviewer'); return base.reviewCalibration(args) },
    diagnostics: () => ({ fallback_events: [] })
  }
  const run = store => runTwoStageDebate({
    core: loadRulora().core, provider, agents, calibrationReviewer, caseData, industryPlan: caseData.industry_plan,
    evidenceIds: new Set(['e1', 'e2']), evidenceGrades: new Map([['e1', 'A'], ['e2', 'B']]),
    config: require('../config/debate.json'), opinionSchema: schemas.opinion, stageDecisionSchema: schemas.stageDecision,
    competitionStageDecisionSchema: schemas.competitionStageDecision,
    competitionActionDecisionSchema: schemas.competitionActionDecision,
    competitionRiskDecisionSchema: schemas.competitionRiskDecision,
    calibrationReviewSchema: schemas.competitionCoreDecision,
    decisionMode: 'competition_calibrated_v2', competitionBudget: new CompetitionCallBudget({ limits: { initial_seat: 6, revision: 6 } }), champion: null,
    modelCallCheckpoints: store, executionFingerprint: 'fixture-v2'
  })
  try {
    const store = new ModelCallCheckpointStore({ rootDirectory: checkpointRoot })
    await assert.rejects(() => run(store), error => error.code === 'PAUSED_SEAT_FAILURE')
    const actionCallsBeforeResume = [...counts.entries()].filter(([key]) => key.includes('decision_direction')).reduce((sum, [, value]) => sum + value, 0)
    assert.equal(actionCallsBeforeResume, 6)
    assert.equal(counts.get(`initial:risk_control_advice:${SEATS[2]}`), 1)
    assert.equal(counts.get(`initial:risk_control_advice:${SEATS[0]}`), 1)
    assert.equal(counts.get(`initial:risk_control_advice:${SEATS[1]}`), 1)
    assert.equal(counts.get(`revision:risk_control_advice:${SEATS[0]}`) || 0, 0)
    failRiskSeat = false
    const resumedStore = new ModelCallCheckpointStore({ rootDirectory: checkpointRoot })
    const result = await run(resumedStore)
    const actionCallsAfterResume = [...counts.entries()].filter(([key]) => key.includes('decision_direction')).reduce((sum, [, value]) => sum + value, 0)
    assert.equal(actionCallsAfterResume, actionCallsBeforeResume, 'successful Action nodes must not be repeated')
    assert.equal(counts.get(`initial:risk_control_advice:${SEATS[2]}`), 2, 'only the failed Risk seat is called again')
    assert.equal(counts.get(`initial:risk_control_advice:${SEATS[0]}`), 1)
    assert.equal(counts.get(`initial:risk_control_advice:${SEATS[1]}`), 1)
    assert.equal(result.competition_finalization.decision_finalized, true)
    const snapshot = resumedStore.caseSnapshot()
    assert.equal(snapshot.action_finalized, true)
    assert.equal(Object.keys(snapshot.risk_initial_results).length, 3)
    assert.equal(Object.keys(snapshot.risk_revision_results).length, 3)
  } finally {
    await fs.rm(checkpointRoot, { recursive: true, force: true })
  }
})

test('v2 adapters keep Action and Risk contracts separate and reject an unselected conditional Risk tree', () => {
  assert.equal(adaptCompetitionActionOutput({ action_candidate: '1' }, { expectedAgentId: SEATS[0] }).value.action_candidate, 1)
  assert.equal(adaptCompetitionActionOutput({ action_candidate: 1, '经营调整方向': '下降' }, { expectedAgentId: SEATS[0] }).value.action_candidate, 1)
  assert.deepEqual(adaptCompetitionRiskOutput({ wrapper: { final_risk_control_advice: [3, 6] } }, { expectedAgentId: SEATS[0] }).value.risk_control_advice, ['3', '6'])
  assert.throws(() => adaptCompetitionRiskOutput({ risk_up: ['4'], risk_flat: ['3'], risk_down: ['1'] }), /SEMANTIC_AMBIGUITY/)
  assert.deepEqual(evaluateActionRiskConsistency('1', ['4']), {
    compatible: false,
    conflict_codes: ['4'],
    rule: 'risk_easing_action_conflicts_with_strict_tightening_advice'
  })
})

test('reviewer request fields are structurally rejected and cannot open a loop', () => {
  const pool = buildExactSetCandidatePool({ initialDecisions: SEATS.map(id => advice(id, ['3'])), finalDecisions: SEATS.map(id => advice(id, ['3'])) })
  const action = calibrateActionCandidate({ initialDecisions: SEATS.map(id => direction(id, 'risk_flat')), finalDecisions: SEATS.map(id => direction(id, 'risk_flat')) })
  const review = validReview(pool, action, null)
  review.request_reanalysis = true
  review.reason = ['要求重新广播与重新采集。']
  const errors = validateCalibrationReview(review, { candidatePool: pool, actionCalibration: action })
  assert(errors.some(error => error.includes('forbidden')))
  const budget = new CompetitionCallBudget()
  budget.consume('calibration_reviewer')
  assert.throws(() => budget.consume('calibration_reviewer'), error => error.code === 'COMPETITION_BUDGET_EXCEEDED')
})

test('reviewer prose is audit text and is never interpreted by the Program gate', () => {
  const pool = buildExactSetCandidatePool({ initialDecisions: SEATS.map(id => advice(id, ['3'])), finalDecisions: SEATS.map(id => advice(id, ['3'])) })
  const action = calibrateActionCandidate({ initialDecisions: SEATS.map(id => direction(id, 'risk_flat')), finalDecisions: SEATS.map(id => direction(id, 'risk_flat')) })
  const review = validReview(pool, action, null)
  review.reason = ['建议重新分析。', '本次不触发重新广播。']
  const errors = validateCalibrationReview(review, { candidatePool: pool, actionCalibration: action })
  assert.equal(errors.some(error => error.includes('forbidden')), false)
  assert.equal(errors.length, 0)
})

test('independent support is not inflated by broadcast following', () => {
  const initial = [direction(SEATS[0], 'risk_flat'), direction(SEATS[1], 'risk_down'), direction(SEATS[2], 'risk_up')]
  const final = SEATS.map(id => direction(id, 'risk_flat'))
  const support = buildCandidateSupport({ phase: 'decision_direction', initialDecisions: initial, finalDecisions: final })
  const flat = support.candidates.find(item => item.value === 'risk_flat')
  assert.equal(flat.independent_support_count, 1)
  assert.equal(flat.post_broadcast_support_count, 3)
  assert.equal(flat.broadcast_added_support_count, 2)
})

test('exact-set pool never creates a per-label union absent from all seats', () => {
  const values = [['1', '2'], ['1', '3'], ['2', '3']]
  const pool = buildExactSetCandidatePool({ initialDecisions: SEATS.map((id, index) => advice(id, values[index])), finalDecisions: SEATS.map((id, index) => advice(id, values[index])) })
  assert.equal(pool.candidates.some(item => JSON.stringify(item.value) === JSON.stringify(['1', '2', '3'])), false)
})

test('exact complete-set majority is preferred before a larger minority set', () => {
  const values = [['3'], ['3'], ['3', '8']]
  const pool = buildExactSetCandidatePool({ initialDecisions: SEATS.map((id, index) => advice(id, values[index])), finalDecisions: SEATS.map((id, index) => advice(id, values[index])) })
  assert.deepEqual(pool.candidates[0].value, ['3'])
})

test('empty complete set receives no size-based preference when support is tied', () => {
  const values = [[], ['3'], ['4']]
  const decisions = SEATS.map((id, index) => advice(id, values[index]))
  const pool = buildExactSetCandidatePool({ initialDecisions: decisions, finalDecisions: decisions })
  assert.equal(pool.preferred_candidate_set_id, null)
  assert.equal(pool.selection_rule, 'whole_set_support_then_independent_support_no_size_prior')
})

test('empty risk set is legal in calibrated schema, Program, and submission', async () => {
  const schemas = await loadSchemaValidators(path.resolve(__dirname, '..'))
  const empty = advice(SEATS[0], [])
  assert.equal(schemas.competitionStageDecision(empty), true)
  assert.deepEqual(validateSubmissionRow({ company_id: '001', action: '0', risk_control_advice: '' }), { company_id: '001', action: '0', risk_control_advice: '' })
})

test('four-item risk set is legal in calibrated schema and submission', async () => {
  const schemas = await loadSchemaValidators(path.resolve(__dirname, '..'))
  const four = advice(SEATS[0], ['1', '2', '3', '4'])
  assert.equal(schemas.competitionStageDecision(four), true)
  assert.equal(validateSubmissionRow({ company_id: '001', action: '0', risk_control_advice: '1,2,3,4' }).risk_control_advice, '1,2,3,4')
})

test('joint competition schema and Program gate accept one bounded Action plus Risk envelope', async () => {
  const schemas = await loadSchemaValidators(path.resolve(__dirname, '..'))
  const value = joint(SEATS[0], 'risk_flat', ['3'])
  assert.equal(schemas.competitionStageDecision(value), true)
  assert.deepEqual(validateStageDecision(value, {
    agent: { agent_id: SEATS[0] }, phase: 'competition_joint_decision', evidenceIds: new Set(['e1']), mode: 'competition_calibrated'
  }), [])
})

test('insufficient transmission or threshold evidence does not auto-project a nonzero Action to 0', () => {
  const initial = [direction(SEATS[0], 'risk_up', { transmission: [], threshold: [] }), direction(SEATS[1], 'risk_up', { transmission: [], threshold: [] }), direction(SEATS[2], 'risk_flat')]
  const final = SEATS.map(id => direction(id, 'risk_up', { transmission: [], threshold: [] }))
  const action = calibrateActionCandidate({ initialDecisions: initial, finalDecisions: final })
  assert.equal(action.calibrated_action, null)
  assert.equal(action.prior.type, 'no_program_default')
  const reviewPool = buildReviewerCandidatePool({ actionCalibration: action, candidatePool: { candidates: [] } })
  assert.deepEqual(reviewPool.action_candidates, [])
})

test('flat Action must earn the same seat support threshold and is not a fallback', () => {
  const split = [direction(SEATS[0], 'risk_flat'), direction(SEATS[1], 'risk_up'), direction(SEATS[2], 'risk_down')]
  const unresolved = calibrateActionCandidate({ initialDecisions: split, finalDecisions: split })
  assert.equal(unresolved.proposed_direction, null)
  assert.equal(unresolved.calibrated_action, null)
  assert.equal(unresolved.threshold_by_direction.risk_flat.passed, false)

  const flat = SEATS.map(id => direction(id, 'risk_flat'))
  const resolved = calibrateActionCandidate({ initialDecisions: flat, finalDecisions: flat })
  assert.equal(resolved.calibrated_action, '0')
  assert.equal(resolved.threshold_by_direction.risk_flat.passed, true)
})

test('calibration reviewer can be consumed only once and finalization blocks every later model call', () => {
  const budget = new CompetitionCallBudget()
  budget.consume('calibration_reviewer')
  budget.finalize()
  assert.throws(() => budget.consume('initial_seat', 1, 'decision_direction'), error => error.code === 'DECISION_FINALIZED')
  assert.throws(() => budget.consume('calibration_reviewer'), error => error.code === 'DECISION_FINALIZED')
})

test('seat budgets fail closed on a second call by one seat or a fourth total seat', () => {
  const sameSeat = new CompetitionCallBudget()
  sameSeat.consume('revision', 1, SEATS[0])
  assert.throws(() => sameSeat.consume('revision', 1, SEATS[0]), error => error.code === 'COMPETITION_BUDGET_EXCEEDED')
  const total = new CompetitionCallBudget()
  for (const seat of SEATS) total.consume('initial_seat', 1, seat)
  assert.throws(() => total.consume('initial_seat', 1, 'unexpected-fourth-seat'), error => error.code === 'COMPETITION_BUDGET_EXCEEDED')
})

test('legacy four-module stage decisions and parsing contract remain valid', async () => {
  const schemas = await loadSchemaValidators(path.resolve(__dirname, '..'))
  const legacy = { '执行员': 'legacy-seat', '经营调整方向': 'risk_flat', '逻辑': [{ claim: '维持', mechanism: '证据未达调整门槛。', evidence_refs: ['e1'] }], '证据': ['e1'] }
  assert.equal(schemas.stageDecision(legacy), true)
  assert.equal(validateStageDecision(legacy, { agent: { agent_id: 'legacy-seat' }, phase: 'decision_direction', evidenceIds: new Set(['e1']), mode: 'competition_legacy' }).length, 0)
  const historical = applyTwoStageOutcome({ risk_control_advice: [], evidence_coverage: 1 }, {
    direction: { value: 'risk_flat', unanimous: false }, advice: { values: [], unanimous: false }, manual_adjudication_required: false
  }, require('../config/decision.json'))
  assert.equal(historical.action, '0')
  assert.deepEqual(historical.risk_control_advice, ['3'])
  assert.equal(historical.decision_mode, 'two_stage_majority')
})

function validReview(pool, action, champion) {
  const preferred = pool.candidates[0]
  return {
    reviewer_id: 'competition_calibration_reviewer', recommended_action: action.calibrated_action, confidence: 0.5,
    why_not_minus_1: [], why_not_plus_1: [], recommended_risk_set: [...preferred.value],
    risk_selection: { source_candidate_set_id: preferred.candidate_id, removed_codes: [], reason: ['选择支持最强的冻结完整集合。'] },
    challenge_champion: Boolean(champion), challenge_strength: 'LOW', reason: []
  }
}

test('partial calibrated batch accepts explicit case_ids and frozen-evidence reuse without a 25-case gate', () => {
  const config = normalizeBatchConfig({
    contract_version: '1.0.0', formal_mode: true, case_ids: ['7', '010', '024'],
    decision_mode: 'competition_calibrated', reuse_frozen_evidence: true,
    collection_concurrency: 1, case_concurrency: 2
  })
  assert.deepEqual(config.company_ids, ['007', '010', '024'])
  assert.equal(config.expected_company_count, 3)
  assert.doesNotThrow(() => validateBatchConfig(config))
})

test('submission supervisor records deterministic Champion/Challenger deltas without auto replacement', () => {
  const actionInitial = SEATS.map(id => direction(id, 'risk_flat'))
  const riskInitial = SEATS.map(id => advice(id, ['3']))
  const actionCalibration = calibrateActionCandidate({ initialDecisions: actionInitial, finalDecisions: actionInitial })
  const pool = buildExactSetCandidatePool({ initialDecisions: riskInitial, finalDecisions: riskInitial })
  const review = validReview(pool, actionCalibration, { action: '-1', risk_control_advice: ['4'] })
  review.challenge_strength = 'HIGH'
  review.challenge_champion = true
  const finalization = finalizeCalibratedDecision({ actionCalibration, candidatePool: pool, review, champion: { action: '-1', risk_control_advice: ['4'] } })
  const record = buildSubmissionSupervisorRecord({
    championScore: 26.4,
    priorScore: 24,
    championRows: [{ company_id: '001', action: '-1', risk_control_advice: '4' }],
    challengerRuns: [{ company_id: '001', evidence_changed: false, competition_finalization: finalization, report: { submission_row: { company_id: '001', action: finalization.action, risk_control_advice: finalization.risk_control_advice.join(',') } } }]
  })
  assert.equal(record.comparisons[0].recommended_status, 'CHALLENGE_HIGH')
  assert.equal(record.may_modify_submission, false)
  assert.equal(record.final_changeset_requires_explicit_confirmation, true)
})

test('audit-only protocol warnings produce FINALIZED_WITH_WARNING without changing the decision', () => {
  const initial = SEATS.map(id => joint(id, 'risk_flat', ['3']))
  const actionCalibration = calibrateActionCandidate({ initialDecisions: initial, finalDecisions: initial })
  const pool = buildExactSetCandidatePool({ initialDecisions: initial, finalDecisions: initial })
  const review = validReview(pool, actionCalibration, null)
  const finalization = finalizeCalibratedDecision({
    actionCalibration,
    candidatePool: pool,
    review,
    warnings: ['MISSING_EVIDENCE_REF']
  })
  assert.equal(finalization.finalization_status, 'FINALIZED_WITH_WARNING')
  assert.deepEqual(finalization.warnings, ['MISSING_EVIDENCE_REF'])
  assert.equal(finalization.action, '0')
  assert.deepEqual(finalization.risk_control_advice, ['3'])
})

test('calibrated provider uses the competition contract and fails closed without a format-repair call', async () => {
  const requests = []
  const provider = new MultiModelProvider({
    config: { contract_version: '1.0.0', profiles: { test: { provider: 'openai_compatible', base_url: 'https://model.example/v1', api_key: 'secret', model: 'test', max_retries: 0 } } },
    fetchImpl: async (_url, init) => {
      requests.push(JSON.parse(init.body))
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify({ answer: 'invalid-wrapper' }) } }] }) }
    }
  })
  await assert.rejects(() => provider.decideStage({
    agent: { agent_id: SEATS[0], model_profile: 'test' }, phase: 'competition_joint_decision', mode: 'competition_calibrated',
    prompt: [{ role: 'system', content: '比赛联合决策' }, { role: 'user', content: '{}' }]
  }), /single-pass JSON gate rejected|does not contain exactly/)
  assert.equal(requests.length, 1)
  assert.match(requests[0].messages[0].content, /action_candidate/)
  assert.match(requests[0].messages[0].content, /threshold_evidence/)
  assert.match(requests[0].messages[0].content, /label_assessments/)
})

test('calibrated provider treats the old exact wire shape as a warning after core validation', async () => {
  const provider = new MultiModelProvider({
    config: { contract_version: '1.0.0', profiles: { test: { provider: 'openai_compatible', base_url: 'https://model.example/v1', api_key: 'secret', model: 'test', max_retries: 0 } } },
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: JSON.stringify({
        execution_agent: SEATS[0],
        action_candidate: '0',
        action_confidence: 0.7,
        action_reason: ['未达到调整阈值'],
        transmission_evidence: [],
        threshold_evidence: [],
        counter_evidence: [],
        set_confidence: 0.6,
        label_assessments: [{ code: 3, necessary: true }],
        '风控建议': [3],
        '逻辑': []
      }) } }] })
    })
  })
  const value = await provider.decideStage({
    agent: { agent_id: SEATS[0], model_profile: 'test' }, phase: 'competition_joint_decision', mode: 'competition_calibrated',
    prompt: [{ role: 'system', content: '比赛联合决策' }, { role: 'user', content: '{}' }]
  })
  assert.equal(value.action, 0)
  assert.deepEqual(value.risk_control_advice, ['3'])
  assert.equal(value.model_provenance.protocol_validation.old_wire_shape_pass, false)
  assert.equal(value.model_provenance.protocol_validation.core_contract_pass, true)
  assert.equal(value.model_provenance.protocol_validation.adapter_applied, true)
  assert.ok(value.model_provenance.protocol_validation.warnings.includes('old_wire_validation_warning'))
})

test('reviewer candidate selection expands frozen IDs and missing reason only warns', () => {
  const decisions = SEATS.map(id => joint(id, 'risk_flat', ['3']))
  const actionCalibration = calibrateActionCandidate({ initialDecisions: decisions, finalDecisions: decisions })
  const candidatePool = buildExactSetCandidatePool({ initialDecisions: decisions, finalDecisions: decisions })
  const reviewCandidatePool = buildReviewerCandidatePool({ actionCalibration, candidatePool })
  const adapted = adaptCompetitionReviewerOutput({
    selected_action_candidate_id: reviewCandidatePool.action_candidates[0].id,
    selected_risk_candidate_id: reviewCandidatePool.risk_candidates[0].id,
    challenge_intent: false,
    evidence_strength: 'weak'
  }, { reviewCandidatePool })
  assert.deepEqual(validateCalibrationReview(adapted.value, { candidatePool, actionCalibration, reviewCandidatePool }), [])
  const finalization = finalizeCalibratedDecision({ actionCalibration, candidatePool, review: adapted.value, warnings: adapted.warnings, decisionMode: 'competition_calibrated_v2' })
  assert.equal(finalization.finalization_status, 'FINALIZED_WITH_WARNING')
  assert.equal(finalization.action, '0')
  assert.deepEqual(finalization.risk_control_advice, ['3'])
})

test('reviewer can select an explicitly frozen empty Risk set', () => {
  const actionDecisions = SEATS.map(id => joint(id, 'risk_flat', ['3']))
  const actionCalibration = calibrateActionCandidate({ initialDecisions: actionDecisions, finalDecisions: actionDecisions })
  const candidatePool = {
    candidates: [
      { candidate_id: 'risk:empty', value: [], independent_support_count: 1, post_broadcast_support_count: 1 }
    ]
  }
  const reviewCandidatePool = buildReviewerCandidatePool({ actionCalibration, candidatePool })
  const adapted = adaptCompetitionReviewerOutput({
    selected_action_candidate_id: reviewCandidatePool.action_candidates[0].id,
    selected_risk_candidate_id: 'risk:empty',
    challenge_intent: true,
    evidence_strength: 'weak'
  }, { reviewCandidatePool })
  assert.deepEqual(validateCalibrationReview(adapted.value, { candidatePool, actionCalibration, reviewCandidatePool }), [])
  const finalization = finalizeCalibratedDecision({ actionCalibration, candidatePool, review: adapted.value, warnings: adapted.warnings, decisionMode: 'competition_calibrated_v2' })
  assert.equal(finalization.finalization_status, 'FINALIZED_WITH_WARNING')
  assert.deepEqual(finalization.risk_control_advice, [])
  assert.equal(finalization.calibration_reviewer.challenge_strength, 'REVIEW')
})

test('reviewer selection rejects an unknown candidate ID', () => {
  const decisions = SEATS.map(id => joint(id, 'risk_flat', ['3']))
  const actionCalibration = calibrateActionCandidate({ initialDecisions: decisions, finalDecisions: decisions })
  const candidatePool = buildExactSetCandidatePool({ initialDecisions: decisions, finalDecisions: decisions })
  const reviewCandidatePool = buildReviewerCandidatePool({ actionCalibration, candidatePool })
  assert.throws(() => adaptCompetitionReviewerOutput({ selected_action_candidate_id: reviewCandidatePool.action_candidates[0].id, selected_risk_candidate_id: 'risk_X', challenge_intent: false, evidence_strength: 'weak' }, { reviewCandidatePool }), /outside the frozen candidate pool/)
})

test('reviewer selection rejects a missing Action candidate ID', () => {
  const reviewCandidatePool = { action_candidates: [], risk_candidates: [{ id: 'risk:3', value: ['3'] }], review_candidate_pool_hash: 'x' }
  assert.throws(() => adaptCompetitionReviewerOutput({ selected_risk_candidate_id: 'risk:3', challenge_intent: false, evidence_strength: 'weak' }, { reviewCandidatePool }), /selected_action_candidate_id/)
})

test('reviewer cannot create Risk by returning values instead of IDs', () => {
  const reviewCandidatePool = { action_candidates: [{ id: 'action:0', value: 0 }], risk_candidates: [{ id: 'risk:3', value: ['3'] }], review_candidate_pool_hash: 'x' }
  assert.throws(() => adaptCompetitionReviewerOutput({ selected_action_candidate_id: 'action:0', selected_risk_candidate_id: 'risk:3', risk_control_advice: ['3', '6'], challenge_intent: true, evidence_strength: 'strong' }, { reviewCandidatePool }), /cannot output Action or Risk values/)
})
