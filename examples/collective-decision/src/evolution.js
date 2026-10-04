const { PROBABILITY_LABELS } = require('./contracts')
const { clamp, isCalendarDate, isHttpsUrl, round, sha256 } = require('./utils')
const { emptyMetrics } = require('./population-store')

function scorePrediction(directionOrProbabilities, advice, truth) {
  const predicted = typeof directionOrProbabilities === 'string'
    ? directionOrProbabilities
    : PROBABILITY_LABELS.reduce((best, label) => Number(directionOrProbabilities?.[label]) > Number(directionOrProbabilities?.[best]) ? label : best)
  const adviceF1 = setF1(new Set((advice || []).map(String)), new Set((truth.risk_control_advice || []).map(String)))
  return {
    brier: predicted === truth.risk_label ? 0 : 1,
    brier_skill: predicted === truth.risk_label ? 1 : 0,
    direction_correct: predicted === truth.risk_label ? 1 : 0,
    advice_f1: round(adviceF1),
    log_loss: predicted === truth.risk_label ? 0 : 1
  }
}

function recordLabeledRun(state, run, truth, config) {
  if (String(run?.decision_mode || '').startsWith('competition_')) throw Object.assign(new Error('automatic Agent evolution is disabled in Competition Mode; use Submission Supervisor records instead'), { code: 'COMPETITION_EVOLUTION_DISABLED' })
  validateTruthAndRun(run, truth)
  validateEvolutionConfig(config)
  state.challengers ||= []
  state.retired ||= []
  state.evolution_log ||= []
  state.case_evaluations ||= {}
  state.evaluated_case_ids ||= []
  state.evaluated_run_ids ||= []
  state.generation_history ||= []
  if (state.evaluated_run_ids.includes(run.run_id)) return { state, duplicate: true, evaluation: null, evolution: null }
  if (state.evaluated_case_ids.includes(run.case_id)) return { state, duplicate: true, evaluation: null, evolution: null }

  const opinionsById = new Map([
    ...(run.revised_opinions || run.opinions || []),
    ...(run.shadow_opinions || [])
  ].map(opinion => [opinion.agent_id, opinion]))
  const eligibleChampions = state.active.filter(isEvolutionParticipant)
  const eligibleChallengers = state.challengers.filter(isEvolutionParticipant)
  const evaluation = { case_id: run.case_id, run_id: run.run_id, truth, agents: {}, consensus: null }
  for (const agent of [...eligibleChampions, ...eligibleChallengers]) {
    const opinion = opinionsById.get(agent.agent_id)
    if (!opinion) continue
    const score = scorePrediction(opinion.result_candidate || opinion.probabilities, opinion.recommended_advice, truth)
    evaluation.agents[agent.agent_id] = score
    updateMetrics(agent.metrics, score, config)
  }
  for (const failed of run.shadow_runs || []) {
    if (failed.status !== 'failed') continue
    const challenger = eligibleChallengers.find(agent => agent.agent_id === failed.agent_id)
    if (challenger) challenger.metrics.hard_failures = (challenger.metrics.hard_failures || 0) + 1
  }
  evaluation.consensus = scorePrediction(run.consensus.risk_label || run.consensus.probabilities, run.consensus.risk_control_advice, truth)
  state.case_evaluations[run.case_id] = evaluation.agents
  state.evaluated_case_ids.push(run.case_id)
  state.evaluated_run_ids.push(run.run_id)
  const evolution = state.evaluated_case_ids.length % config.evaluation_batch_size === 0
    ? evolveAtCheckpoint(state, config)
    : null
  return { state, duplicate: false, evaluation, evolution }
}

