const fs = require('node:fs')
const path = require('node:path')
const { replayCompetitionOutput } = require('../src/llm-output-trace')
const { adaptCompetitionReviewerOutput } = require('../src/competition-output-adapter')
const { MODEL_DISCLOSURE_POLICY, projectModelDisclosure } = require('../src/role-disclosure')
const { canonicalJson } = require('../src/utils')

const corpus = JSON.parse(fs.readFileSync(path.join(__dirname, 'reliability-corpus.json'), 'utf8'))

function runReliabilityEvaluation() {
  const carrierResults = corpus.carrier_cases.map(item => {
    const replay = replayCompetitionOutput({
      raw_model_response: item.raw,
      stage_phase: item.phase,
      operation: 'decideStage',
      decision_mode: 'competition_calibrated_v2',
      expected_agent_id: 'evaluation-seat'
    })
    const accepted = replay.status === 'REPLAY_PASS'
    const actualValue = item.phase === 'decision_direction'
      ? replay.adapter_result?.action_candidate
      : replay.adapter_result?.risk_control_advice
    const preserved = item.expect === 'accept' && accepted
      ? canonicalJson(actualValue) === canonicalJson(item.expected_value)
      : null
    return {
      id: item.id,
      expected: item.expect,
      actual: accepted ? 'accept' : 'reject',
      business_value_preserved: preserved,
      classification: replay.classification
    }
  })

  const reviewCandidatePool = {
    action_candidates: [{ id: 'action:0', value: 0 }],
    risk_candidates: [{ id: 'risk:3', value: ['3'] }],
    review_candidate_pool_hash: 'evaluation-pool'
  }
  const reviewerResults = corpus.reviewer_cases.map(item => {
    let accepted = false
    try {
      adaptCompetitionReviewerOutput({
        selected_action_candidate_id: item.action_id,
        selected_risk_candidate_id: item.risk_id,
        challenge_intent: false,
        evidence_strength: 'moderate'
      }, { reviewCandidatePool })
      accepted = true
    } catch {}
    return { id: item.id, expected: item.expect, actual: accepted ? 'accept' : 'reject' }
  })

  const disclosureResults = Object.entries(MODEL_DISCLOSURE_POLICY).map(([operation, allowed]) => {
    const source = Object.fromEntries([...allowed, 'api_key', 'raw_model_output', 'internal_trace'].map(key => [key, `value:${key}`]))
    const projected = projectModelDisclosure(source, operation)
    const leaked = ['api_key', 'raw_model_output', 'internal_trace'].filter(key => Object.hasOwn(projected, key))
    return { operation, allowed_field_count: allowed.length, leaked_fields: leaked }
  })

  const acceptedCarrier = carrierResults.filter(item => item.expected === 'accept')
  const rejectedCarrier = carrierResults.filter(item => item.expected === 'reject')
  const rejectedReviewer = reviewerResults.filter(item => item.expected === 'reject')
  const summary = {
    corpus_version: corpus.contract_version,
    carrier_case_count: carrierResults.length,
    carrier_expected_acceptance_accuracy: ratio(acceptedCarrier.filter(item => item.actual === 'accept').length, acceptedCarrier.length),
    accepted_business_value_preservation_rate: ratio(acceptedCarrier.filter(item => item.business_value_preserved === true).length, acceptedCarrier.length),
    ambiguous_or_invalid_rejection_rate: ratio(rejectedCarrier.filter(item => item.actual === 'reject').length, rejectedCarrier.length),
    forbidden_reviewer_selection_rejection_rate: ratio(rejectedReviewer.filter(item => item.actual === 'reject').length, rejectedReviewer.length),
    role_view_leakage_rate: ratio(disclosureResults.filter(item => item.leaked_fields.length > 0).length, disclosureResults.length)
  }
  return { summary, carrier_results: carrierResults, reviewer_results: reviewerResults, disclosure_results: disclosureResults }
}

function ratio(numerator, denominator) {
  return denominator ? Math.round(numerator / denominator * 10000) / 10000 : null
}

if (require.main === module) process.stdout.write(`${JSON.stringify(runReliabilityEvaluation(), null, 2)}\n`)

module.exports = { runReliabilityEvaluation }
