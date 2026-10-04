const { validateEvidenceRegistry } = require('./evidence-registry')
const { isCalendarDate, isHttpsUrl, round } = require('./utils')

const CONTRACT_VERSION = '1.0.0'
const PROBABILITY_LABELS = ['risk_up', 'risk_flat', 'risk_down']
const FACTOR_DIRECTIONS = ['risk_up', 'neutral', 'risk_down']
const ADVICE_CODES = new Set(['1', '2', '3', '4', '5', '6', '7', '8', '9'])
const REQUIRED_CRITIQUE_CHECKS = Object.freeze([
  'time_boundary',
  'citation_integrity',
  'source_independence',
  'causal_direction',
  'substitution_and_qualification',
  'factor_double_counting',
  'outcome_support'
])
const EMPTY_SHA256 = require('./utils').sha256(Buffer.alloc(0))

function validateCase(input, { sourceConfig, productionMode = false } = {}) {
  const errors = []
  if (!input || typeof input !== 'object' || Array.isArray(input)) return ['case must be an object']
  if (input.contract_version !== CONTRACT_VERSION) errors.push(`contract_version must be ${CONTRACT_VERSION}`)
  if (!String(input.case_id || '').trim()) errors.push('case_id is required')
  if (!isCalendarDate(input.as_of_date)) errors.push('as_of_date must be a real YYYY-MM-DD calendar date')
  if (!input.company || !String(input.company.id || '').trim() || !String(input.company.name || '').trim()) {
    errors.push('company.id and company.name are required')
  }
  if (productionMode && !/^\d{3}$/.test(String(input.company?.id || ''))) errors.push('production company.id must be exactly three digits')
  if (input.competition_cutoff !== undefined && !isCalendarDate(input.competition_cutoff)) errors.push('competition_cutoff must be a real calendar date')
  if (isCalendarDate(input.competition_cutoff) && isCalendarDate(input.as_of_date) && input.competition_cutoff > input.as_of_date) {
    errors.push('competition_cutoff cannot be after as_of_date')
  }
  if (productionMode && isCalendarDate(input.as_of_date) && input.as_of_date > new Date().toISOString().slice(0, 10)) {
    errors.push('as_of_date cannot be in the future')
  }
  if (!Array.isArray(input.evidence) || input.evidence.length < 2) errors.push('at least two evidence items are required')
  const evidenceIds = new Set()
  const sourceTypes = new Set()
  const sourceFingerprints = new Set()
  const effectiveCutoff = isCalendarDate(input.competition_cutoff) && input.competition_cutoff < input.as_of_date
    ? input.competition_cutoff
    : input.as_of_date
  for (const item of input.evidence || []) {
    if (!item || typeof item !== 'object') {
      errors.push('evidence items must be objects')
      continue
    }
    if (!String(item.id || '').trim()) errors.push('evidence.id is required')
    if (evidenceIds.has(item.id)) errors.push(`duplicate evidence id: ${item.id}`)
    evidenceIds.add(item.id)
    if (!item.source_type || !item.publisher || !item.source_url || !item.title || !item.summary) {
      errors.push(`evidence ${item.id || '?'} lacks source_type/publisher/source_url/title/summary`)
    }
    sourceTypes.add(item.source_type)
    if (!['A', 'B', 'C', 'D'].includes(item.evidence_grade)) errors.push(`evidence ${item.id || '?'} has invalid evidence_grade`)
    if (!/^[a-f0-9]{64}$/i.test(String(item.content_sha256 || '')) || (productionMode && (/^([a-f0-9])\1{63}$/i.test(String(item.content_sha256 || '')) || item.content_sha256 === EMPTY_SHA256))) {
      errors.push(`evidence ${item.id || '?'} lacks a trustworthy content_sha256`)
    }
    if (!isCalendarDate(item.published_at)) errors.push(`evidence ${item.id || '?'} published_at must be a real calendar date`)
    else if (isCalendarDate(effectiveCutoff) && item.published_at > effectiveCutoff) errors.push(`future evidence rejected: ${item.id}`)
    if (productionMode && !isHttpsUrl(item.source_url)) errors.push(`evidence ${item.id || '?'} source_url must use HTTPS`)
    if (item.public !== true) errors.push(`evidence must be explicitly public: ${item.id || '?'}`)
    const fingerprint = `${String(item.source_url || '').trim()}|${String(item.content_sha256 || '').toLowerCase()}`
    if (sourceFingerprints.has(fingerprint)) errors.push(`duplicate evidence source snapshot: ${item.id || '?'}`)
    sourceFingerprints.add(fingerprint)
  }
  if (sourceTypes.size < 2) errors.push('at least two public source types are required')
  if (sourceConfig) errors.push(...validateEvidenceRegistry(input.evidence, { asOfDate: effectiveCutoff, sourceConfig, productionMode }))
  return errors
}

