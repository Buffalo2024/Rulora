const fs = require('node:fs/promises')
const path = require('node:path')
const { readJson, writeJsonAtomic } = require('./utils')
const { withFileLock } = require('./file-lock')

class PopulationStore {
  constructor({ filePath, roles }) {
    this.filePath = path.resolve(filePath)
    this.roles = structuredClone(roles)
  }

  initialState() {
    return {
      contract_version: '1.0.0',
      _version: 0,
      generation: 1,
      checkpoint: 0,
      evaluated_case_ids: [],
      evaluated_run_ids: [],
      active: this.roles.map(role => ({
        slot_id: role.id,
        agent_id: role.id,
        version: 1,
        status: 'champion',
        label: role.label,
        method_family: role.method_family,
        mission: role.mission,
        required_lenses: role.required_lenses,
        stage: role.stage,
        model_profile: role.model_profile || null,
        participates_in_prediction: role.participates_in_prediction !== false,
        participates_in_debate: role.participates_in_debate === true,
        evolution_eligible: role.evolution_eligible !== false,
        mutation: null,
        weight: role.initial_weight,
        probation_streak: 0,
        metrics: emptyMetrics()
      })),
      challengers: [],
      retired: [],
      evolution_log: [],
      generation_history: [],
      case_evaluations: {}
    }
  }

  async load() {
    // Re-read after a concurrent migration; never overwrite a newer population.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      let state
      try { state = await readJson(this.filePath) } catch (error) {
        if (error.code !== 'ENOENT') throw error
        state = null
      }
      const reconciled = state ? reconcileState(state, this.roles) : { changed: true, state: this.initialState() }
      if (!reconciled.changed) return reconciled.state
      try { return await this.save(reconciled.state) } catch (error) {
        if (error.code !== 'CAS_CONFLICT' || attempt === 4) throw error
      }
    }
  }

  async save(state, { expectedVersion = state._version } = {}) {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true })
    return withFileLock(`${this.filePath}.lock`, async () => {
      let current = null
      try { current = await readJson(this.filePath) } catch (error) { if (error.code !== 'ENOENT') throw error }
      const currentVersion = current?._version || 0
      if (!Number.isInteger(expectedVersion) || expectedVersion !== currentVersion) {
        const error = new Error(`population CAS conflict: expected ${expectedVersion}, current ${currentVersion}`)
        error.code = 'CAS_CONFLICT'
        throw error
      }
      const next = { ...state, _version: currentVersion + 1 }
      await writeJsonAtomic(this.filePath, next)
      return structuredClone(next)
    })
  }

  async reset() {
    try {
      await fs.unlink(this.filePath)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    return this.load()
  }
}

function reconcileState(state, roles) {
  let changed = false
  if (!Number.isInteger(state._version)) {
    state._version = 0
    changed = true
  }
  state.challengers ||= []
  state.retired ||= []
  state.evolution_log ||= []
  state.generation_history ||= []
  state.evaluated_run_ids ||= []
  state.case_evaluations ||= {}
  const oldActive = new Map((state.active || []).map(agent => [agent.slot_id, agent]))
  const nextActive = []
  for (const role of roles) {
    const existing = oldActive.get(role.id)
    if (existing && existing.method_family === role.method_family) {
      if (
        existing.label !== role.label ||
        existing.mission !== role.mission ||
        existing.stage !== role.stage ||
        existing.model_profile !== (role.model_profile || null) ||
        existing.participates_in_prediction !== (role.participates_in_prediction !== false) ||
        existing.participates_in_debate !== (role.participates_in_debate === true) ||
        existing.evolution_eligible !== (role.evolution_eligible !== false) ||
        (role.participates_in_prediction === false && existing.weight !== 0) ||
        !Number.isFinite(existing.metrics?.hard_failures)
      ) changed = true
      nextActive.push({
        ...existing,
        label: role.label,
        mission: role.mission,
        required_lenses: role.required_lenses,
        status: 'champion',
        stage: role.stage,
        model_profile: role.model_profile || null,
        participates_in_prediction: role.participates_in_prediction !== false,
        participates_in_debate: role.participates_in_debate === true,
        evolution_eligible: role.evolution_eligible !== false,
        weight: role.participates_in_prediction === false ? 0 : existing.weight,
        metrics: normalizeMetrics(existing.metrics)
      })
      oldActive.delete(role.id)
      continue
    }
    changed = true
    nextActive.push({
      slot_id: role.id,
      agent_id: role.id,
      version: 1,
      status: 'champion',
      label: role.label,
      method_family: role.method_family,
      mission: role.mission,
      required_lenses: role.required_lenses,
      stage: role.stage,
      model_profile: role.model_profile || null,
      participates_in_prediction: role.participates_in_prediction !== false,
      participates_in_debate: role.participates_in_debate === true,
      evolution_eligible: role.evolution_eligible !== false,
      mutation: null,
      weight: role.initial_weight,
      probation_streak: 0,
      metrics: emptyMetrics()
    })
  }
  for (const obsolete of oldActive.values()) {
    changed = true
    state.retired.push({
      ...obsolete,
      retired_at_checkpoint: state.checkpoint || 0,
      retired_reason: 'role_architecture_migration'
    })
  }
  if (nextActive.length !== (state.active || []).length) changed = true
  state.active = nextActive
  const eligibleSlots = new Set(roles
    .filter(role => role.participates_in_debate === true && role.evolution_eligible !== false)
    .map(role => role.id))
  const keptChallengers = []
  for (const challenger of state.challengers) {
    if (eligibleSlots.has(challenger.slot_id)) {
      keptChallengers.push({
        ...challenger,
        status: 'shadow',
        participates_in_debate: true,
        evolution_eligible: true,
        metrics: normalizeMetrics(challenger.metrics)
      })
    } else {
      changed = true
      state.retired.push({
        ...challenger,
        retired_at_checkpoint: state.checkpoint || 0,
        retired_reason: 'role_no_longer_evolution_eligible'
      })
    }
  }
  state.challengers = keptChallengers
  return { state, changed }
}

function emptyMetrics() {
  return {
    cases: 0,
    brier_sum: 0,
    direction_correct: 0,
    advice_f1_sum: 0,
    log_loss_sum: 0,
    hard_failures: 0,
    user_feedback_count: 0,
    user_feedback_sum: 0,
    fitness: null
  }
}

function normalizeMetrics(metrics = {}) {
  return {
    ...emptyMetrics(),
    ...metrics,
    hard_failures: Number(metrics.hard_failures) || 0,
    user_feedback_count: Number(metrics.user_feedback_count) || 0,
    user_feedback_sum: Number(metrics.user_feedback_sum) || 0
  }
}

module.exports = { PopulationStore, emptyMetrics, reconcileState }
