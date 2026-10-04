const { PROBABILITY_LABELS, evidenceCoverage, normalizeProbabilities } = require('./contracts')
const { clamp, round } = require('./utils')

function aggregateOpinions(opinions, activeAgents, decisionConfig, evidenceGrades = new Map()) {
  const activeById = new Map(activeAgents.map(agent => [agent.agent_id, agent]))
  const accepted = opinions.filter(opinion => activeById.has(opinion.agent_id))
  if (accepted.length === 0) throw new Error('no active opinions to aggregate')

  const evidenceQualityByAgent = Object.fromEntries(accepted.map(opinion => [opinion.agent_id, opinionEvidenceQuality(opinion, evidenceGrades)]))
  const qualityAdjustedAgents = new Map([...activeById].map(([id, agent]) => [id, {
    ...agent,
    weight: (Number(agent.weight) || 1) * Math.max(0.1, evidenceQualityByAgent[id] || 0.1)
  }]))
  const weights = cappedWeights(accepted, qualityAdjustedAgents, decisionConfig.maximum_family_weight_share)
  const supportScores = Object.fromEntries(PROBABILITY_LABELS.map(label => [label, 0]))
  for (const opinion of accepted) {
    const weight = weights[opinion.agent_id]
    const result = PROBABILITY_LABELS.includes(opinion.result_candidate)
      ? opinion.result_candidate
      : winningLabel(normalizeProbabilities(opinion.probabilities))
    supportScores[result] += weight
  }
  const total = Object.values(supportScores).reduce((sum, value) => sum + value, 0)
  const probabilities = Object.fromEntries(PROBABILITY_LABELS.map(label => [label, round(supportScores[label] / total)]))
  const winningResult = PROBABILITY_LABELS.reduce((best, label) => probabilities[label] > probabilities[best] ? label : best)

  return {
    probabilities,
    probability_semantics: 'weighted_result_support_not_calibrated_probability',
    risk_label: winningResult,
    action: String(decisionConfig.contest_action_map[winningResult]),
    risk_control_advice: aggregateAdvice(accepted, weights, winningResult, decisionConfig),
    weights,
    evidence_coverage: round(clamp(weightedAverage(accepted, weights, opinion => opinionEvidenceQuality(opinion, evidenceGrades)), 0, 1)),
    evidence_quality_by_agent: evidenceQualityByAgent,
    chain_map: mergeChainMaps(accepted),
    factors: mergeFactors(accepted),
    dissent: accepted.map(opinion => ({
      agent_id: opinion.agent_id,
      result_candidate: opinion.result_candidate,
      thesis: opinion.thesis
    }))
  }
}

function applyDebateConclusionPolicy(consensus, opinions, termination, decisionConfig, debateConfig) {
  if (!termination?.forced_conclusion) {
    return {
      ...consensus,
      decision_mode: 'clean_consensus',
      conclusion_grade: debateConfig.forced_conclusion_policy.clean_conclusion_grade,
      base_probabilities: structuredClone(consensus.probabilities),
      forced_adjustment: null
    }
  }
  const policy = debateConfig.forced_conclusion_policy
  let probabilities = structuredClone(consensus.probabilities)
  const hasHighOrUnanswered = termination.unresolved_high_severity_ids.length > 0 || termination.unanswered_challenge_ids.length > 0

  if (hasHighOrUnanswered) {
    probabilities = { risk_up: 1, risk_flat: 0, risk_down: 0 }
  } else if (policy.forbid_risk_easing && winningLabel(probabilities) === 'risk_down') {
    probabilities = { risk_up: 0, risk_flat: 1, risk_down: 0 }
  }

  const riskLabel = winningLabel(probabilities)
  const mandatoryAdvice = riskLabel === 'risk_up' ? policy.high_risk_advice_code : policy.hold_advice_code
  const riskControlAdvice = [mandatoryAdvice, ...consensus.risk_control_advice.filter(code => code !== mandatoryAdvice)]
    .slice(0, decisionConfig.maximum_advice_items)
  return {
    ...consensus,
    probabilities,
    risk_label: riskLabel,
    action: String(decisionConfig.contest_action_map[riskLabel]),
    risk_control_advice: riskControlAdvice,
    decision_mode: 'forced_conservative',
    conclusion_grade: hasHighOrUnanswered ? policy.forced_high_conclusion_grade : policy.forced_other_conclusion_grade,
    base_probabilities: structuredClone(consensus.probabilities),
    forced_adjustment: {
      rule: hasHighOrUnanswered ? 'categorical_risk_up_on_high_or_unanswered' : 'categorical_no_easing_on_non_clean_exit',
      forced_result: hasHighOrUnanswered ? policy.high_or_unanswered_result : (riskLabel === 'risk_down' ? 'risk_flat' : riskLabel),
      unresolved_high_count: termination.unresolved_high_severity_ids.length,
      unresolved_important_count: termination.unresolved_important_ids.length,
      unanswered_count: termination.unanswered_challenge_ids.length
    }
  }
}

