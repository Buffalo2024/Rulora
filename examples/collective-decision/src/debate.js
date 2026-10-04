const { PROBABILITY_LABELS } = require('./contracts')
const { sha256 } = require('./utils')

const SEVERITY_ORDER = { low: 0, medium: 1, high: 2 }

function validateDebateConfig(config) {
  if (!config || config.contract_version !== '5.0.0') throw new Error('debate config contract_version must be 5.0.0')
  const forced = config.forced_conclusion_policy
  if (!forced || forced.high_or_unanswered_result !== 'risk_up') throw new Error('debate forced_conclusion_policy.high_or_unanswered_result must be risk_up')
  for (const key of ['high_risk_advice_code', 'hold_advice_code', 'clean_conclusion_grade', 'forced_high_conclusion_grade', 'forced_other_conclusion_grade']) {
    if (!forced[key]) throw new Error(`debate forced_conclusion_policy.${key} is required`)
  }
  const protocol = config.protocol
  if (!protocol || protocol.type !== 'two_stage_four_module_self_review') throw new Error('debate protocol must be two_stage_four_module_self_review')
  if (protocol.seat_count !== 3 || protocol.same_seats_in_both_stages !== true) throw new Error('two-stage debate requires the same three seats')
  if (protocol.context_format !== 'compact_json' || protocol.forward_raw_model_output !== false) throw new Error('debate context must be compact JSON without raw model output')
  if (protocol.industry_plan_precedes_single_collection !== true || protocol.maximum_collection_rounds !== 1) throw new Error('industry plan must precede exactly one evidence collection')
  if (protocol.maximum_self_review_rounds_per_stage !== 1 || protocol.one_final_output_per_seat !== true) throw new Error('each seat must emit at most one final self-review output per stage')
  if (protocol.flat_four_modules !== true || protocol.retain_challenge_records !== false) throw new Error('production debate must use flat four modules without challenge records')
  if (protocol.freeze_direction_before_advice !== true || protocol.majority_threshold !== 2 || protocol.no_majority_resolution !== 'manual_evidence_adjudication') throw new Error('two-stage freeze/vote/adjudication rules are invalid')
  if (JSON.stringify(protocol.direction_modules) !== JSON.stringify(['执行员', '经营调整方向', '逻辑', '证据'])) throw new Error('direction four-module contract mismatch')
  if (JSON.stringify(protocol.advice_modules) !== JSON.stringify(['执行员', '风控建议', '逻辑', '证据'])) throw new Error('advice four-module contract mismatch')
  return config
}

function buildReviewAssignments(agents, opinions, reviewsPerAgent) {
  const opinionById = new Map(opinions.map(opinion => [opinion.agent_id, opinion]))
  if (agents.length < 2) throw new Error('debate requires at least two agents')
  const count = Math.min(reviewsPerAgent, agents.length - 1)
  const assignments = []
  for (let reviewerIndex = 0; reviewerIndex < agents.length; reviewerIndex += 1) {
    for (let offset = 1; offset <= count; offset += 1) {
      const reviewer = agents[reviewerIndex]
      const targetAgent = agents[(reviewerIndex + offset) % agents.length]
      const targetOpinion = opinionById.get(targetAgent.agent_id)
      if (!targetOpinion) throw new Error(`missing debate opinion for ${targetAgent.agent_id}`)
      assignments.push({ reviewer, targetOpinion })
    }
  }
  return assignments
}

function classifyChallenge(category, impact, policy) {
  if (!policy.allowed_impacts.includes(impact)) throw new Error(`unsupported challenge impact: ${impact}`)
  if (policy.high_always_categories.includes(category)) return 'high'
  if (policy.low_only_categories.includes(category)) {
    if (impact !== 'no_decision_impact') throw new Error(`low-only category ${category} must use no_decision_impact`)
    return 'low'
  }
  if (!policy.impact_sensitive_categories.includes(category)) throw new Error(`unsupported challenge category: ${category}`)
  if (policy.high_impacts.includes(impact)) return 'high'
  if (policy.medium_impacts.includes(impact)) return 'medium'
  if (impact === 'no_decision_impact') return 'medium'
  throw new Error(`challenge category ${category} and impact ${impact} have no severity mapping`)
}