function validateOpinion(opinion, evidenceIds) {
  const errors = []
  if (!opinion || typeof opinion !== 'object') return ['opinion must be an object']
  for (const key of ['agent_id', 'agent_version', 'method_family', 'result_candidate', 'probabilities', 'factors', 'chain_map', 'recommended_advice', 'thesis', 'uncertainties']) {
    if (opinion[key] === undefined || opinion[key] === null) errors.push(`missing ${key}`)
  }
  const probabilities = opinion.probabilities || {}
  if (!PROBABILITY_LABELS.includes(opinion.result_candidate)) errors.push('result_candidate must be risk_up, risk_flat, or risk_down')
  const values = PROBABILITY_LABELS.map(label => Number(probabilities[label]))
  if (values.some(value => !Number.isFinite(value) || value < 0 || value > 1)) errors.push('probabilities must be between 0 and 1')
  if (Math.abs(values.reduce((sum, value) => sum + value, 0) - 1) > 0.0001) errors.push('probabilities must sum to 1')
  if (!Array.isArray(opinion.factors) || opinion.factors.length === 0) errors.push('at least one factor is required')
  for (const factor of opinion.factors || []) {
    if (!factor.id || !factor.name || !FACTOR_DIRECTIONS.includes(factor.direction)) errors.push('factor id/name/direction invalid')
    if (!Number.isFinite(Number(factor.strength)) || factor.strength < 0 || factor.strength > 1) errors.push(`factor strength invalid: ${factor.id}`)
    if (!Number.isFinite(Number(factor.confidence)) || factor.confidence < 0 || factor.confidence > 1) errors.push(`factor confidence invalid: ${factor.id}`)
    if (!Array.isArray(factor.evidence_refs) || factor.evidence_refs.length === 0) errors.push(`factor lacks evidence: ${factor.id}`)
    for (const reference of factor.evidence_refs || []) if (!evidenceIds.has(reference)) errors.push(`unknown evidence ref ${reference}`)
    if (!String(factor.invalidation_condition || '').trim()) errors.push(`factor lacks invalidation condition: ${factor.id}`)
    if (!String(factor.transmission_mechanism || '').trim()) errors.push(`factor lacks transmission_mechanism: ${factor.id}`)
    if (!Number.isInteger(factor.horizon_days) || factor.horizon_days < 1 || factor.horizon_days > 1095) errors.push(`factor horizon_days invalid: ${factor.id}`)
    if (!String(factor.correlation_group || '').trim()) errors.push(`factor lacks correlation_group: ${factor.id}`)
  }
  if (!opinion.chain_map || !Array.isArray(opinion.chain_map.nodes) || !Array.isArray(opinion.chain_map.edges)) errors.push('chain_map invalid')
  for (const edge of opinion.chain_map?.edges || []) {
    if (!edge.from || !edge.to || !edge.relation) errors.push('chain edge lacks from/to/relation')
    if (!['confirmed', 'inferred'].includes(edge.status)) errors.push('chain edge status must be confirmed or inferred')
    if (!['upstream', 'target', 'downstream', 'cross_cutting'].includes(edge.chain_layer)) errors.push('chain edge chain_layer is invalid')
    if (!String(edge.transmission_mechanism || '').trim()) errors.push('chain edge lacks transmission_mechanism')
    if (!Number.isInteger(edge.horizon_days) || edge.horizon_days < 1 || edge.horizon_days > 1095) errors.push('chain edge horizon_days is invalid')
    if (!String(edge.invalidation_condition || '').trim()) errors.push('chain edge lacks invalidation_condition')
    if (!Array.isArray(edge.evidence_refs) || edge.evidence_refs.length === 0) errors.push('chain edge lacks evidence_refs')
    for (const reference of edge.evidence_refs || []) if (!evidenceIds.has(reference)) errors.push(`unknown chain evidence ref ${reference}`)
  }
  if (!Array.isArray(opinion.recommended_advice)) errors.push('recommended_advice must be an array')
  for (const code of opinion.recommended_advice || []) if (!ADVICE_CODES.has(String(code))) errors.push(`invalid advice code ${code}`)
  if (!String(opinion.thesis || '').trim()) errors.push('thesis is required')
  if (!Array.isArray(opinion.uncertainties)) errors.push('uncertainties must be an array')
  return errors
}

