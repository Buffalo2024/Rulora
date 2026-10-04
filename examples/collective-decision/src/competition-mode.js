const { canonicalJson, sha256 } = require('./utils')

const MODES = Object.freeze(['competition_legacy', 'competition_calibrated', 'competition_calibrated_v2', 'business'])
const ACTION_BY_DIRECTION = Object.freeze({ risk_up: '-1', risk_flat: '0', risk_down: '1' })
const DIRECTION_BY_ACTION = Object.freeze({ '-1': 'risk_up', '0': 'risk_flat', '1': 'risk_down' })
const FORBIDDEN_REVIEW_KEYS = Object.freeze([
  'request_reanalysis', 'request_rebroadcast', 'request_recollection', 'request_new_agent',
  'reanalyze', 'rebroadcast', 'recollect', 'next_review', 'review_again'
])

function normalizeMode(value) {
  const mode = String(value || 'business')
  if (!MODES.includes(mode)) throw codedError('INVALID_DECISION_MODE', `unsupported decision mode: ${mode}`)
  return mode
}

function isCalibratedCompetition(mode) {
  return ['competition_calibrated', 'competition_calibrated_v2'].includes(normalizeMode(mode))
}

function validateCompetitionModeConfig(config, mode = 'competition_calibrated') {
  if (!config || config.contract_version !== '1.0.0') throw new Error('competition mode config must use contract_version 1.0.0')
  const policy = config[mode] || config.competition_calibrated || {}
  const stageMultiplier = mode === 'competition_calibrated_v2' ? 2 : 1
  const exact = {
    max_debate_rounds: 1,
    max_revision_per_seat: 1,
    max_review_rounds: 1,
    max_calibration_rounds: 1,
    max_evidence_refresh_after_freeze: 0,
    max_planner_calls_per_case: 1,
    max_initial_seat_calls_per_case: 3 * stageMultiplier,
    max_revision_calls_per_case: 3 * stageMultiplier,
    max_calibration_reviewer_calls_per_case: 1,
    max_improvement_calls_per_case: 0
  }
  for (const [key, value] of Object.entries(exact)) if (policy[key] !== value) throw new Error(`competition mode hard limit ${key} must equal ${value}`)
  if (policy.maximum_advice_items !== 4 || policy.allow_empty_advice !== true || policy.fail_closed_on_budget !== true || policy.automatic_champion_replacement !== false || policy.automatic_evolution !== false) {
    throw new Error('competition mode safety policy is invalid')
  }
  if (mode === 'competition_calibrated_v2' && (policy.required_seat_quorum !== 3 || policy.allow_degraded_quorum !== false)) {
    throw new Error('competition calibrated v2 requires all three seats and forbids degraded quorum')
  }
  return policy
}

class CompetitionCallBudget {
  constructor({ reusedEvidence = false, limits = {} } = {}) {
    this.limits = Object.freeze({
      planner: 1,
      initial_seat: 3,
      revision: 3,
      calibration_reviewer: 1,
      improvement: 0,
      evidence_collection: reusedEvidence ? 0 : 1,
      ...limits
    })
    this.counts = Object.fromEntries(Object.keys(this.limits).map(key => [key, ['initial_seat', 'revision'].includes(key) ? {} : 0]))
    this.finalized = false
  }

  consume(kind, count = 1, scope = 'case') {
    if (this.finalized) throw codedError('DECISION_FINALIZED', `cannot call ${kind} after Program Finalization`)
    if (!Object.hasOwn(this.limits, kind)) throw codedError('UNKNOWN_COMPETITION_CALL', `unknown competition call budget: ${kind}`)
    const scoped = ['initial_seat', 'revision'].includes(kind)
    const current = scoped ? Number(this.counts[kind][scope] || 0) : this.counts[kind]
    const next = current + count
    const total = scoped ? Object.values(this.counts[kind]).reduce((sum, value) => sum + Number(value), 0) + count : next
    if (!Number.isInteger(count) || count < 0 || total > this.limits[kind] || scoped && next > 1) {
      throw codedError('COMPETITION_BUDGET_EXCEEDED', `${kind} call budget exceeded: total ${total}/${this.limits[kind]}, scope ${scope} ${next}/1`)
    }
    if (scoped) this.counts[kind][scope] = next
    else this.counts[kind] = next
    return next
  }

