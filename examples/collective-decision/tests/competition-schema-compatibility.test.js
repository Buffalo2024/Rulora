const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const Ajv2020 = require('ajv/dist/2020')
const addFormats = require('ajv-formats')
const { normalizeCompetitionStageDecision } = require('../src/competition-response-normalizer')
const { parseJsonObject } = require('../src/providers/multi-model-provider')
const { adaptCompetitionReviewerOutput, adaptCompetitionSeatOutput } = require('../src/competition-output-adapter')
const { buildReviewerCandidatePool, validateCalibrationReview } = require('../src/competition-mode')

const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false })
addFormats(ajv)
const validate = ajv.compile(JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'schemas', 'competition-stage-decision.schema.json'), 'utf8')))

function rawDecision(overrides = {}) {
  return {
    execution_agent: 'industry_chain_analyst',
    action_candidate: 0,
    action_confidence: 0.6,
    action_reason: ['未达调整门槛'],
    transmission_evidence: [],
    threshold_evidence: [],
    counter_evidence: ['e1'],
    set_confidence: 0.7,
    label_assessments: [{ code: '3', necessary: true, why_required: ['需要监控'], why_deletable: [], counter_evidence: [] }],
    '风控建议': ['3'],
    '逻辑': [{ claim: '风险未达调额门槛', mechanism: '存在反向证据', evidence_refs: ['e1'] }],
    ...overrides
  }
}

function normalize(value) {
  return normalizeCompetitionStageDecision(value, {
    phase: 'competition_joint_decision',
    expectedAgentId: 'industry_chain_analyst'
  })
}

test('competition compatibility T2 parses a fenced unique JSON object without a model repair', () => {
  const parsed = parseJsonObject(`\`\`\`json\n${JSON.stringify(rawDecision())}\n\`\`\``)
  assert.equal(parsed.action_candidate, 0)
})

test('competition compatibility T3 canonicalizes an unambiguous string Action to integer', () => {
  const result = normalize(rawDecision({ action_candidate: '0' }))
  assert.equal(result.value.action_candidate, 0)
  assert.ok(result.operations.some(item => item.operation === 'integer_string_to_number'))
  assert.equal(validate(result.value), true)
})

test('competition compatibility T4 canonicalizes numeric Risk codes without changing the set', () => {
  const result = normalize(rawDecision({ '风控建议': [3], label_assessments: [{ code: 3, necessary: true, why_required: ['需要'], why_deletable: [], counter_evidence: [] }] }))
  assert.deepEqual(result.value['风控建议'], ['3'])
  assert.deepEqual(result.value.label_assessments.map(item => item.code), ['3'])
  assert.equal(validate(result.value), true)
})

test('competition compatibility T5 derives only routing aliases, direction alias, and evidence union', () => {
  const result = normalize(rawDecision())
  assert.equal(result.value['执行员'], 'industry_chain_analyst')
  assert.equal(result.value['经营调整方向'], 'risk_flat')
  assert.deepEqual(result.value['证据'], ['e1'])
  assert.equal(validate(result.value), true)
})

test('competition compatibility T6 fails closed when Action is missing', () => {
  const raw = rawDecision()
  delete raw.action_candidate
  assert.equal(validate(normalize(raw).value), false)
})

test('competition compatibility T7 fails closed when the complete Risk set is missing', () => {
  const raw = rawDecision()
  delete raw['风控建议']
  assert.equal(validate(normalize(raw).value), false)
})

test('competition compatibility T8 fails closed on an illegal Risk code', () => {
  const result = normalize(rawDecision({ '风控建议': ['10'], label_assessments: [{ code: '10', necessary: true, why_required: ['需要'], why_deletable: [], counter_evidence: [] }] }))
  assert.equal(validate(result.value), false)
})

test('competition compatibility T9 never changes Action semantics', () => {
  for (const action of [-1, 0, 1, '-1', '0', '1']) {
    const result = normalize(rawDecision({ action_candidate: action }))
    assert.equal(String(result.value.action_candidate), String(action))
  }
})

test('competition compatibility T10 never adds or deletes Risk labels', () => {
  const risk = [2, 5]
  const result = normalize(rawDecision({
    '风控建议': risk,
    label_assessments: risk.map(code => ({ code, necessary: true, why_required: '需要', why_deletable: '不可删', counter_evidence: [] }))
  }))
  assert.deepEqual(result.value['风控建议'], ['2', '5'])
})

test('competition compatibility preserves fail-closed semantics for unsupported logic', () => {
  const result = normalize(rawDecision({ '逻辑': [{ claim: '无引用', mechanism: '不得猜测', evidence_refs: [] }] }))
  assert.equal(validate(result.value), false)
  assert.ok(validate.errors.some(error => error.instancePath.endsWith('/evidence_refs') && error.keyword === 'minItems'))
})

test('formal adapter maps stable model aliases and deterministic primitive types', () => {
  const adapted = adaptCompetitionSeatOutput({ action_candidate: '0', risk_set_candidate: [3, 8], reason: 'xxx' }, { expectedAgentId: 'seat-a' })
  assert.equal(adapted.value.action, 0)
  assert.deepEqual(adapted.value.risk_control_advice, ['3', '8'])
  assert.ok(adapted.value.warnings.includes('MISSING_EVIDENCE_REF'))
})

test('formal adapter maps risk_mitigation_labels without changing string codes', () => {
  const adapted = adaptCompetitionSeatOutput({ action_candidate: 1, risk_mitigation_labels: ['3', '6'] })
  assert.equal(adapted.value.action, 1)
  assert.deepEqual(adapted.value.risk_control_advice, ['3', '6'])
})