function normalizeProbabilities(probabilities) {
  const values = PROBABILITY_LABELS.map(label => Math.max(0.000001, Number(probabilities[label]) || 0.000001))
  const total = values.reduce((sum, value) => sum + value, 0)
  return Object.fromEntries(PROBABILITY_LABELS.map((label, index) => [label, round(values[index] / total)]))
}

function evidenceCoverage(opinion) {
  const factors = opinion.factors || []
  if (factors.length === 0) return 0
  const supported = factors.filter(factor => Array.isArray(factor.evidence_refs) && factor.evidence_refs.length > 0).length
  return supported / factors.length
}

function validateCritique(critique, agentIds, evidenceIds = new Set()) {
  const errors = []
  if (!critique || typeof critique !== 'object') return ['critique must be an object']
  if (!agentIds.has(critique.reviewer_id)) errors.push(`unknown reviewer ${critique.reviewer_id}`)
  if (!agentIds.has(critique.target_agent_id)) errors.push(`unknown target ${critique.target_agent_id}`)
  if (critique.reviewer_id === critique.target_agent_id) errors.push('self critique is not allowed')
  if (!Array.isArray(critique.challenges)) errors.push('critique challenges must be an array')
  if (!Array.isArray(critique.checks_performed)) errors.push('critique checks_performed must be an array')
  else for (const check of REQUIRED_CRITIQUE_CHECKS) if (!critique.checks_performed.includes(check)) errors.push(`critique did not perform required check: ${check}`)
  if (!String(critique.review_summary || '').trim()) errors.push('critique review_summary is required even when challenges is empty')
  const challengeIds = new Set()
  for (const challenge of critique.challenges || []) {
    if (!challenge.challenge_id || !challenge.category || !challenge.impact || !challenge.type || !challenge.target_result || !Array.isArray(challenge.evidence_refs) || !challenge.claim || !challenge.logic_gap || !challenge.requested_test) {
      errors.push('critique challenge lacks result-evidence-logic fields')
    }
    if (containsProbabilityDispute(challenge)) errors.push('probability percentage is outside the debate contract')
    if (!['low', 'medium', 'high'].includes(challenge.program_severity)) errors.push(`invalid program severity for ${challenge.challenge_id}`)
    if (challengeIds.has(challenge.challenge_id)) errors.push(`duplicate challenge id ${challenge.challenge_id}`)
    challengeIds.add(challenge.challenge_id)
  }
  if (!['low', 'medium', 'high'].includes(critique.severity)) errors.push('critique severity is invalid')
  if (!Array.isArray(critique.evidence_refs)) errors.push('critique evidence_refs must be an array')
  for (const reference of critique.evidence_refs || []) if (evidenceIds.size && !evidenceIds.has(reference)) errors.push(`unknown critique evidence ref ${reference}`)
  return errors
}