function validateEvolutionConfig(config) {
  if (!config || !['1.0.0', '2.0.0'].includes(config.contract_version)) throw new Error('evolution config contract_version must be 1.0.0 or 2.0.0')
  for (const key of [
    'evaluation_batch_size',
    'minimum_cases_before_challenger',
    'challenger_minimum_paired_cases',
    'minimum_evaluated_cases_before_promotion',
    'promotion_required_consecutive_checkpoints',
    'challenger_retirement_checkpoints',
    'maximum_active_challengers'
  ]) {
    if (!Number.isInteger(config[key]) || config[key] < 1) throw new Error(`evolution config ${key} must be a positive integer`)
  }
  for (const key of ['promotion_minimum_fitness_gain', 'promotion_minimum_brier_skill_gain', 'promotion_minimum_direction_gain', 'challenger_retirement_fitness_gap']) {
    if (!Number.isFinite(config[key])) throw new Error(`evolution config ${key} must be numeric`)
  }
  if (!config.metric_weights || !Number.isFinite(config.metric_weights.brier_skill) || !Number.isFinite(config.metric_weights.direction_accuracy) || !Number.isFinite(config.metric_weights.advice_f1)) {
    throw new Error('evolution metric_weights are invalid')
  }
  if (!config.role_mutation_pool || typeof config.role_mutation_pool !== 'object') throw new Error('evolution role_mutation_pool is required')
  if (config.contract_version === '2.0.0') {
    if (config.supervisor_role_id !== 'improvement_supervisor') throw new Error('evolution supervisor must be improvement_supervisor')
    if (!Array.isArray(config.eligible_seat_ids) || config.eligible_seat_ids.length !== 3) throw new Error('evolution requires exactly three eligible debate seats')
    if (config.maximum_replacements_per_cycle !== 1) throw new Error('at most one debate seat may be replaced per cycle')
    if (config.require_external_outcome !== true || config.allow_consensus_as_truth !== false) throw new Error('external outcome must be the objective truth source')
  }
  if (!Number.isFinite(config.active_minimum_weight) || !Number.isFinite(config.active_maximum_weight) || config.active_minimum_weight <= 0 || config.active_minimum_weight > config.active_maximum_weight) {
    throw new Error('evolution active weight bounds are invalid')
  }
  return config
}

function validateTruthAndRun(run, truth) {
  const qa = run.report?.qa
  if (!qa || qa.fixture_provider === true) throw new Error('fixture or missing-QA runs cannot enter evolution')
  if (!truth || !PROBABILITY_LABELS.includes(truth.risk_label)) throw new Error('truth.risk_label is invalid')
  if (truth.contract_version !== '1.0.0') throw new Error('truth.contract_version must be 1.0.0')
  if (truth.case_id !== run.case_id || truth.run_id !== run.run_id) throw new Error('truth must bind to the exact case_id and run_id')
  if (!isHttpsUrl(truth.source_url) || !/^[a-f0-9]{64}$/i.test(String(truth.content_sha256 || '')) || truth.verified !== true) throw new Error('truth requires verified HTTPS source_url and content_sha256')
  if (!isCalendarDate(truth.revealed_at) || !isCalendarDate(run.as_of_date) || truth.revealed_at <= run.as_of_date) throw new Error('truth must be revealed after the run as_of_date')
  if (!String(truth.label_definition_version || '').trim()) throw new Error('truth.label_definition_version is required')
  if (!qa.schema_valid || !qa.probabilities_valid || !qa.cutoff_verified || !qa.source_registry_verified || !qa.evidence_snapshots_verified || !qa.evidence_refs_valid || !qa.evidence_coverage_sufficient || !qa.production_ready || qa.degraded) {
    throw new Error('run failed a hard QA gate and cannot enter evolution')
  }
  // Disputed or majority-resolved cases remain valid error samples after all
  // production QA gates pass. Group consensus itself is never used as truth.
}

function isEvolutionParticipant(agent) {
  return agent?.evolution_eligible === true && agent?.participates_in_debate === true && agent?.participates_in_prediction !== false
}

function updateMetrics(metrics, score, config) {
  metrics.cases += 1
  metrics.brier_sum += score.brier
  metrics.direction_correct += score.direction_correct
  metrics.advice_f1_sum += score.advice_f1
  metrics.log_loss_sum += score.log_loss
  metrics.fitness = aggregateScoresFromMetrics(metrics, config).fitness
}

