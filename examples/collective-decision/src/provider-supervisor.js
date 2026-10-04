const { adaptEnterpriseOutput } = require('./enterprise-output-protocol')
const { sha256, canonicalJson } = require('./utils')

class ProviderSupervisor {
  constructor({ primary, fallback, config, validateOutput, failClosed = false, failureDomain = 'competition' }) {
    this.primary = primary
    this.fallback = fallback
    this.config = config
    this.validateOutput = validateOutput
    this.failClosed = failClosed === true
    this.failureDomain = failureDomain
    this.startedAt = Date.now()
    this.primaryCalls = 0
    this.transportAttempts = 0
    this.transportRetries = 0
    this.promptCharacters = 0
    this.fallbackEvents = []
    this.programDerivations = []
    this.protocolValidations = []
  }

  async analyze(args) { return this.invoke('analyze', args) }
  async planIndustry(args) { return this.invoke('planIndustry', args) }
  async decideStage(args) { return this.invoke('decideStage', args) }
  async reviewStage(args) { return this.invoke('reviewStage', args) }
  async reviewCalibration(args) { return this.invoke('reviewCalibration', args) }
  async proposeImprovement(args) { return this.invoke('proposeImprovement', args) }
  async critique(args) { return this.invoke('critique', args) }
  async revise(args) { return this.invoke('revise', args) }
  async monitor(args) { return this.invoke('monitor', args) }
  async conclude(args) { return this.invoke('conclude', args) }

  async invoke(operation, args) {
    const promptCharacters = JSON.stringify(args.prompt || '').length
    const budgetReason = this.budgetReason(promptCharacters)
    if (budgetReason) return this.useFallback(operation, args, budgetReason)
    const protocolRetries = Number(this.config.maximum_primary_protocol_retries ?? 1)
    let lastError
    let callArgs = args
    for (let attempt = 0; attempt <= protocolRetries; attempt += 1) {
      this.primaryCalls += 1
      this.promptCharacters += promptCharacters
      let transportCounted = false
      let value
      try {
        value = await this.primary[operation](callArgs)
        this.recordTransport(value?.model_provenance?.transport_attempts || 1)
        transportCounted = true
        if (value?.model_provenance?.protocol_validation) {
          this.protocolValidations.push({
            operation,
            agent_id: args.agent?.agent_id || null,
            ...structuredClone(value.model_provenance.protocol_validation)
          })
        }
        const derivation = bindRoutingMetadata(operation, value, args)
        this.validateOutput(operation, value, args)
        if (['planIndustry', 'proposeImprovement'].includes(operation)) await this.recordContractReview(operation, args, value, [], derivation)
        if (derivation) this.programDerivations.push(derivation)
        return value
      } catch (error) {
        if (!transportCounted) this.recordTransport(error?.transport_attempts || error?.connection_attempts || 1)
        if (value?.raw_model_response || value?.model_provenance?.raw_model_response) {
          error.raw_model_response ||= value.raw_model_response || value.model_provenance.raw_model_response
          error.raw_response_sha256 ||= sha256(error.raw_model_response)
        }
        if (value?.normalized_model_response) {
          error.normalized_model_response ||= value.normalized_model_response
          error.normalized_response_sha256 ||= sha256(error.normalized_model_response)
        }
        if (Array.isArray(value?.normalization_operations)) {
          error.normalization_operations ||= structuredClone(value.normalization_operations)
        }
        if (['planIndustry', 'proposeImprovement'].includes(operation) && value) await this.recordContractReview(operation, args, value, [error.message])
        lastError = error
        // Transport failures already exhaust the provider's reconnect policy.
        // A second supervisor call would amplify capacity pressure. Only retry
        // malformed/contract-invalid model output, with the same frozen input.
        if (error?.is_model_transport_failure || error.code === 'OUTPUT_AUDIT_WRITE_FAILED' || attempt === protocolRetries) break
        if (['planIndustry', 'proposeImprovement'].includes(operation)) callArgs = { ...args, prompt: [...(args.prompt || []), { role: 'user', content: JSON.stringify({ instruction: '程序结构校验失败，请依据以下错误重新输出完整JSON；不得补造事实或改变证据。', program_errors: [error.message], previous_output: value || error.raw_model_response || null }) }] }
        if (this.budgetReason(promptCharacters)) break
      }
    }
    return this.useFallback(operation, args, `primary_or_gate_failure:${lastError.message}`, lastError)
  }

  async recordContractReview(operation, args, value, errors, routingDerivation = null) {
    if (typeof this.primary.recordOutputTrace !== 'function') return
    await this.primary.recordOutputTrace({ call_id: require('node:crypto').randomUUID(), audit_required: true, parent_call_id: value.model_provenance?.call_id || null, operation, seat: args.agent?.agent_id, status: errors.length ? 'CONTRACT_REJECTED' : 'CONTRACT_REVIEWED', adapter_result: structuredClone(value), core_validation_result: { pass: !errors.length, errors }, routing_derivation: routingDerivation, semantic_review: 'NOT_A_DECISION_APPROVAL' })
  }