function validateRawCritique(critique, reviewerId, targetAgentId) {
  const errors = []
  if (!critique || typeof critique !== 'object' || Array.isArray(critique)) return ['critique must be an object']
  if (critique.reviewer_id !== reviewerId) errors.push('critique reviewer identity mismatch')
  if (critique.target_agent_id !== targetAgentId) errors.push('critique target identity mismatch')
  if (!Array.isArray(critique.challenges)) errors.push('critique challenges must be an array')
  if (!Array.isArray(critique.checks_performed)) errors.push('critique checks_performed must be an array')
  else for (const check of REQUIRED_CRITIQUE_CHECKS) if (!critique.checks_performed.includes(check)) errors.push(`critique did not perform required check: ${check}`)
  if (!String(critique.review_summary || '').trim()) errors.push('critique review_summary is required')
  for (const challenge of critique.challenges || []) {
    if (!challenge.category || !challenge.impact || !challenge.target_result || !Array.isArray(challenge.evidence_refs) || !challenge.claim || !challenge.logic_gap || !challenge.requested_test) errors.push('raw critique challenge lacks result-evidence-logic fields')
    if (containsProbabilityDispute(challenge)) errors.push('probability percentage is outside the debate contract')
  }
  return errors
}

function containsProbabilityDispute(challenge) {
  const text = [challenge.claim, challenge.logic_gap, challenge.requested_test].join(' ')
  return /(?:\u6982\u7387|\u80dc\u7387|\u7f6e\u4fe1\u5ea6|probabilit|percentage|calibrat)/i.test(text)
}

function validateRevision(opinion, critiques, evidenceIds, expectedRound, evidenceGrades = new Map()) {
  const errors = []
  const revision = opinion?.revision
  if (!revision || typeof revision !== 'object' || Array.isArray(revision)) return ['revision object is required']
  if (Number(revision.round) !== Number(expectedRound)) errors.push(`revision round must be ${expectedRound}`)
  if (typeof revision.changed !== 'boolean') errors.push('revision.changed must be boolean')
  if (!String(revision.rationale || '').trim()) errors.push('revision.rationale is required')
  if (!Array.isArray(revision.responses)) errors.push('revision.responses must be an array')
  const expectedChallenges = critiques.flatMap(critique => critique.challenges || [])
  const expectedIds = new Set(expectedChallenges.map(challenge => challenge.challenge_id))
  const expectedById = new Map(expectedChallenges.map(challenge => [challenge.challenge_id, challenge]))
  const seen = new Set()
  for (const response of revision.responses || []) {
    if (!expectedIds.has(response.challenge_id)) errors.push(`unknown revision challenge ${response.challenge_id}`)
    if (seen.has(response.challenge_id)) errors.push(`duplicate revision response ${response.challenge_id}`)
    seen.add(response.challenge_id)
    if (!['accepted', 'rejected_with_evidence', 'unresolved'].includes(response.resolution)) {
      errors.push(`invalid revision resolution for ${response.challenge_id}`)
    }
    if (!String(response.rationale || '').trim()) errors.push(`revision response lacks rationale: ${response.challenge_id}`)
    if (!Array.isArray(response.evidence_refs)) errors.push(`revision response evidence_refs must be an array: ${response.challenge_id}`)
    for (const reference of response.evidence_refs || []) {
      if (!evidenceIds.has(reference)) errors.push(`unknown revision evidence ref ${reference}`)
    }
    if (response.resolution === 'rejected_with_evidence' && (response.evidence_refs || []).length === 0) {
      errors.push(`rejected challenge requires evidence: ${response.challenge_id}`)
    }
    if (response.resolution === 'rejected_with_evidence' && !(response.evidence_refs || []).some(reference => ['A', 'B'].includes(evidenceGrades.get(reference)))) {
      errors.push(`rejected challenge requires A/B evidence: ${response.challenge_id}`)
    }
    const expected = expectedById.get(response.challenge_id)
    if (response.resolution === 'accepted' && ['high', 'medium'].includes(expected?.program_severity)) {
      if (revision.changed !== true) errors.push(`accepted important challenge requires a changed opinion: ${response.challenge_id}`)
      if (!String(response.remediation || '').trim()) errors.push(`accepted important challenge requires remediation: ${response.challenge_id}`)
    }
  }
  for (const challengeId of expectedIds) if (!seen.has(challengeId)) errors.push(`missing revision response ${challengeId}`)
  return errors
}