function aggregateScoresFromMetrics(metrics, config) {
  const cases = metrics.cases || 0
  if (!cases) return { cases: 0, brier_skill: null, direction_accuracy: null, advice_f1: null, log_loss: null, fitness: null }
  const brierSkill = 1 - (metrics.brier_sum / cases) / 2
  const directionAccuracy = metrics.direction_correct / cases
  const adviceF1 = metrics.advice_f1_sum / cases
  const objectiveFitness =
    config.metric_weights.brier_skill * brierSkill +
    config.metric_weights.direction_accuracy * directionAccuracy +
    config.metric_weights.advice_f1 * adviceF1
  const feedbackAverage = metrics.user_feedback_count
    ? clamp((metrics.user_feedback_sum / metrics.user_feedback_count + 1) / 2, 0, 1)
    : null
  const feedbackWeights = config.feedback_weights || { external_outcome: 1, user_feedback: 0 }
  const fitness = feedbackAverage === null
    ? objectiveFitness
    : feedbackWeights.external_outcome * objectiveFitness + feedbackWeights.user_feedback * feedbackAverage
  return {
    cases,
    brier_skill: round(brierSkill),
    direction_accuracy: round(directionAccuracy),
    advice_f1: round(adviceF1),
    log_loss: round(metrics.log_loss_sum / cases),
    user_feedback: feedbackAverage === null ? null : round(feedbackAverage),
    fitness: round(fitness)
  }
}

function aggregateScoreList(scores, config) {
  const metrics = emptyMetrics()
  for (const score of scores) {
    metrics.cases += 1
    metrics.brier_sum += score.brier
    metrics.direction_correct += score.direction_correct
    metrics.advice_f1_sum += score.advice_f1
    metrics.log_loss_sum += score.log_loss
  }
  return aggregateScoresFromMetrics(metrics, config)
}

function pairedScorecard(state, champion, challenger, config) {
  const championScores = []
  const challengerScores = []
  for (const caseId of state.evaluated_case_ids) {
    const scores = state.case_evaluations[caseId] || {}
    if (!scores[champion.agent_id] || !scores[challenger.agent_id]) continue
    championScores.push(scores[champion.agent_id])
    challengerScores.push(scores[challenger.agent_id])
  }
  const championScore = aggregateScoreList(championScores, config)
  const challengerScore = aggregateScoreList(challengerScores, config)
  return {
    paired_cases: championScores.length,
    champion: championScore,
    challenger: challengerScore,
    gains: {
      fitness: nullableDifference(challengerScore.fitness, championScore.fitness),
      brier_skill: nullableDifference(challengerScore.brier_skill, championScore.brier_skill),
      direction_accuracy: nullableDifference(challengerScore.direction_accuracy, championScore.direction_accuracy),
      advice_f1: nullableDifference(challengerScore.advice_f1, championScore.advice_f1)
    }
  }
}

