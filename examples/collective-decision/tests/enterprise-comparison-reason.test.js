const test = require('node:test')
const assert = require('node:assert/strict')
const d = require('../src/enterprise-deliberation')
const {repairMode, assertRepairPreservesVerdict, nextReviewRepair} = require('../src/enterprise-review-repair')

function review() {
  return {
    consistent: true, selected_seat_id: 'chain_risk', selection_mode: 'equivalent_choice',
    review_reason: 'The overall choice is already explained.',
    candidate_reviews: [{seat_id: 'chain_risk', assessment: 'supported', reason: 'Evidence supports this candidate.',
      comparison_to_selected: {relation: 'selected', shared_object: null, quality_basis: null, reason: null,
        candidate_action_ids: [], selected_action_ids: [], alternative_object: null}}]
  }
}
const candidates = [{seat_id: 'chain_risk', recommendations: [3]}]

test('case 4 regression: selected comparison null reason identifies the exact field and permits only bounded format repair', () => {
  const value = review()
  for (const missing of [undefined, null, '', '  \n']) {
    value.candidate_reviews[0].comparison_to_selected.reason = missing
    const errors = d.validateSelectionComparison(value, candidates)
    assert.equal(errors.length, 1)
    assert.match(errors[0], /^\[REVIEW_COMPARISON_REASON_REQUIRED\]/)
    assert.match(errors[0], /candidate_reviews\[0\].comparison_to_selected\.reason/)
    assert(!errors[0].includes('chain_risk')) // Keep anonymous transport identities out of repair prose.
    assert.equal(repairMode(errors), 'format_only')
    assert.equal(nextReviewRepair({attempt: 0, errors, value}).mode, 'format_only')
    assert.equal(nextReviewRepair({attempt: 1, errors, value}), null)
  }
  const repaired = structuredClone(value)
  repaired.candidate_reviews[0].comparison_to_selected.reason = 'This is the selected whole candidate; its own evidence and necessary actions support the choice.'
  assert.deepEqual(d.validateSelectionComparison(repaired, candidates), [])
  assert.doesNotThrow(() => assertRepairPreservesVerdict(value, repaired, {stage: 'condition', candidates}))
  repaired.consistent = false
  assert.throws(() => assertRepairPreservesVerdict(value, repaired, {stage: 'condition', candidates}), {code: 'ENTERPRISE_REVIEW_VERDICT_DRIFT'})
})

test('all supported comparison relations require their own reason; unknown objects and enums have field-specific feedback', () => {
  const value = review()
  for (const relation of ['selected', 'weaker', 'equivalent', 'not_comparable']) {
    value.candidate_reviews[0].comparison_to_selected.relation = relation
    assert(d.validateSelectionComparison(value, candidates).some(e => e.startsWith('[REVIEW_COMPARISON_REASON_REQUIRED]')))
  }
  value.candidate_reviews[0].comparison_to_selected = null
  assert.equal(repairMode(d.validateSelectionComparison(value, candidates)), 'format_only')
  assert.match(d.validateSelectionComparison(value, candidates)[0], /^\[REVIEW_COMPARISON_OBJECT_REQUIRED\]/)
  value.candidate_reviews[0].comparison_to_selected = {relation: 'chosen', reason: 'Existing text'}
  assert.match(d.validateSelectionComparison(value, candidates)[0], /^\[REVIEW_COMPARISON_RELATION_INVALID\]/)
})

test('missing comparison prose does not turn substantive selection errors into format repairs', () => {
  const value = review()
  value.candidate_reviews.push({seat_id: 'other', assessment: 'supported', comparison_to_selected: {relation: 'equivalent', reason: 'Equal on the known object'}})
  value.selection_mode = 'quality_difference'
  const errors = d.validateSelectionComparison(value, [...candidates, {seat_id: 'other', recommendations: [3]}])
  assert(errors.some(e => e.startsWith('[REVIEW_COMPARISON_REASON_REQUIRED]')))
  assert(errors.includes('不得将等效或不可跨视角比较的成立方案声明为质量劣势'))
  assert.equal(repairMode(errors), 'business_reassessment')
})

test('condition review declares relation-specific requirements and non-null selected examples without changing direction review', () => {
  const args = {policy: '', question: {}, rules: [], candidates, evidence: [], arbitrationRules: d.reviewRules('condition')}
  const prompt = d.buildReviewPrompt({...args, stage: 'condition'})
  const contract = JSON.parse(prompt[1].content).review_output_contract.comparison_to_selected
  assert.deepEqual(contract.required_common_fields, ['relation', 'reason'])
  assert.deepEqual(contract.required_by_relation.selected, ['relation', 'reason'])
  assert(contract.required_by_relation.weaker.includes('candidate_action_ids'))
  assert(contract.required_by_relation.not_comparable.includes('alternative_object'))
  assert(!contract.optional_for_non_weaker.includes('reason'))
  for (const example of Object.values(contract.examples)) assert.equal(typeof example.reason, 'string')
  assert.match(prompt[0].content, /非weaker仅可省略shared_object、quality_basis、candidate_action_ids及selected_action_ids，reason始终必填/)
  const direction = d.buildReviewPrompt({...args, stage: 'direction'})
  assert.equal(JSON.parse(direction[1].content).review_output_contract.comparison_to_selected, undefined)
})