function validateCreditStrategy(strategy, agent, consensus, evidenceIds) {
  const errors = []
  if (!strategy || typeof strategy !== 'object' || Array.isArray(strategy)) return ['decision strategy must be an object']
  if (strategy.agent_id !== agent.agent_id) errors.push(`decision strategy agent identity mismatch: ${strategy.agent_id}`)
  if (Number(strategy.agent_version) !== Number(agent.version)) errors.push('decision strategy agent version mismatch')
  if (strategy.action !== consensus.action) errors.push('decision strategy cannot override program action')
  const expectedAdvice = [...consensus.risk_control_advice].map(String).sort()
  const actualAdvice = Array.isArray(strategy.risk_control_advice) ? [...strategy.risk_control_advice].map(String).sort() : []
  if (JSON.stringify(actualAdvice) !== JSON.stringify(expectedAdvice)) errors.push('decision strategy cannot override program advice')
  for (const code of actualAdvice) if (!ADVICE_CODES.has(code)) errors.push(`invalid decision strategy advice code ${code}`)
  if (!String(strategy.strategy_summary || '').trim()) errors.push('decision strategy_summary is required')
  if (!Array.isArray(strategy.rationale) || strategy.rationale.length === 0) errors.push('decision strategy rationale is required')
  if (!Array.isArray(strategy.monitoring_conditions)) errors.push('decision strategy monitoring_conditions must be an array')
  if (!Array.isArray(strategy.evidence_refs) || strategy.evidence_refs.length === 0) errors.push('decision strategy evidence_refs are required')
  for (const reference of strategy.evidence_refs || []) if (!evidenceIds.has(reference)) errors.push(`unknown decision strategy evidence ref ${reference}`)
  if (strategy.probabilities !== undefined || strategy.probability_override !== undefined) errors.push('decision strategy cannot output new probabilities')
  return errors
}

function validateMonitorAssessment(assessment, agent, evidenceIds) {
  const errors = []
  if (!assessment || typeof assessment !== 'object' || Array.isArray(assessment)) return ['monitor assessment must be an object']
  if (assessment.agent_id !== agent.agent_id) errors.push(`monitor agent identity mismatch: ${assessment.agent_id}`)
  if (assessment.probabilities !== undefined || assessment.action !== undefined || assessment.risk_control_advice !== undefined) {
    errors.push('monitor assessment cannot vote or recommend an action')
  }
  for (const key of ['relevant_evidence_ids', 'topic_signals', 'monitoring_gaps', 'query_refinements']) {
    if (!Array.isArray(assessment[key])) errors.push(`monitor assessment ${key} must be an array`)
  }
  if (typeof assessment.abstain !== 'boolean') errors.push('monitor assessment abstain must be boolean')
  for (const reference of assessment.relevant_evidence_ids || []) {
    if (!evidenceIds.has(reference)) errors.push(`unknown monitor evidence ref ${reference}`)
  }
  for (const signal of assessment.topic_signals || []) {
    if (!signal?.topic || !['risk_up', 'neutral', 'risk_down'].includes(signal.direction) || !signal.summary) {
      errors.push('monitor topic signal lacks topic/direction/summary')
    }
    if (!Array.isArray(signal?.evidence_refs) || signal.evidence_refs.length === 0) errors.push('monitor topic signal lacks evidence_refs')
    for (const reference of signal?.evidence_refs || []) {
      if (!evidenceIds.has(reference)) errors.push(`unknown monitor signal evidence ref ${reference}`)
    }
  }
  return errors
}