function evolveAtCheckpoint(state, config) {
  state.checkpoint += 1
  state.generation_history ||= []
  const comparisons = []
  const retiredChallengers = []
  let promotion = null
  const promotable = []

  for (const challenger of [...state.challengers]) {
    if (!isEvolutionParticipant(challenger)) continue
    const champion = state.active.find(agent => agent.slot_id === challenger.slot_id && isEvolutionParticipant(agent))
    if (!champion) throw new Error(`challenger ${challenger.agent_id} has no eligible champion`)
    const scorecard = pairedScorecard(state, champion, challenger, config)
    const enoughCases = scorecard.paired_cases >= config.challenger_minimum_paired_cases
    const hardGatePassed = (challenger.metrics.hard_failures || 0) === 0
    const clearlyBetter = enoughCases && hardGatePassed &&
      scorecard.gains.fitness >= config.promotion_minimum_fitness_gain &&
      scorecard.gains.brier_skill >= config.promotion_minimum_brier_skill_gain &&
      scorecard.gains.direction_accuracy >= config.promotion_minimum_direction_gain
    challenger.promotion_streak = clearlyBetter ? (challenger.promotion_streak || 0) + 1 : 0
    const clearlyWorse = enoughCases && scorecard.gains.fitness <= config.challenger_retirement_fitness_gap
    challenger.failure_streak = clearlyWorse || !hardGatePassed ? (challenger.failure_streak || 0) + 1 : 0
    const comparison = {
      slot_id: challenger.slot_id,
      champion_agent_id: champion.agent_id,
      challenger_agent_id: challenger.agent_id,
      scorecard,
      hard_gate_passed: hardGatePassed,
      promotion_streak: challenger.promotion_streak,
      failure_streak: challenger.failure_streak
    }
    comparisons.push(comparison)
    if (
      state.evaluated_case_ids.length >= config.minimum_evaluated_cases_before_promotion &&
      challenger.promotion_streak >= config.promotion_required_consecutive_checkpoints
    ) promotable.push({ champion, challenger, comparison })
  }

  if (promotable.length) {
    promotable.sort((left, right) => right.comparison.scorecard.gains.fitness - left.comparison.scorecard.gains.fitness)
    promotion = promoteChallenger(state, promotable[0], config)
  } else {
    for (const challenger of [...state.challengers]) {
      if ((challenger.failure_streak || 0) < config.challenger_retirement_checkpoints) continue
      state.challengers = state.challengers.filter(item => item.agent_id !== challenger.agent_id)
      state.retired.push({
        ...structuredClone(challenger),
        retired_at_checkpoint: state.checkpoint,
        retired_reason: 'shadow_challenger_failed_objective_gate'
      })
      retiredChallengers.push(challenger.agent_id)
    }
  }

  const weightAdjustments = rebalanceActiveWeights(state, config)

  let spawned = null
  if (!promotion && state.challengers.length < config.maximum_active_challengers && state.evaluated_case_ids.length >= config.minimum_cases_before_challenger) {
    spawned = spawnChallenger(state, config)
  }
  const action = promotion
    ? 'promote_challenger'
    : spawned
      ? 'spawn_challenger'
      : retiredChallengers.length
        ? 'retire_challenger'
        : 'retain_champions'
  const event = {
    supervisor_role_id: config.supervisor_role_id || 'improvement_supervisor',
    checkpoint: state.checkpoint,
    evaluated_cases: state.evaluated_case_ids.length,
    action,
    comparisons,
    promotion,
    spawned,
    retired_challenger_ids: retiredChallengers,
    weight_adjustments: weightAdjustments,
    replacement_count: promotion ? 1 : 0,
    maximum_replacements_per_cycle: config.maximum_replacements_per_cycle || 1,
    created_at: new Date().toISOString()
  }
  state.evolution_log.push(event)
  return event
}

function spawnChallenger(state, config) {
  const occupiedSlots = new Set(state.challengers.map(agent => agent.slot_id))
  const eligibleSlots = config.eligible_seat_ids ? new Set(config.eligible_seat_ids) : null
  const candidates = state.active
    .filter(agent => isEvolutionParticipant(agent) && (!eligibleSlots || eligibleSlots.has(agent.slot_id)) && !occupiedSlots.has(agent.slot_id))
    .sort((left, right) => (left.metrics.fitness ?? -1) - (right.metrics.fitness ?? -1) || left.slot_id.localeCompare(right.slot_id))
  const champion = candidates[0]
  if (!champion) return null
  const mutations = config.role_mutation_pool?.[champion.slot_id] || []
  if (!mutations.length) throw new Error(`no approved mutation pool for ${champion.slot_id}`)
  const mutationIndex = parseInt(sha256(`${champion.slot_id}:${champion.version}:${state.checkpoint}`).slice(0, 8), 16) % mutations.length
  const mutation = mutations[mutationIndex]
  const challenger = {
    ...structuredClone(champion),
    agent_id: `${champion.slot_id}_v${champion.version + 1}_challenger_c${state.checkpoint}`,
    version: champion.version + 1,
    status: 'shadow',
    mutation,
    parent_agent_id: champion.agent_id,
    weight: config.challenger_initial_weight,
    promotion_streak: 0,
    failure_streak: 0,
    created_at_checkpoint: state.checkpoint,
    metrics: emptyMetrics()
  }
  state.challengers.push(challenger)
  return { slot_id: challenger.slot_id, parent_agent_id: champion.agent_id, challenger_agent_id: challenger.agent_id, mutation }
}