function normalizeCritique(critique, roundNumber, config, seenIssueKeys = new Set()) {
  if (!critique || !Array.isArray(critique.challenges)) throw new Error('critique challenges must be an array')
  if (critique.challenges.length > config.maximum_challenges_per_critique) {
    throw new Error(`critique challenge count ${critique.challenges.length} exceeds ${config.maximum_challenges_per_critique}`)
  }
  let suppressedDuplicateCount = 0
  const challenges = critique.challenges.flatMap((challenge, index) => {
    if (!challenge.category || !challenge.impact || !challenge.target_result || !Array.isArray(challenge.evidence_refs) || !challenge.claim || !challenge.logic_gap || !challenge.requested_test) {
      throw new Error('critique challenge lacks result-evidence-logic fields')
    }
    const issueKey = challengeIssueKey(critique.target_agent_id, challenge)
    if (config.suppress_repeated_issue_keys && seenIssueKeys.has(issueKey)) {
      suppressedDuplicateCount += 1
      return []
    }
    seenIssueKeys.add(issueKey)
    return [{
      ...challenge,
      issue_key: issueKey,
      type: challenge.type || challenge.category,
      challenge_id: `r${roundNumber}:${critique.reviewer_id}->${critique.target_agent_id}:${index + 1}`,
      program_severity: classifyChallenge(challenge.category, challenge.impact, config.severity_policy)
    }]
  })
  return {
    ...critique,
    round: roundNumber,
    challenges,
    suppressed_duplicate_count: suppressedDuplicateCount,
    severity: maximumSeverity(challenges.map(challenge => challenge.program_severity))
  }
}

function mergeCarryoverChallenges(critiques, openChallenges) {
  return critiques.map(critique => {
    const carried = [...openChallenges.values()]
      .filter(challenge => challenge.reviewer_id === critique.reviewer_id && challenge.target_agent_id === critique.target_agent_id)
      .map(challenge => structuredClone(challenge))
    const currentIds = new Set(critique.challenges.map(challenge => challenge.challenge_id))
    const challenges = [...critique.challenges, ...carried.filter(challenge => !currentIds.has(challenge.challenge_id))]
    return { ...critique, challenges, severity: maximumSeverity(challenges.map(challenge => challenge.program_severity)) }
  })
}

function updateOpenChallenges({ openChallenges, newCritiques, effectiveCritiques, afterOpinions }) {
  const next = new Map(openChallenges)
  for (const critique of newCritiques) {
    for (const challenge of critique.challenges) {
      next.set(challenge.challenge_id, {
        ...structuredClone(challenge),
        reviewer_id: critique.reviewer_id,
        target_agent_id: critique.target_agent_id,
        opened_round: critique.round
      })
    }
  }
  const responseByChallenge = new Map(afterOpinions
    .flatMap(opinion => opinion.revision?.responses || [])
    .map(response => [response.challenge_id, response]))
  for (const critique of effectiveCritiques) {
    for (const challenge of critique.challenges) {
      const response = responseByChallenge.get(challenge.challenge_id)
      if (response && ['accepted', 'rejected_with_evidence'].includes(response.resolution)) next.delete(challenge.challenge_id)
      else if (!next.has(challenge.challenge_id)) {
        next.set(challenge.challenge_id, {
          ...structuredClone(challenge),
          reviewer_id: critique.reviewer_id,
          target_agent_id: critique.target_agent_id,
          opened_round: critique.round
        })
      }
    }
  }
  return next
}