function applyInsufficientEvidencePolicy(consensus, decisionConfig) {
  const probabilities = { risk_up: 1, risk_flat: 0, risk_down: 0 }
  return {
    ...consensus,
    probabilities,
    risk_label: 'risk_up',
    action: String(decisionConfig.contest_action_map.risk_up),
    risk_control_advice: ['4', ...consensus.risk_control_advice.filter(code => code !== '4')].slice(0, decisionConfig.maximum_advice_items),
    decision_mode: 'evidence_insufficient_conservative',
    conclusion_grade: 'restricted',
    evidence_insufficient: true,
    evidence_policy_reason: 'graded_evidence_coverage_below_production_threshold'
  }
}

function cappedWeights(opinions, activeById, maximumFamilyShare) {
  const base = opinions.map(opinion => Math.max(0.0001, Number(activeById.get(opinion.agent_id).weight) || 1))
  const families = new Map()
  opinions.forEach((opinion, index) => {
    const family = opinion.method_family
    if (!families.has(family)) families.set(family, [])
    families.get(family).push(index)
  })
  let normalized = normalizeVector(base)
  const cap = clamp(Number(maximumFamilyShare) || 1, 1 / families.size, 1)
  for (let iteration = 0; iteration < 100; iteration += 1) {
    let changed = false
    for (const indexes of families.values()) {
      const share = indexes.reduce((sum, index) => sum + normalized[index], 0)
      if (share <= cap + 1e-9) continue
      const scale = cap / share
      indexes.forEach(index => { normalized[index] *= scale })
      const outside = normalized.map((_, index) => !indexes.includes(index) ? index : -1).filter(index => index >= 0)
      const outsideTotal = outside.reduce((sum, index) => sum + normalized[index], 0)
      const remainder = 1 - normalized.reduce((sum, value) => sum + value, 0)
      if (outsideTotal > 0) outside.forEach(index => { normalized[index] += remainder * normalized[index] / outsideTotal })
      changed = true
    }
    if (!changed) break
  }
  normalized = normalizeVector(normalized)
  return Object.fromEntries(opinions.map((opinion, index) => [opinion.agent_id, round(normalized[index], 12)]))
}

function opinionEvidenceQuality(opinion, evidenceGrades) {
  const references = [
    ...(opinion.factors || []).flatMap(factor => factor.evidence_refs || []),
    ...(opinion.chain_map?.edges || []).flatMap(edge => edge.evidence_refs || [])
  ]
  if (references.length === 0) return 0
  const unique = [...new Set(references)]
  if (!(evidenceGrades instanceof Map) || evidenceGrades.size === 0) return evidenceCoverage(opinion)
  const weights = unique.map(reference => ({ A: 1, B: 0.8, C: 0.4, D: 0.1 }[evidenceGrades.get(reference)] || 0))
  return round(weights.reduce((sum, value) => sum + value, 0) / weights.length)
}