function recordUserFeedback(state, feedback, config) {
  validateEvolutionConfig(config)
  if (!feedback || feedback.contract_version !== '1.0.0') throw new Error('feedback.contract_version must be 1.0.0')
  if (!String(feedback.feedback_id || '').trim() || !String(feedback.case_id || '').trim()) throw new Error('feedback_id and case_id are required')
  if (!Array.isArray(feedback.seat_ratings) || feedback.seat_ratings.length === 0) throw new Error('seat_ratings are required')
  state.user_feedback ||= []
  if (state.user_feedback.some(item => item.feedback_id === feedback.feedback_id)) return { state, duplicate: true }
  const allowed = new Set(config.eligible_seat_ids || state.active.filter(isEvolutionParticipant).map(item => item.slot_id))
  for (const item of feedback.seat_ratings) {
    if (!allowed.has(item.slot_id)) throw new Error(`feedback cannot score non-debate role ${item.slot_id}`)
    const rating = Number(item.rating)
    if (!Number.isFinite(rating) || rating < -1 || rating > 1) throw new Error('feedback rating must be between -1 and 1')
    const agent = state.active.find(candidate => candidate.slot_id === item.slot_id && isEvolutionParticipant(candidate))
    if (!agent) throw new Error(`active debate seat not found: ${item.slot_id}`)
    agent.metrics ||= emptyMetrics()
    agent.metrics.user_feedback_count = (agent.metrics.user_feedback_count || 0) + 1
    agent.metrics.user_feedback_sum = (agent.metrics.user_feedback_sum || 0) + rating
    agent.metrics.fitness = aggregateScoresFromMetrics(agent.metrics, config).fitness
  }
  state.user_feedback.push(structuredClone(feedback))
  return { state, duplicate: false }
}

function applyImprovementProposal(state, evolutionEvent, proposal, config, execution = {}) {
  if (!evolutionEvent?.spawned?.challenger_agent_id) throw new Error('no spawned challenger is available for improvement proposal')
  const targetSlotId = evolutionEvent.spawned.slot_id
  const allowed = config.role_mutation_pool?.[targetSlotId] || []
  if (proposal?.['执行员'] !== 'improvement_supervisor') throw new Error('improvement proposal executor mismatch')
  if (proposal?.['目标席位'] !== targetSlotId) throw new Error('improvement proposal cannot override the program-selected target seat')
  if (!allowed.includes(proposal?.['选择因子'])) throw new Error('improvement proposal factor is outside the approved pool')
  if (execution.degraded === true) throw new Error('degraded improvement proposal cannot be applied to a challenger')
  const challenger = state.challengers.find(item => item.agent_id === evolutionEvent.spawned.challenger_agent_id)
  if (!challenger) throw new Error('spawned challenger is missing from population state')
  challenger.mutation = proposal['选择因子']
  challenger.mutation_source = 'improvement_supervisor_model_with_program_gate'
  challenger.mutation_proposal_sha256 = sha256(proposal)
  evolutionEvent.spawned.mutation = challenger.mutation
  evolutionEvent.improvement_supervisor = {
    executed: true,
    proposal: structuredClone(proposal),
    proposal_sha256: challenger.mutation_proposal_sha256,
    provider_mode: execution.provider_mode || null,
    provider_production_ready: execution.provider_production_ready === true,
    degraded: execution.degraded === true,
    applied_at: new Date().toISOString()
  }
  return challenger
}