  finalize() {
    if (this.counts.calibration_reviewer > 1) throw codedError('COMPETITION_BUDGET_EXCEEDED', 'calibration reviewer ran more than once')
    this.finalized = true
    return this.snapshot()
  }

  snapshot() {
    return { limits: { ...this.limits }, counts: structuredClone(this.counts), scoped_limits: { initial_seat: 'one_call_per_seat_and_three_total', revision: 'one_call_per_seat_and_three_total' }, decision_finalized: this.finalized }
  }
}

function buildCandidateSupport({ phase, initialDecisions, finalDecisions }) {
  if (!['decision_direction', 'risk_control_advice'].includes(phase)) throw new Error(`unsupported support phase: ${phase}`)
  assertThreeSeats(initialDecisions, finalDecisions)
  const initialBySeat = new Map(initialDecisions.map(item => [item['执行员'], item]))
  const finalBySeat = new Map(finalDecisions.map(item => [item['执行员'], item]))
  const candidateKeys = new Set([
    ...initialDecisions.map(item => candidateKey(phase, item)),
    ...finalDecisions.map(item => candidateKey(phase, item))
  ])
  const changedSeatIds = [...initialBySeat.keys()].filter(seatId => candidateKey(phase, initialBySeat.get(seatId)) !== candidateKey(phase, finalBySeat.get(seatId)))
  const candidates = [...candidateKeys].map(key => {
    const initialSupporters = initialDecisions.filter(item => candidateKey(phase, item) === key).map(item => item['执行员'])
    const postSupporters = finalDecisions.filter(item => candidateKey(phase, item) === key).map(item => item['执行员'])
    const broadcastAdded = postSupporters.filter(seatId => !initialSupporters.includes(seatId))
    return {
      candidate_id: `${phase}:${sha256(key).slice(0, 12)}`,
      value: JSON.parse(key),
      independent_support_count: initialSupporters.length,
      post_broadcast_support_count: postSupporters.length,
      broadcast_added_support_count: broadcastAdded.length,
      originating_seat_ids: initialSupporters,
      post_broadcast_seat_ids: postSupporters,
      changed_seat_ids: changedSeatIds.filter(seatId => postSupporters.includes(seatId)),
      broadcast_added_seat_ids: broadcastAdded
    }
  })
  candidates.sort((left, right) =>
    right.post_broadcast_support_count - left.post_broadcast_support_count ||
    right.independent_support_count - left.independent_support_count)
  return {
    contract_version: '1.0.0',
    phase,
    initial_candidates: Object.fromEntries(initialDecisions.map(item => [item['执行员'], JSON.parse(candidateKey(phase, item))])),
    post_broadcast_candidates: Object.fromEntries(finalDecisions.map(item => [item['执行员'], JSON.parse(candidateKey(phase, item))])),
    changed_seat_ids: changedSeatIds,
    candidates
  }
}

function buildExactSetCandidatePool({ initialDecisions, finalDecisions }) {
  const support = buildCandidateSupport({ phase: 'risk_control_advice', initialDecisions, finalDecisions })
  const frozenCandidates = support.candidates.filter(item => item.post_broadcast_support_count > 0)
  const first = frozenCandidates[0] || null
  const second = frozenCandidates[1] || null
  const uniqueSupportLeader = first && (!second ||
    first.post_broadcast_support_count > second.post_broadcast_support_count ||
    first.post_broadcast_support_count === second.post_broadcast_support_count && first.independent_support_count > second.independent_support_count)
  return {
    ...support,
    candidates: frozenCandidates,
    selection_rule: 'whole_set_support_then_independent_support_no_size_prior',
    prohibited_rule: 'per_label_union',
    preferred_candidate_set_id: uniqueSupportLeader ? first.candidate_id : null
  }
}