function assessDebateRound({
  roundNumber,
  beforeOpinions,
  afterOpinions,
  newCritiques,
  effectiveCritiques,
  openChallenges,
  expectedReviewCount,
  config
}) {
  const responses = afterOpinions.flatMap(opinion => opinion.revision?.responses || [])
  const responseByChallenge = new Map(responses.map(response => [response.challenge_id, response]))
  const effectiveChallenges = uniqueChallenges(effectiveCritiques.flatMap(critique => critique.challenges || []))
  const unansweredChallengeIds = effectiveChallenges
    .map(challenge => challenge.challenge_id)
    .filter(challengeId => !responseByChallenge.has(challengeId))
  const unresolvedChallengeIds = responses
    .filter(response => response.resolution === 'unresolved')
    .map(response => response.challenge_id)
  const unresolvedImportant = [...openChallenges.values()]
    .filter(challenge => config.important_severities.includes(challenge.program_severity))
  const unresolvedHigh = unresolvedImportant.filter(challenge => challenge.program_severity === 'high')
  const newChallenges = uniqueChallenges(newCritiques.flatMap(critique => critique.challenges || []))
  const newImportant = newChallenges.filter(challenge => config.important_severities.includes(challenge.program_severity))
  const severityById = new Map(effectiveChallenges.map(challenge => [challenge.challenge_id, challenge.program_severity]))
  const importantResolutionActivity = responses.filter(response =>
    config.important_severities.includes(severityById.get(response.challenge_id)) &&
    ['accepted', 'rejected_with_evidence'].includes(response.resolution)
  )
  const resultLabels = afterOpinions.map(opinion => PROBABILITY_LABELS.includes(opinion.result_candidate) ? opinion.result_candidate : winningLabel(opinion.probabilities))
  const resultConsensus = new Set(resultLabels).size === 1
  const decisionSignatures = afterOpinions.map(decisionSignature)
  const decisionConsensus = new Set(decisionSignatures).size === 1
  const responsesComplete = unansweredChallengeIds.length === 0
  const reviewCoverageComplete = newCritiques.length === expectedReviewCount
  const clean = responsesComplete &&
    reviewCoverageComplete &&
    unresolvedImportant.length === 0 &&
    decisionConsensus
  return {
    round: roundNumber,
    critique_count: newCritiques.length,
    new_challenge_count: newChallenges.length,
    effective_challenge_count: effectiveChallenges.length,
    response_count: responses.length,
    review_coverage_complete: reviewCoverageComplete,
    unanswered_challenge_ids: unansweredChallengeIds,
    unresolved_challenge_ids: unresolvedChallengeIds,
    unresolved_important_ids: unresolvedImportant.map(challenge => challenge.challenge_id),
    unresolved_high_severity_ids: unresolvedHigh.map(challenge => challenge.challenge_id),
    new_important_challenge_ids: newImportant.map(challenge => challenge.challenge_id),
    important_resolution_activity_ids: importantResolutionActivity.map(response => response.challenge_id),
    result_labels: resultLabels,
    result_consensus: resultConsensus,
    decision_signatures: decisionSignatures,
    decision_consensus: decisionConsensus,
    suppressed_duplicate_challenge_count: newCritiques.reduce((sum, critique) => sum + Number(critique.suppressed_duplicate_count || 0), 0),
    clean
  }
}

function decisionSignature(opinion) {
  const result = PROBABILITY_LABELS.includes(opinion?.result_candidate)
    ? opinion.result_candidate
    : winningLabel(opinion?.probabilities || {})
  const advice = [...new Set((opinion?.recommended_advice || []).map(String))]
    .filter(code => /^[1-9]$/.test(code))
    .sort((left, right) => Number(left) - Number(right))
  return JSON.stringify({ result_candidate: result, recommended_advice: advice })
}

function buildDebateTermination({ rounds, config, cleanStreak, limitReason = null }) {
  if (!rounds.length) throw new Error('debate cannot terminate without a completed round')
  const latest = rounds.at(-1).summary
  const cleanGateSatisfied = cleanStreak >= config.minimum_consecutive_clean_rounds_for_exit
  return {
    status: cleanGateSatisfied ? 'clean_exit' : 'forced_conclusion_exit',
    reason: cleanGateSatisfied ? 'clean_exit_gate_satisfied' : (limitReason || 'clean_exit_gate_not_satisfied'),
    production_eligible: true,
    clean_gate_satisfied: cleanGateSatisfied,
    forced_conclusion: !cleanGateSatisfied,
    rounds_completed: rounds.length,
    clean_round_streak: cleanStreak,
    required_clean_round_streak: config.minimum_consecutive_clean_rounds_for_exit,
    maximum_automated_rounds_before_forced_conclusion: config.maximum_automated_rounds_before_forced_conclusion,
    requires_human_review: false,
    unresolved_important_ids: latest.unresolved_important_ids,
    unresolved_high_severity_ids: latest.unresolved_high_severity_ids,
    unanswered_challenge_ids: latest.unanswered_challenge_ids,
    result_consensus: latest.result_consensus,
    suppressed_duplicate_challenge_count: rounds.reduce((sum, round) => sum + Number(round.summary.suppressed_duplicate_challenge_count || 0), 0)
  }
}

function uniqueChallenges(challenges) {
  return [...new Map(challenges.map(challenge => [challenge.challenge_id, challenge])).values()]
}

function maximumSeverity(severities) {
  return severities.reduce((maximum, severity) => SEVERITY_ORDER[severity] > SEVERITY_ORDER[maximum] ? severity : maximum, 'low')
}

function winningLabel(probabilities) {
  return PROBABILITY_LABELS.reduce((best, label) => Number(probabilities[label]) > Number(probabilities[best]) ? label : best)
}

function challengeIssueKey(targetAgentId, challenge) {
  return sha256({
    target_agent_id: targetAgentId,
    target_result: challenge.target_result,
    category: challenge.category,
    evidence_refs: [...new Set(challenge.evidence_refs || [])].sort()
  }).slice(0, 24)
}

module.exports = {
  assessDebateRound,
  decisionSignature,
  buildDebateTermination,
  buildReviewAssignments,
  classifyChallenge,
  mergeCarryoverChallenges,
  normalizeCritique,
  updateOpenChallenges,
  validateDebateConfig
}