function validateIndustryPlan(plan, agent) {
  const errors = []
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) return ['industry plan must be an object']
  if (plan['执行员'] !== agent.agent_id) errors.push('industry plan executor identity mismatch')
  const nodeIds = new Set((plan['产业链']?.nodes || []).map(node => node.id))
  for (const edge of plan['产业链']?.edges || []) {
    if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) errors.push(`industry plan edge references unknown node: ${edge.from}->${edge.to}`)
  }
  const requirementIds = new Set()
  for (const requirement of plan['证据需求'] || []) {
    if (requirementIds.has(requirement.requirement_id)) errors.push(`duplicate evidence requirement: ${requirement.requirement_id}`)
    requirementIds.add(requirement.requirement_id)
  }
  return errors
}

function validateStageDecision(decision, { agent, phase, evidenceIds, frozenDirection = null, allowedAdviceCodes = null, mode = 'business' } = {}) {
  const errors = []
  const calibrated = ['competition_calibrated', 'competition_calibrated_v2'].includes(mode)
  const actionFirst = mode === 'competition_calibrated_v2'
  if (!decision || typeof decision !== 'object' || Array.isArray(decision)) return ['stage decision must be an object']
  if (calibrated) sanitizeCompetitionEvidenceRefs(decision, evidenceIds)
  if (decision['执行员'] !== agent.agent_id) errors.push('stage decision executor identity mismatch')
  const jointPhase = phase === 'competition_joint_decision'
  const directionPhase = phase === 'decision_direction' || jointPhase
  const advicePhase = phase === 'risk_control_advice' || jointPhase
  if (!directionPhase && !advicePhase) errors.push(`unsupported stage decision phase: ${phase}`)
  if (directionPhase && decision['经营调整方向'] === undefined) errors.push('stage decision lacks 经营调整方向')
  if (advicePhase && decision['风控建议'] === undefined) errors.push('stage decision lacks 风控建议')
  if (!directionPhase && decision['经营调整方向'] !== undefined) errors.push('stage decision must not contain 经营调整方向')
  if (!advicePhase && decision['风控建议'] !== undefined) errors.push('stage decision must not contain 风控建议')
  if (!calibrated && (!Array.isArray(decision['逻辑']) || decision['逻辑'].length === 0)) errors.push('stage decision logic is required')
  if (!calibrated && (!Array.isArray(decision['证据']) || decision['证据'].length === 0)) errors.push('stage decision evidence is required')
  const refs = new Set(decision['证据'] || [])
  const derivedRefs = new Set()
  for (const logic of decision['逻辑'] || []) {
    for (const reference of logic.evidence_refs || []) {
      derivedRefs.add(reference)
      if (!refs.has(reference)) errors.push(`logic evidence ${reference} is absent from stage evidence list`)
    }
  }
  for (const reference of refs) if (!derivedRefs.has(reference)) errors.push(`stage evidence ${reference} is not used by any logic item`)
  for (const reference of refs) if (!evidenceIds.has(reference)) errors.push(`unknown stage evidence ref ${reference}`)
  if (advicePhase) {
    const advice = decision['风控建议'] || []
    if (calibrated) {
      if (advice.length > 4) errors.push('competition advice must contain 0 to 4 codes')
    } else if (advice.length < 1 || advice.length > 3) errors.push('legacy/business advice must contain 1 to 3 codes')
    if (allowedAdviceCodes) for (const code of advice) if (!allowedAdviceCodes.has(String(code))) errors.push(`advice ${code} is outside the differing options`)
    if (!jointPhase && !PROBABILITY_LABELS.includes(frozenDirection)) errors.push('advice stage requires a frozen decision direction')
  }
  if (calibrated) {
    const coreAction = decision.action ?? decision.action_candidate
    const coreRisk = decision.risk_control_advice ?? decision['风控建议']
    if ((!actionFirst || directionPhase) && ![-1, 0, 1].includes(coreAction)) errors.push('competition core action must be -1, 0, or 1')
    if ((!actionFirst || advicePhase) && (!Array.isArray(coreRisk) || coreRisk.length > 4)) errors.push('competition core risk set must contain 0 to 4 codes')
    else if ((!actionFirst || advicePhase) && (new Set(coreRisk.map(String)).size !== coreRisk.length || coreRisk.some(code => !ADVICE_CODES.has(String(code))))) errors.push('competition core risk set is invalid')
    if (decision.execution_agent !== agent.agent_id) errors.push('competition execution_agent identity mismatch')
    if (directionPhase) {
      const expectedAction = { risk_up: -1, risk_flat: 0, risk_down: 1 }[decision['经营调整方向']]
      if (decision.action_candidate !== expectedAction) errors.push('action_candidate must match decision direction')
      if (!Number.isFinite(decision.action_confidence) || decision.action_confidence < 0 || decision.action_confidence > 1) errors.push('action_confidence must be an auxiliary 0..1 signal')
      for (const key of ['transmission_evidence', 'threshold_evidence', 'counter_evidence']) {
        for (const reference of decision[key] || []) if (!evidenceIds.has(reference)) errors.push(`unknown ${key} ref ${reference}`)
      }
    }
    if (advicePhase) {
      const advice = new Set((decision['风控建议'] || []).map(String))
      const assessments = Array.isArray(decision.label_assessments) ? decision.label_assessments : []
      const assessed = new Set(assessments.map(item => String(item.code)))
      if (assessed.size !== assessments.length) errors.push('label_assessments contains duplicate advice codes')
      if (assessments.length) for (const code of advice) if (!assessed.has(code)) errors.push(`selected advice ${code} lacks a necessity assessment`)
      for (const item of assessments) {
        if (item.necessary === true && !advice.has(String(item.code))) errors.push(`necessary advice ${item.code} is absent from the exact set`)
        for (const reference of item.counter_evidence || []) if (!evidenceIds.has(reference)) errors.push(`unknown label counter evidence ref ${reference}`)
      }
    }
  }
  return errors
}

