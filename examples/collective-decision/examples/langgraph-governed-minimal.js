const { Annotation, END, START, StateGraph } = require('@langchain/langgraph')
const { recoverCompetitionOutput } = require('../src/competition-output-recovery')
const { adaptCompetitionReviewerOutput, adaptCompetitionSeatOutput } = require('../src/competition-output-adapter')
const { projectRoleContext, assertRoleContext } = require('../src/role-disclosure')
const { canonicalJson, sha256 } = require('../src/utils')

const fixture = Object.freeze({
  case_id: 'demo-incident-001',
  task: '在不创造新选项的前提下，从三个独立席位的建议中选择响应方案。',
  evidence: [
    { id: 'E1', fact: '核心服务错误率超过阈值。' },
    { id: 'E2', fact: '回滚预演在测试环境已通过。' }
  ],
  raw_seat_outputs: [
    '```json\n{"execution_agent":"seat-a","action_candidate":-1,"risk_control_advice":["3"]}\n```',
    '{\n"execution_agent":"seat-b"\n"action_candidate":-1,\n"risk_control_advice":["3"]\n}',
    '{"execution_agent":"seat-c","action_candidate":0,"risk_control_advice":["6"]}'
  ]
})

const State = Annotation.Root({
  input: Annotation(),
  role_views: Annotation(),
  normalized_seats: Annotation(),
  frozen_candidate_pool: Annotation(),
  reviewer_selection: Annotation(),
  final_decision: Annotation(),
  audit: Annotation()
})

function independentSeats(state) {
  const input = state.input || fixture
  const seatView = projectRoleContext(input, 'independent_seat')
  assertRoleContext(seatView, 'independent_seat')
  return {
    input,
    role_views: { independent_seat: seatView },
    audit: [{ node: 'independent_seats', disclosed_fields: Object.keys(seatView) }]
  }
}

function recoverAndAdapt(state) {
  const normalized = state.input.raw_seat_outputs.map((raw, index) => {
    const recovered = recoverCompetitionOutput(raw)
    const adapted = adaptCompetitionSeatOutput(recovered.value, { expectedAgentId: `seat-${String.fromCharCode(97 + index)}` })
    return {
      seat_id: adapted.value.execution_agent,
      action: adapted.value.action,
      risk_control_advice: adapted.value.risk_control_advice,
      recovery: recovered.output_recovery,
      adapter_warnings: adapted.warnings
    }
  })
  return {
    normalized_seats: normalized,
    audit: [...state.audit, { node: 'recover_and_adapt', accepted_seats: normalized.length }]
  }
}

function freezeCandidates(state) {
  const unique = new Map()
  for (const seat of state.normalized_seats) {
    const key = canonicalJson({ action: seat.action, risk_control_advice: seat.risk_control_advice })
    const current = unique.get(key) || { value: JSON.parse(key), support: [], candidate_id: `candidate:${sha256(key).slice(0, 12)}` }
    current.support.push(seat.seat_id)
    unique.set(key, current)
  }
  const candidates = [...unique.values()].sort((left, right) => right.support.length - left.support.length)
  const poolBase = {
    action_candidates: candidates.map(item => ({ id: `${item.candidate_id}:action`, value: item.value.action })),
    risk_candidates: candidates.map(item => ({ id: `${item.candidate_id}:risk`, value: item.value.risk_control_advice })),
    candidates
  }
  const frozen = { ...poolBase, review_candidate_pool_hash: sha256(canonicalJson(poolBase)) }
  const reviewerView = projectRoleContext({ ...state.input, frozen_candidate_pool: frozen }, 'constrained_reviewer')
  assertRoleContext(reviewerView, 'constrained_reviewer')
  return {
    frozen_candidate_pool: frozen,
    role_views: { ...state.role_views, constrained_reviewer: reviewerView },
    audit: [...state.audit, { node: 'freeze_candidates', pool_hash: frozen.review_candidate_pool_hash }]
  }
}

function constrainedReview(state) {
  const leader = state.frozen_candidate_pool.candidates[0]
  const rawSelection = {
    selected_action_candidate_id: `${leader.candidate_id}:action`,
    selected_risk_candidate_id: `${leader.candidate_id}:risk`,
    challenge_intent: false,
    evidence_strength: 'moderate',
    selection_reason: ['选择已冻结且支持席位最多的候选。']
  }
  const reviewed = adaptCompetitionReviewerOutput(rawSelection, { reviewCandidatePool: state.frozen_candidate_pool })
  return {
    reviewer_selection: reviewed.value,
    audit: [...state.audit, { node: 'constrained_review', selected_ids: [rawSelection.selected_action_candidate_id, rawSelection.selected_risk_candidate_id] }]
  }
}

function deliver(state) {
  const finalDecision = {
    action: state.reviewer_selection.action,
    risk_control_advice: state.reviewer_selection.risk_control_advice,
    source: 'program_expansion_of_frozen_candidate_ids'
  }
  const deliveryView = projectRoleContext({
    case_id: state.input.case_id,
    final_decision: finalDecision,
    audit_summary: { candidate_pool_hash: state.frozen_candidate_pool.review_candidate_pool_hash }
  }, 'delivery')
  assertRoleContext(deliveryView, 'delivery')
  return {
    final_decision: finalDecision,
    role_views: { ...state.role_views, delivery: deliveryView },
    audit: [...state.audit, { node: 'deliver', status: 'PASS' }]
  }
}

const workflow = new StateGraph(State)
  .addNode('independent_seats', independentSeats)
  .addNode('recover_and_adapt', recoverAndAdapt)
  .addNode('freeze_candidates', freezeCandidates)
  .addNode('constrained_review', constrainedReview)
  .addNode('deliver', deliver)
  .addEdge(START, 'independent_seats')
  .addEdge('independent_seats', 'recover_and_adapt')
  .addEdge('recover_and_adapt', 'freeze_candidates')
  .addEdge('freeze_candidates', 'constrained_review')
  .addEdge('constrained_review', 'deliver')
  .addEdge('deliver', END)

const graph = workflow.compile()

async function runMinimalExample(input = fixture) {
  return graph.invoke({ input })
}

if (require.main === module) {
  runMinimalExample().then(result => process.stdout.write(`${JSON.stringify({
    final_decision: result.final_decision,
    recovery_modes: result.normalized_seats.map(item => item.recovery.mode),
    disclosed_fields: Object.fromEntries(Object.entries(result.role_views).map(([role, view]) => [role, Object.keys(view)])),
    audit: result.audit
  }, null, 2)}\n`)).catch(error => {
    process.stderr.write(`${error.stack || error}\n`)
    process.exitCode = 1
  })
}

module.exports = { fixture, graph, runMinimalExample }