function calibrateActionCandidate({ initialDecisions, finalDecisions }) {
  const support = buildCandidateSupport({ phase: 'decision_direction', initialDecisions, finalDecisions })
  const thresholdByDirection = Object.fromEntries(['risk_up', 'risk_flat', 'risk_down'].map(direction => {
    const directionSupport = support.candidates.find(item => item.value === direction) || { independent_support_count: 0, post_broadcast_support_count: 0 }
    const supporters = finalDecisions.filter(item => item['经营调整方向'] === direction)
    const transmission = unique(supporters.flatMap(item => item.transmission_evidence || []))
    const threshold = unique(supporters.flatMap(item => item.threshold_evidence || []))
    const supportPassed = directionSupport.independent_support_count >= 1 && directionSupport.post_broadcast_support_count >= 2
    const passed = direction === 'risk_flat'
      ? supportPassed
      : supportPassed && transmission.length > 0 && threshold.length > 0
    return [direction, { passed, transmission_evidence: transmission, threshold_evidence: threshold, independent_support_count: directionSupport.independent_support_count, post_broadcast_support_count: directionSupport.post_broadcast_support_count }]
  }))
  const finalMajority = support.candidates.find(item => item.post_broadcast_support_count >= 2)
  const independentMajority = support.candidates.find(item => item.independent_support_count >= 2)
  const proposedDirection = finalMajority?.value || independentMajority?.value || null
  const candidate = proposedDirection ? support.candidates.find(item => item.value === proposedDirection) : null
  const supportingFinal = proposedDirection ? finalDecisions.filter(item => item['经营调整方向'] === proposedDirection) : []
  const transmissionEvidence = unique(supportingFinal.flatMap(item => item.transmission_evidence || []))
  const thresholdEvidence = unique(supportingFinal.flatMap(item => item.threshold_evidence || []))
  const thresholdPassed = proposedDirection ? thresholdByDirection[proposedDirection].passed : false
  const calibratedDirection = thresholdPassed ? proposedDirection : null
  const rawSupportSignal = (candidate?.independent_support_count || 0) / 3 * 0.65 + (candidate?.post_broadcast_support_count || 0) / 3 * 0.35
  return {
    contract_version: '1.0.0',
    prior: { action: null, type: 'no_program_default', hard_default: false },
    proposed_direction: proposedDirection,
    proposed_action: proposedDirection ? ACTION_BY_DIRECTION[proposedDirection] : null,
    calibrated_direction: calibratedDirection,
    calibrated_action: calibratedDirection ? ACTION_BY_DIRECTION[calibratedDirection] : null,
    threshold_passed: thresholdPassed,
    transmission_evidence: transmissionEvidence,
    decision_adjustment_threshold_evidence: thresholdEvidence,
    threshold_by_direction: thresholdByDirection,
    support,
    confidence_signal: roundSignal(thresholdPassed ? rawSupportSignal : Math.min(0.45, rawSupportSignal * 0.5)),
    confidence_reduced_by_threshold_failure: !thresholdPassed,
    confidence_is_calibrated_probability: false
  }
}