test('formal adapter canonicalizes numeric risk_mitigation_labels', () => {
  const adapted = adaptCompetitionSeatOutput({ action_candidate: 0, risk_mitigation_labels: [3, 8] })
  assert.equal(adapted.value.action, 0)
  assert.deepEqual(adapted.value.risk_control_advice, ['3', '8'])
})

test('formal adapter maps risk_mitigation_recommendations and records its source field', () => {
  const adapted = adaptCompetitionSeatOutput({ action_candidate: 1, risk_mitigation_recommendations: ['3', '6'] })
  assert.deepEqual(adapted.value.risk_control_advice, ['3', '6'])
  assert.equal(adapted.value.risk_source_field, 'risk_mitigation_recommendations')
})

test('formal adapter accepts comma-delimited Chinese Risk alias without changing its set', () => {
  const adapted = adaptCompetitionSeatOutput({ action_candidate: 1, '风控建议': '3,8' })
  assert.deepEqual(adapted.value.risk_control_advice, ['3', '8'])
  assert.equal(adapted.value.risk_source_field, '风控建议')
})

test('formal adapter still fails closed when every Risk alias is absent', () => {
  assert.throws(() => adaptCompetitionSeatOutput({ action_candidate: 0 }), /Risk set is missing/)
})

test('missing audit evidence finalizes as warning-compatible core decision', () => {
  const adapted = adaptCompetitionSeatOutput({ action: 0, risk_control_advice: ['3'], evidence_refs: [] }, { expectedAgentId: 'seat-a' })
  assert.equal(adapted.value.action, 0)
  assert.deepEqual(adapted.value.risk_control_advice, ['3'])
  assert.ok(adapted.value.warnings.includes('MISSING_EVIDENCE_REF'))
})

test('formal adapter fails closed when Action is absent', () => {
  assert.throws(() => adaptCompetitionSeatOutput({ risk_control_advice: ['3'] }), /Action is missing/)
})

test('formal adapter fails closed on an illegal Risk code', () => {
  assert.throws(() => adaptCompetitionSeatOutput({ action: 0, risk_control_advice: ['10'] }), /Risk set is invalid/)
})

test('formal adapter accepts an explicitly empty Risk set', () => {
  const adapted = adaptCompetitionSeatOutput({ action: 0, risk_control_advice: [] }, { expectedAgentId: 'seat-a' })
  assert.deepEqual(adapted.value.risk_control_advice, [])
})

test('missing label assessment is marked missing instead of being attributed to the model', () => {
  const adapted = adaptCompetitionSeatOutput({ action: 0, risk_control_advice: ['3'] }, { expectedAgentId: 'seat-a' })
  assert.equal(adapted.value.label_assessments[0].necessary, null)
  assert.equal(adapted.value.label_assessments[0].assessment_source, 'missing')
  assert.equal(adapted.value.audit_field_sources.label_assessments, 'missing')
})

test('reviewer reason is audit-only and a single wrapper object is accepted', () => {
  const actionCalibration = { calibrated_action: '0', threshold_passed: true, threshold_by_direction: { risk_flat: { passed: true } }, support: { candidates: [{ candidate_id: 'action:0', value: 'risk_flat', independent_support_count: 3, post_broadcast_support_count: 3 }] } }
  const pool = { candidates: [{ candidate_id: 'risk:empty', value: [] }] }
  const reviewCandidatePool = buildReviewerCandidatePool({ actionCalibration, candidatePool: pool })
  const adapted = adaptCompetitionReviewerOutput({ result: { selected_action_candidate_id: 'action:0', selected_risk_candidate_id: 'risk:empty', challenge_intent: true, evidence_strength: 'strong' } }, { reviewCandidatePool })
  assert.equal(adapted.value.action, 0)
  assert.deepEqual(adapted.value.risk_control_advice, [])
  assert.deepEqual(adapted.value.reason, [])
  assert.ok(adapted.value.warnings.includes('AUDIT_FIELD_MISSING'))
})

test('reviewer normal JSON candidate selection passes the role adapter', () => {
  const actionCalibration = { calibrated_action: '0', threshold_passed: true, threshold_by_direction: { risk_flat: { passed: true } }, support: { candidates: [{ candidate_id: 'action:0', value: 'risk_flat' }] } }
  const pool = { candidates: [{ candidate_id: 'risk:3', value: ['3'] }] }
  const reviewCandidatePool = buildReviewerCandidatePool({ actionCalibration, candidatePool: pool })
  const adapted = adaptCompetitionReviewerOutput({ selected_action_candidate_id: 'action:0', selected_risk_candidate_id: 'risk:3', challenge_intent: true, evidence_strength: 'strong' }, { reviewCandidatePool })
  assert.equal(adapted.value.action, 0)
  assert.deepEqual(adapted.value.risk_control_advice, ['3'])
  assert.equal(adapted.value.challenge_level, 'HIGH')
})

test('reviewer cannot add a Risk label outside frozen candidate sets', () => {
  const reviewCandidatePool = { action_candidates: [{ id: 'action:0', value: 0 }], risk_candidates: [{ id: 'risk:3', value: ['3'] }], review_candidate_pool_hash: 'x' }
  assert.throws(() => adaptCompetitionReviewerOutput({ selected_action_candidate_id: 'action:0', selected_risk_candidate_id: 'risk:3', risk_control_advice: ['3', '8'], challenge_intent: true, evidence_strength: 'strong' }, { reviewCandidatePool }), /cannot output Action or Risk values/)
})