function sanitizeCompetitionEvidenceRefs(decision, evidenceIds) {
  let removed = false
  for (const key of ['transmission_evidence', 'threshold_evidence', 'counter_evidence', '证据']) {
    if (!Array.isArray(decision[key])) continue
    const filtered = decision[key].map(String).filter(reference => evidenceIds.has(reference))
    if (filtered.length !== decision[key].length) removed = true
    decision[key] = [...new Set(filtered)]
  }
  for (const logic of decision['逻辑'] || []) {
    if (!Array.isArray(logic?.evidence_refs)) continue
    const filtered = logic.evidence_refs.map(String).filter(reference => evidenceIds.has(reference))
    if (filtered.length !== logic.evidence_refs.length) removed = true
    logic.evidence_refs = [...new Set(filtered)]
  }
  for (const item of decision.label_assessments || []) {
    if (!Array.isArray(item?.counter_evidence)) continue
    const filtered = item.counter_evidence.map(String).filter(reference => evidenceIds.has(reference))
    if (filtered.length !== item.counter_evidence.length) removed = true
    item.counter_evidence = [...new Set(filtered)]
  }
  if (removed) decision.warnings = [...new Set([...(Array.isArray(decision.warnings) ? decision.warnings : []), 'UNKNOWN_EVIDENCE_REF'])]
}

module.exports = {
  ADVICE_CODES,
  CONTRACT_VERSION,
  PROBABILITY_LABELS,
  REQUIRED_CRITIQUE_CHECKS,
  evidenceCoverage,
  normalizeProbabilities,
  validateCase,
  validateCreditStrategy,
  validateCritique,
  validateMonitorAssessment,
  validateIndustryPlan,
  validateOpinion,
  validateRawCritique,
  validateRevision,
  validateStageDecision
}