  budgetReason(nextCharacters) {
    if (this.primaryCalls >= this.config.maximum_primary_model_calls) return 'global_model_call_budget_exhausted'
    if ((Date.now() - this.startedAt) / 1000 >= this.config.maximum_elapsed_seconds) return 'global_elapsed_budget_exhausted'
    if (this.promptCharacters + nextCharacters > this.config.maximum_total_prompt_characters) return 'global_prompt_budget_exhausted'
    return null
  }

  recordTransport(attempts) {
    const count = Math.max(1, Number(attempts) || 1)
    this.transportAttempts += count
    this.transportRetries += Math.max(0, count - 1)
  }

  async useFallback(operation, args, reason, cause = null) {
    if (this.failClosed) {
      if (this.failureDomain === 'enterprise') {
        if (cause) throw Object.assign(cause, { code: cause.code || 'ENTERPRISE_MODEL_CONTRACT_INVALID', validation_errors: cause.validation_errors || [cause.message] })
        throw Object.assign(new Error(`模型调用预算已耗尽：${sanitizeReasonDetail(reason)}`), { code: 'ENTERPRISE_MODEL_BUDGET_EXHAUSTED' })
      }
      const error = new Error(`competition provider fail-closed: ${sanitizeReasonDetail(reason)}`)
      error.code = String(reason).includes('budget_exhausted') ? 'COMPETITION_BUDGET_EXCEEDED' : 'COMPETITION_PROVIDER_FAILED'
      error.cause = cause || undefined
      throw error
    }
    const value = await this.fallback[operation](args)
    const derivation = bindRoutingMetadata(operation, value, args)
    this.validateOutput(operation, value, args)
    if (derivation) this.programDerivations.push(derivation)
    const event = {
      operation,
      agent_id: args.agent?.agent_id || null,
      reason_code: String(reason).split(':')[0],
      reason_detail: sanitizeReasonDetail(reason),
      cause_sha256: cause ? sha256(cause.message) : null,
      occurred_at: new Date().toISOString()
    }
    this.fallbackEvents.push(event)
    Object.defineProperty(value, 'model_provenance', { enumerable: false, configurable: true, value: {
      ...(value.model_provenance || {}),
      provider_mode: 'deterministic_fallback',
      degraded: true,
      fallback_event_sha256: sha256(event)
    } })
    return value
  }

  diagnostics() {
    return {
      degraded: this.fallbackEvents.length > 0,
      primary_model_calls: this.primaryCalls,
      logical_model_calls: this.primaryCalls,
      transport_attempts: this.transportAttempts,
      transport_retries: this.transportRetries,
      total_prompt_characters: this.promptCharacters,
      elapsed_seconds: Math.round((Date.now() - this.startedAt) / 1000),
      fallback_events: structuredClone(this.fallbackEvents),
      program_derivations: structuredClone(this.programDerivations),
      protocol_validations: structuredClone(this.protocolValidations)
    }
  }
}

