const test = require('node:test')
const assert = require('node:assert/strict')
const { runReliabilityEvaluation } = require('../evaluation/run-reliability-eval')

test('versioned reliability corpus preserves explicit values and rejects ambiguity or privilege expansion', () => {
  const result = runReliabilityEvaluation()
  assert.equal(result.summary.carrier_expected_acceptance_accuracy, 1)
  assert.equal(result.summary.accepted_business_value_preservation_rate, 1)
  assert.equal(result.summary.ambiguous_or_invalid_rejection_rate, 1)
  assert.equal(result.summary.forbidden_reviewer_selection_rejection_rate, 1)
  assert.equal(result.summary.role_view_leakage_rate, 0)
})