function validateCalibrationReview(review, { candidatePool, actionCalibration, champion = null, reviewCandidatePool = null } = {}) {
  const errors = []
  if (!review || typeof review !== 'object' || Array.isArray(review)) return ['calibration review must be an object']
  for (const key of FORBIDDEN_REVIEW_KEYS) if (review[key] !== undefined) errors.push(`reviewer forbidden request: ${key}`)
  const action = review.action ?? review.recommended_action
  const risk = review.risk_control_advice ?? review.recommended_risk_set
  if (![-1, 0, 1].includes(Number(action))) errors.push('reviewer core action must be -1, 0, or 1')
  if (!Array.isArray(risk) || risk.length > 4 || risk.some(code => !/^[1-9]$/.test(String(code)))) errors.push('reviewer core risk set must contain 0 to 4 valid advice codes')
  if (Array.isArray(risk) && new Set(risk.map(String)).size !== risk.length) errors.push('reviewer core risk set must be unique')
  if (!['HIGH', 'MEDIUM', 'LOW', 'REVIEW'].includes(String(review.challenge_level ?? review.challenge_strength ?? '').toUpperCase())) errors.push('reviewer core challenge_level must be HIGH, MEDIUM, LOW, or REVIEW')
  errors.push(...validateReviewerRiskSelection(review, candidatePool))
  const candidateActions = new Set((actionCalibration?.support?.candidates || []).map(item => ACTION_BY_DIRECTION[item.value]))
  if (!candidateActions.has(String(action))) errors.push('reviewer action is outside frozen seat candidates')
  if (reviewCandidatePool) {
    const actionCandidate = reviewCandidatePool.action_candidates?.find(item => item.id === review.selected_action_candidate_id)
    const riskCandidate = reviewCandidatePool.risk_candidates?.find(item => item.id === review.selected_risk_candidate_id)
    if (!actionCandidate || String(actionCandidate.value) !== String(action)) errors.push('reviewer selected Action ID does not resolve to the expanded Action')
    if (!riskCandidate || JSON.stringify(normalizeAdviceSet(riskCandidate.value)) !== JSON.stringify(normalizeAdviceSet(risk))) errors.push('reviewer selected Risk ID does not resolve to the expanded Risk set')
    if (review.review_candidate_pool_hash !== reviewCandidatePool.review_candidate_pool_hash) errors.push('review candidate pool hash changed')
  }
  return errors
}

function buildReviewerCandidatePool({ actionCalibration, candidatePool, champion = null } = {}) {
  const actionCandidates = (actionCalibration?.support?.candidates || []).filter(item => actionCalibration?.threshold_by_direction?.[item.value]?.passed === true).map(item => ({
    id: String(item.candidate_id),
    value: Number(ACTION_BY_DIRECTION[item.value]),
    independent_support: Number(item.independent_support_count || 0),
    post_broadcast_support: Number(item.post_broadcast_support_count || 0),
    broadcast_added_support: Number(item.broadcast_added_support_count || 0),
    source_seats: [...(item.originating_seat_ids || [])].map(String).sort(),
    threshold_passed: true
  }))
  const rawCalibratedAction = actionCalibration?.calibrated_action
  const calibratedAction = rawCalibratedAction === null || rawCalibratedAction === undefined || rawCalibratedAction === ''
    ? null
    : Number(rawCalibratedAction)
  if ([-1, 0, 1].includes(calibratedAction) && !actionCandidates.some(item => item.value === calibratedAction)) {
    actionCandidates.push({
      id: `action_program_calibrated_${calibratedAction}`,
      value: calibratedAction,
      independent_support: 0,
      post_broadcast_support: 0,
      broadcast_added_support: 0,
      source_seats: [],
      program_derived: true
    })
  }
  const riskCandidates = (candidatePool?.candidates || []).map(item => ({
    id: String(item.candidate_id),
    value: normalizeAdviceSet(item.value),
    independent_support: Number(item.independent_support_count || 0),
    post_broadcast_support: Number(item.post_broadcast_support_count || 0),
    broadcast_added_support: Number(item.broadcast_added_support_count || 0),
    source_seats: [...(item.originating_seat_ids || [])].map(String).sort()
  }))
  const pool = {
    contract_version: '1.0.0',
    action_candidates: actionCandidates,
    risk_candidates: riskCandidates,
    champion_decision: champion ? {
      action: Number(champion.action),
      risk_control_advice: normalizeAdviceSet(champion.risk_control_advice)
    } : null,
    support_statistics: {
      action_threshold_passed: actionCalibration?.threshold_passed === true,
      calibrated_action: calibratedAction,
      action_candidate_count: actionCandidates.length,
      risk_candidate_count: riskCandidates.length,
      broadcast_support_is_not_independent_support: true
    }
  }
  return { ...pool, review_candidate_pool_hash: sha256(canonicalJson(pool)) }
}