function bindRoutingMetadata(operation, value, args) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  const agent = args.agent || {}
  let stageDerivation = null
  if (['planIndustry', 'proposeImprovement'].includes(operation)) {
    if (value.normalized_model_response && canonicalJson(value) !== value.normalized_model_response) throw Object.assign(new Error('适配结果与门禁输入不一致'), { code: 'OUTPUT_PIPELINE_DRIFT' })
    const prior = value.normalization_operations?.find(item => item.operation === 'bind_trusted_route_agent_id')
    const adapted = adaptEnterpriseOutput(value, { operation, expectedAgentId: agent.agent_id })
    const binding = prior || adapted.operations[0]
    stageDerivation = { operation, field: '执行员', rule: 'trusted_route_agent_id', model_reported_value: binding.model_reported_value, derived_value: agent.agent_id }
    Object.assign(value, adapted.value)
  }
  if (['decideStage', 'reviewStage'].includes(operation)) {
    value['执行员'] = agent.agent_id
    const reportedFieldPresent = Array.isArray(value['证据'])
    const reported = Array.isArray(value['证据']) ? value['证据'].map(String) : []
    const derived = [...new Set((value['逻辑'] || []).flatMap(item => Array.isArray(item?.evidence_refs) ? item.evidence_refs.map(String) : []))].sort()
    value['证据'] = derived
    const providerAudit = value.stage_evidence_derivation || null
    stageDerivation = {
      contract_version: '1.0.0',
      operation,
      stage_phase: args.phase || null,
      agent_id: agent.agent_id || null,
      field: '证据',
      rule: 'sorted_unique_union_of_logic_evidence_refs',
      derived_count: derived.length,
      derived_sha256: sha256(JSON.stringify(derived)),
      changed_at_supervisor: JSON.stringify(reported) !== JSON.stringify(derived),
      model_reported_field_present: providerAudit?.model_reported_field_present ?? reportedFieldPresent,
      model_reported_count: providerAudit?.model_reported_count ?? reported.length,
      model_reported_sha256: providerAudit?.model_reported_sha256 ?? sha256(JSON.stringify(reported)),
      changed_from_model_report: providerAudit?.changed ?? (JSON.stringify(reported) !== JSON.stringify(derived)),
      normalization_path: providerAudit?.normalization_path || 'supervisor_only',
      occurred_at: new Date().toISOString()
    }
  }
  if (operation === 'reviewCalibration') value.reviewer_id = 'competition_calibration_reviewer'
  if (['analyze', 'revise'].includes(operation)) {
    value.agent_id = agent.agent_id
    value.agent_version = agent.version
    value.method_family = agent.method_family
    if (operation === 'revise') value.probabilities = structuredClone(args.opinion?.probabilities)
    if (!['risk_up', 'risk_flat', 'risk_down'].includes(value.result_candidate)) {
      value.result_candidate = operation === 'revise'
        ? args.opinion?.result_candidate
        : probabilityWinner(value.probabilities)
    }
    value.recommended_advice = normalizeArray(value.recommended_advice, { splitComma: true }).map(String)
    value.uncertainties = normalizeArray(value.uncertainties)
    for (const factor of value.factors || []) {
      factor.evidence_refs = normalizeArray(factor.evidence_refs).map(String)
      factor.strength = normalizeFiniteNumber(factor.strength)
      factor.confidence = normalizeFiniteNumber(factor.confidence)
      factor.horizon_days = normalizeFiniteNumber(factor.horizon_days)
    }
    for (const edge of value.chain_map?.edges || []) {
      edge.evidence_refs = normalizeArray(edge.evidence_refs).map(String)
      edge.horizon_days = normalizeFiniteNumber(edge.horizon_days)
    }
    for (const response of value.revision?.responses || []) response.evidence_refs = normalizeArray(response.evidence_refs).map(String)
  }
  if (operation === 'monitor') {
    value.agent_id = agent.agent_id
    value.relevant_evidence_ids = normalizeArray(value.relevant_evidence_ids).map(String)
    value.monitoring_gaps = normalizeArray(value.monitoring_gaps)
    value.query_refinements = normalizeArray(value.query_refinements)
    for (const signal of value.topic_signals || []) signal.evidence_refs = normalizeArray(signal.evidence_refs).map(String)
  }
  if (operation === 'critique') {
    value.reviewer_id = agent.agent_id
    value.target_agent_id = args.targetOpinion?.agent_id
    if (!Array.isArray(value.checks_performed) && value.checks_performed && typeof value.checks_performed === 'object') {
      value.checks_performed = Object.entries(value.checks_performed)
        .filter(([, result]) => result !== false && result !== null && result !== undefined && result !== '')
        .map(([check]) => check)
    }
    const categoryAliases = {
      time_boundary: 'cutoff_violation',
      citation_integrity: 'evidence_reference_invalid',
      source_independence: 'duplicate_source_independence',
      causal_direction: 'causal_direction_error',
      substitution_and_qualification: 'alternative_explanation'
    }
    for (const challenge of value.challenges || []) {
      challenge.target_result = args.targetOpinion?.result_candidate || probabilityWinner(args.targetOpinion?.probabilities)
      if (categoryAliases[challenge.category]) challenge.category = categoryAliases[challenge.category]
      challenge.evidence_refs = normalizeArray(challenge.evidence_refs).map(String)
    }
    value.evidence_refs = normalizeArray(value.evidence_refs).map(String)
  }
  if (operation === 'conclude') {
    value.agent_id = agent.agent_id
    value.agent_version = agent.version
    value.action = args.consensus?.action
    value.risk_control_advice = structuredClone(args.consensus?.risk_control_advice || [])
    value.rationale = normalizeArray(value.rationale)
    value.monitoring_conditions = normalizeArray(value.monitoring_conditions)
    value.evidence_refs = normalizeArray(value.evidence_refs).map(String)
  }
  return stageDerivation
}

function normalizeArray(value, { splitComma = false } = {}) {
  if (Array.isArray(value)) return value
  if (value === undefined || value === null || value === '') return []
  if (splitComma && typeof value === 'string') return value.split(',').map(item => item.trim()).filter(Boolean)
  return [value]
}

function normalizeFiniteNumber(value) {
  if (typeof value !== 'string' || value.trim() === '') return value
  const number = Number(value)
  return Number.isFinite(number) ? number : value
}

function probabilityWinner(probabilities = {}) {
  return ['risk_up', 'risk_flat', 'risk_down'].reduce((best, label) => Number(probabilities[label]) > Number(probabilities[best]) ? label : best)
}

function sanitizeReasonDetail(reason) {
  return String(reason || 'unknown')
    .replace(/Bearer\s+[^\s]+/gi, 'Bearer [REDACTED]')
    .replace(/(?:api[_-]?key|token|secret)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]')
    .slice(0, 1000)
}

module.exports = { ProviderSupervisor }