function promoteChallenger(state, candidate, config) {
  const { champion, challenger, comparison } = candidate
  state.generation_history ||= []
  state.generation_history.push({
    generation: state.generation,
    checkpoint: state.checkpoint,
    active: structuredClone(state.active),
    challengers: structuredClone(state.challengers),
    saved_at: new Date().toISOString(),
    reason: 'pre_promotion_rollback_point'
  })
  state.retired.push({
    ...structuredClone(champion),
    retired_at_checkpoint: state.checkpoint,
    retired_reason: 'paired_challenger_outperformed_champion'
  })
  const promoted = {
    ...challenger,
    status: 'champion',
    weight: config.promoted_champion_weight,
    promoted_at_checkpoint: state.checkpoint,
    promotion_scorecard: comparison.scorecard,
    promotion_streak: 0,
    failure_streak: 0
  }
  state.active[state.active.findIndex(agent => agent.slot_id === champion.slot_id)] = promoted
  state.challengers = state.challengers.filter(agent => agent.agent_id !== challenger.agent_id)
  state.generation += 1
  return {
    slot_id: champion.slot_id,
    retired_agent_id: champion.agent_id,
    promoted_agent_id: promoted.agent_id,
    paired_cases: comparison.scorecard.paired_cases,
    gains: comparison.scorecard.gains
  }
}

function rebalanceActiveWeights(state, config) {
  const adjustments = []
  for (const agent of state.active) {
    if (!isEvolutionParticipant(agent)) {
      if (agent.participates_in_prediction === false && agent.weight !== 0) adjustments.push({ agent_id: agent.agent_id, from: agent.weight, to: 0 })
      if (agent.participates_in_prediction === false) agent.weight = 0
      continue
    }
    const fitness = Number.isFinite(agent.metrics?.fitness) ? agent.metrics.fitness : 0.5
    const next = round(clamp(0.5 + fitness, config.active_minimum_weight, config.active_maximum_weight), 6)
    if (next !== agent.weight) adjustments.push({ agent_id: agent.agent_id, from: agent.weight, to: next })
    agent.weight = next
  }
  return adjustments
}

function rollbackGeneration(state, targetGeneration = state.generation - 1) {
  state.generation_history ||= []
  const snapshotIndex = state.generation_history.map(item => item.generation).lastIndexOf(Number(targetGeneration))
  if (snapshotIndex < 0) throw new Error(`no rollback snapshot for generation ${targetGeneration}`)
  const snapshot = state.generation_history[snapshotIndex]
  const previousGeneration = state.generation
  state.active = structuredClone(snapshot.active)
  state.challengers = structuredClone(snapshot.challengers)
  state.generation = snapshot.generation
  state.generation_history = state.generation_history.slice(0, snapshotIndex)
  state.evolution_log.push({
    checkpoint: state.checkpoint,
    action: 'rollback_generation',
    from_generation: previousGeneration,
    to_generation: state.generation,
    created_at: new Date().toISOString()
  })
  return state
}

function nullableDifference(left, right) {
  return left === null || right === null ? null : round(left - right)
}

function setF1(predicted, actual) {
  if (predicted.size === 0 && actual.size === 0) return 1
  const intersection = [...predicted].filter(value => actual.has(value)).length
  const precision = predicted.size ? intersection / predicted.size : 0
  const recall = actual.size ? intersection / actual.size : 0
  return precision + recall ? 2 * precision * recall / (precision + recall) : 0
}

module.exports = {
  applyImprovementProposal,
  evolveAtCheckpoint,
  isEvolutionParticipant,
  pairedScorecard,
  rebalanceActiveWeights,
  recordLabeledRun,
  recordUserFeedback,
  rollbackGeneration,
  scorePrediction,
  validateEvolutionConfig
}