function expandReviewerSelection(selection, reviewCandidatePool) {
  if (!selection || typeof selection !== 'object' || Array.isArray(selection)) throw codedError('CALIBRATION_REVIEW_REJECTED', 'reviewer selection must be an object')
  const forbidden = ['action', 'action_candidate', 'recommended_action', 'risk_control_advice', 'risk_set_candidate', 'recommended_risk_set', '经营调整方向', '风控建议']
  if (forbidden.some(key => selection[key] !== undefined)) throw codedError('CALIBRATION_REVIEW_REJECTED', 'reviewer must select candidate IDs and cannot output Action or Risk values')
  const actionId = String(selection.selected_action_candidate_id || '')
  const riskId = String(selection.selected_risk_candidate_id || '')
  const actionCandidate = reviewCandidatePool?.action_candidates?.find(item => item.id === actionId)
  const riskCandidate = reviewCandidatePool?.risk_candidates?.find(item => item.id === riskId)
  if (!actionCandidate) throw codedError('CALIBRATION_REVIEW_REJECTED', 'selected_action_candidate_id is outside the frozen candidate pool')
  if (!riskCandidate) throw codedError('CALIBRATION_REVIEW_REJECTED', 'selected_risk_candidate_id is outside the frozen candidate pool')
  if (typeof selection.challenge_intent !== 'boolean') throw codedError('CALIBRATION_REVIEW_REJECTED', 'challenge_intent must be boolean')
  const strength = String(selection.evidence_strength || '').toLowerCase()
  if (!['strong', 'moderate', 'weak'].includes(strength)) throw codedError('CALIBRATION_REVIEW_REJECTED', 'evidence_strength must be strong, moderate, or weak')
  const challengeStrength = selection.challenge_intent === false
    ? 'LOW'
    : { strong: 'HIGH', moderate: 'MEDIUM', weak: 'REVIEW' }[strength]
  const reason = Array.isArray(selection.selection_reason)
    ? selection.selection_reason.map(String).filter(Boolean).slice(0, 6)
    : []
  return {
    action: Number(actionCandidate.value),
    risk_control_advice: normalizeAdviceSet(riskCandidate.value),
    reviewer_id: 'competition_calibration_reviewer',
    recommended_action: String(actionCandidate.value),
    recommended_risk_set: normalizeAdviceSet(riskCandidate.value),
    selected_action_candidate_id: actionId,
    selected_risk_candidate_id: riskId,
    challenge_intent: selection.challenge_intent,
    evidence_strength: strength,
    challenge_champion: selection.challenge_intent,
    challenge_level: challengeStrength,
    challenge_strength: challengeStrength,
    selection_reason: reason,
    reason,
    review_candidate_pool_hash: String(reviewCandidatePool.review_candidate_pool_hash),
    warnings: reason.length ? [] : ['AUDIT_FIELD_MISSING']
  }
}

function finalizeCalibratedDecision({ actionCalibration, candidatePool, review, champion = null, budget, warnings = [], decisionMode = 'competition_calibrated' }) {
  const reviewCandidatePool = buildReviewerCandidatePool({ actionCalibration, candidatePool, champion })
  const errors = validateCalibrationReview(review, {
    candidatePool,
    actionCalibration,
    champion,
    reviewCandidatePool: decisionMode === 'competition_calibrated_v2' ? reviewCandidatePool : null
  })
  if (errors.length) throw codedError('CALIBRATION_REVIEW_REJECTED', errors.join('; '))
  const reviewDirection = DIRECTION_BY_ACTION[String(review.recommended_action)]
  if (actionCalibration.threshold_by_direction?.[reviewDirection]?.passed !== true) {
    throw codedError('ACTION_THRESHOLD_NOT_MET', `reviewer selected Action ${review.recommended_action} without symmetric Program support threshold`)
  }
  const action = String(review.recommended_action)
  const risk = normalizeAdviceSet(review.recommended_risk_set)
  const challenger = { action, risk_control_advice: risk }
  const jointConsistency = evaluateActionRiskConsistency(action, risk)
  const championGate = buildChampionGate({ champion, challenger, review, actionCalibration, candidatePool })
  const budgetSnapshot = budget ? budget.finalize() : null
  const finalWarnings = [...new Set((warnings || []).map(String))].sort()
  return {
    contract_version: '1.0.0',
    decision_mode: decisionMode,
    action,
    risk_label: DIRECTION_BY_ACTION[action],
    risk_control_advice: risk,
    joint_consistency: jointConsistency,
    action_calibration: actionCalibration,
    exact_set_candidate_pool: candidatePool,
    reviewer_candidate_pool: reviewCandidatePool,
    calibration_reviewer: structuredClone(review),
    champion_gate: championGate,
    decision_finalized: true,
    warnings: finalWarnings,
    finalization_status: finalWarnings.length ? 'FINALIZED_WITH_WARNING' : 'FINALIZED',
    automatic_champion_replacement: false,
    budget: budgetSnapshot
  }
}