function aggregateAdvice(opinions, weights, winningLabel, config) {
  const scores = new Map()
  for (const opinion of opinions) {
    for (const code of new Set((opinion.recommended_advice || []).map(String))) {
      scores.set(code, (scores.get(code) || 0) + weights[opinion.agent_id])
    }
  }
  const selected = [...scores.entries()]
    .filter(([, score]) => score >= config.advice_vote_threshold)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, config.maximum_advice_items)
    .map(([code]) => code)
  if (selected.length > 0) return selected
  if (winningLabel === 'risk_up') return ['4']
  if (winningLabel === 'risk_flat') return ['3']
  return ['1']
}

function mergeChainMaps(opinions) {
  const nodes = new Map()
  const edges = new Map()
  for (const opinion of opinions) {
    for (const node of opinion.chain_map?.nodes || []) {
      const id = typeof node === 'string' ? node : node.id
      if (id && !nodes.has(id)) nodes.set(id, typeof node === 'string' ? { id, label: id } : node)
    }
    for (const edge of opinion.chain_map?.edges || []) {
      const key = `${edge.from}|${edge.to}|${edge.relation}`
      const existing = edges.get(key) || { ...edge, evidence_refs: [], proposed_by: [] }
      existing.evidence_refs = [...new Set([...(existing.evidence_refs || []), ...(edge.evidence_refs || [])])]
      existing.proposed_by = [...new Set([...(existing.proposed_by || []), opinion.agent_id])]
      edges.set(key, existing)
    }
  }
  return { nodes: [...nodes.values()], edges: [...edges.values()] }
}

function mergeFactors(opinions) {
  const factors = new Map()
  for (const opinion of opinions) {
    for (const factor of opinion.factors || []) {
      const key = `${factor.name}|${factor.direction}|${[...(factor.evidence_refs || [])].sort().join(',')}`
      const existing = factors.get(key) || {
        ...factor,
        proposed_by: [],
        _strength_sum: 0,
        _confidence_sum: 0,
        _count: 0
      }
      existing.proposed_by.push(opinion.agent_id)
      existing._strength_sum += Number(factor.strength)
      existing._confidence_sum += Number(factor.confidence)
      existing._count += 1
      factors.set(key, existing)
    }
  }
  return [...factors.values()].map(factor => {
    const merged = {
      ...factor,
      strength: round(factor._strength_sum / factor._count),
      confidence: round(factor._confidence_sum / factor._count),
      proposed_by: [...new Set(factor.proposed_by)]
    }
    delete merged._strength_sum
    delete merged._confidence_sum
    delete merged._count
    return merged
  }).sort((left, right) => (right.strength * right.confidence) - (left.strength * left.confidence))
}

function normalizeVector(values) {
  const total = values.reduce((sum, value) => sum + value, 0)
  return values.map(value => value / total)
}

function weightedAverage(items, weights, accessor) {
  return items.reduce((sum, item) => sum + weights[item.agent_id] * accessor(item), 0)
}

function exactProbabilities(riskUp, riskFlat, riskDown) {
  const total = riskUp + riskFlat + riskDown
  const up = round(riskUp / total)
  const flat = round(riskFlat / total)
  const down = round(1 - up - flat)
  if ([up, flat, down].some(value => value < 0 || value > 1)) throw new Error('forced conclusion produced invalid probabilities')
  return { risk_up: up, risk_flat: flat, risk_down: down }
}

function winningLabel(probabilities) {
  return PROBABILITY_LABELS.reduce((best, label) => probabilities[label] > probabilities[best] ? label : best)
}

module.exports = { aggregateOpinions, applyDebateConclusionPolicy, applyInsufficientEvidencePolicy, cappedWeights, opinionEvidenceQuality }