function evaluateActionRiskConsistency(action, risk) {
  const strictTightening = new Set(['2', '4', '8', '9'])
  const conflicts = String(action) === '1' ? risk.filter(code => strictTightening.has(String(code))) : []
  return {
    compatible: conflicts.length === 0,
    conflict_codes: conflicts,
    rule: conflicts.length ? 'risk_easing_action_conflicts_with_strict_tightening_advice' : 'no_deterministic_action_risk_conflict'
  }
}

function buildChampionGate({ champion, challenger, review, actionCalibration, candidatePool }) {
  const normalizedChampion = champion ? {
    action: String(champion.action),
    risk_control_advice: normalizeAdviceSet(champion.risk_control_advice)
  } : null
  const changed = normalizedChampion ? normalizedChampion.action !== challenger.action || JSON.stringify(normalizedChampion.risk_control_advice) !== JSON.stringify(challenger.risk_control_advice) : true
  let status = 'REVIEW'
  if (normalizedChampion && !changed) status = 'KEEP'
  else if (normalizedChampion && review.challenge_champion && review.challenge_strength === 'HIGH') status = 'CHALLENGE_HIGH'
  else if (normalizedChampion && review.challenge_champion && review.challenge_strength === 'MEDIUM') status = 'CHALLENGE_MEDIUM'
  return {
    contract_version: '1.0.0',
    champion: normalizedChampion,
    challenger: structuredClone(challenger),
    independent_support: actionCalibration.support.candidates,
    exact_set_support: candidatePool.candidates,
    reviewer_strength: review.challenge_strength,
    recommended_status: status,
    replacement_recommended: status === 'CHALLENGE_HIGH' || status === 'CHALLENGE_MEDIUM',
    replacement_reason: [...review.reason],
    requires_explicit_changeset_confirmation: true,
    automatic_replacement: false
  }
}

function validateReviewerRiskSelection(review, candidatePool) {
  const errors = []
  const selection = review.risk_selection
  const selected = normalizeAdviceSet(review.risk_control_advice ?? review.recommended_risk_set ?? [])
  if (!selection || typeof selection !== 'object') {
    const permitted = (candidatePool?.candidates || []).some(item => selected.every(code => normalizeAdviceSet(item.value).includes(code)))
    return permitted ? [] : ['reviewer core risk set is outside every frozen candidate set']
  }
  const source = candidatePool?.candidates?.find(item => item.candidate_id === selection.source_candidate_set_id)
  if (!source) return ['risk_selection source_candidate_set_id is not in the frozen candidate pool']
  const sourceSet = normalizeAdviceSet(source.value)
  const removed = normalizeAdviceSet(selection.removed_codes || [])
  if (selected.some(code => !sourceSet.includes(code))) errors.push('reviewer cannot add a label absent from the source candidate set')
  const expectedRemoved = sourceSet.filter(code => !selected.includes(code))
  if (JSON.stringify(removed) !== JSON.stringify(expectedRemoved)) errors.push('removed_codes must exactly describe the deletion from the source candidate')
  return errors
}

function buildComparisonRows({ championRows, challengerRuns }) {
  const championById = new Map(championRows.map(row => [String(row.company_id).padStart(3, '0'), row]))
  return challengerRuns.map(run => {
    const companyId = String(run.report?.submission_row?.company_id || run.company_id).padStart(3, '0')
    const champion = championById.get(companyId) || null
    const finalization = run.competition_finalization || run.consensus?.competition_finalization || {}
    const challenger = run.report?.submission_row || { action: finalization.action, risk_control_advice: (finalization.risk_control_advice || []).join(',') }
    const actionSupport = finalization.action_calibration?.support
    const riskSupport = finalization.exact_set_candidate_pool
    return {
      company_id: companyId,
      V1_action: champion ? String(champion.action) : null,
      V1_risk: champion ? normalizeAdviceSet(champion.risk_control_advice) : null,
      new_action: String(challenger.action),
      new_risk: normalizeAdviceSet(challenger.risk_control_advice),
      action_changed: champion ? String(champion.action) !== String(challenger.action) : null,
      risk_changed: champion ? JSON.stringify(normalizeAdviceSet(champion.risk_control_advice)) !== JSON.stringify(normalizeAdviceSet(challenger.risk_control_advice)) : null,
      initial_seat_outputs: { action: actionSupport?.initial_candidates || {}, risk: riskSupport?.initial_candidates || {} },
      post_broadcast_outputs: { action: actionSupport?.post_broadcast_candidates || {}, risk: riskSupport?.post_broadcast_candidates || {} },
      independent_support_count: supportCountFor(actionSupport, DIRECTION_BY_ACTION[String(challenger.action)]),
      post_broadcast_support_count: supportCountFor(actionSupport, DIRECTION_BY_ACTION[String(challenger.action)], 'post_broadcast_support_count'),
      broadcast_added_support_count: supportCountFor(actionSupport, DIRECTION_BY_ACTION[String(challenger.action)], 'broadcast_added_support_count'),
      calibration_reviewer_action: finalization.calibration_reviewer?.recommended_action ?? null,
      calibration_reviewer_risk: finalization.calibration_reviewer?.recommended_risk_set ?? null,
      challenge_strength: finalization.calibration_reviewer?.challenge_strength ?? null,
      evidence_changed: run.evidence_changed === true,
      recommended_status: finalization.champion_gate?.recommended_status || 'REVIEW'
    }
  }).sort((left, right) => left.company_id.localeCompare(right.company_id))
}

function supportCountFor(support, value, field = 'independent_support_count') {
  return support?.candidates?.find(item => item.value === value)?.[field] || 0
}

function candidateKey(phase, decision) {
  if (phase === 'decision_direction') return JSON.stringify(decision['经营调整方向'])
  return JSON.stringify(normalizeAdviceSet(decision['风控建议'] || []))
}

function normalizeAdviceSet(value) {
  const items = Array.isArray(value) ? value : String(value || '').split(',').filter(Boolean)
  return [...new Set(items.map(String))].sort((left, right) => Number(left) - Number(right))
}

function assertThreeSeats(initialDecisions, finalDecisions) {
  if (!Array.isArray(initialDecisions) || !Array.isArray(finalDecisions) || initialDecisions.length !== 3 || finalDecisions.length !== 3) throw new Error('competition support requires exactly three initial and three final seat decisions')
  const initial = initialDecisions.map(item => item['执行员']).sort()
  const final = finalDecisions.map(item => item['执行员']).sort()
  if (new Set(initial).size !== 3 || new Set(final).size !== 3 || initial.some((id, index) => id !== final[index])) throw new Error('competition support seat identities are duplicated or changed between independent and post-broadcast stages')
}

function unique(values) { return [...new Set(values.map(String))].sort() }
function roundSignal(value) { return Math.round(value * 10000) / 10000 }
function codedError(code, message) { const error = new Error(message); error.code = code; return error }

module.exports = {
  ACTION_BY_DIRECTION,
  CompetitionCallBudget,
  DIRECTION_BY_ACTION,
  MODES,
  buildCandidateSupport,
  buildChampionGate,
  buildComparisonRows,
  buildExactSetCandidatePool,
  buildReviewerCandidatePool,
  calibrateActionCandidate,
  finalizeCalibratedDecision,
  expandReviewerSelection,
  evaluateActionRiskConsistency,
  isCalibratedCompetition,
  normalizeAdviceSet,
  normalizeMode,
  validateCalibrationReview,
  validateCompetitionModeConfig
}
