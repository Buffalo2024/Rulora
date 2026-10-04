const { modelFetch, DEFAULT_MODEL_TIMEOUT_MS } = require('../model-http')
const { usesEnterpriseProtocol, recoverEnterpriseOutput, adaptEnterpriseOutput } = require('../enterprise-output-protocol')
const fs = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')
const { canonicalJson, sha256 } = require('../utils')
const { ProviderHealthMonitor } = require('../provider-health-monitor')
const { globalProviderScheduler } = require('../global-provider-scheduler')
const { adaptCompetitionActionOutput, adaptCompetitionReviewerOutput, adaptCompetitionRiskOutput, adaptCompetitionSeatOutput } = require('../competition-output-adapter')
const { recoverCompetitionOutput } = require('../competition-output-recovery')
const { persistLlmOutputTrace, traceIdentity } = require('../llm-output-trace')
const { HARD_FAIL, PAUSED_SEAT_FAILURE, REVISE_REQUIRED, buildConstraintRevisionPrompt, classifyCompetitionValidationFailure } = require('../competition-validation-loop')

// Use the exact gate schema as the wire contract; routing identity is program-owned.
const industryPlanWireSchema = structuredClone(require('../../schemas/industry-plan.schema.json'))
delete industryPlanWireSchema.properties['执行员']
industryPlanWireSchema.required = industryPlanWireSchema.required.filter(key => key !== '执行员')
const INDUSTRY_PLAN_OUTPUT_INSTRUCTION = '只返回一个JSON对象，不要Markdown。执行员由程序填写。所有字段、数组数量和长度须符合以下JSON Schema；只写必要内容，上限不是目标。不得声称待验证关系已经确认。\n' + JSON.stringify(industryPlanWireSchema)

const CREDIT_DIRECTION_OUTPUT_INSTRUCTION = [
  '只返回一个JSON对象，不要Markdown代码块或解释。',
  '当前且仅执行经营调整方向阶段。',
  '顶层字段必须且只能是：执行员、经营调整方向、逻辑、证据。',
  '经营调整方向的值必须且只能是risk_up、risk_flat、risk_down之一，不得输出中文同义词。',
  '禁止输出风控建议、概率、因子评分、chain_map、result_candidate、recommended_advice或外层包装字段。',
  '逻辑每项只能包含claim、mechanism、evidence_refs；每条逻辑必须语义选择对应的登记证据ID。',
  '顶层证据仅为传输汇总字段，程序将以逻辑[].evidence_refs的排序去重并集确定性覆盖。',
  '禁止输出challenge、revision、response或其他字段。'
].join('\n')

const RISK_CONTROL_ADVICE_OUTPUT_INSTRUCTION = [
  '只返回一个JSON对象，不要Markdown代码块或解释。',
  '当前且仅执行风控建议阶段。',
  '顶层字段必须且只能是：执行员、风控建议、逻辑、证据。',
  '风控建议必须是由1至3个字符串组成的数组；每项只能是1至9中的单个数字字符串，不得附加名称或说明。',
  '禁止输出经营调整方向、概率、因子评分、chain_map、result_candidate、recommended_advice或外层包装字段。',
  '逻辑每项只能包含claim、mechanism、evidence_refs；每条逻辑必须语义选择对应的登记证据ID。',
  '顶层证据仅为传输汇总字段，程序将以逻辑[].evidence_refs的排序去重并集确定性覆盖。',
  '禁止输出challenge、revision、response或其他字段。'
].join('\n')

const COMPETITION_DIRECTION_OUTPUT_INSTRUCTION = [
  '只返回一个JSON对象，不要Markdown代码块或解释。',
  '顶层字段必须且只能是：execution_agent、action_candidate、action_confidence、action_reason、transmission_evidence、threshold_evidence、counter_evidence、执行员、经营调整方向、逻辑、证据。',
  'action_candidate必须为-1、0、1，且与risk_up、risk_flat、risk_down按-1、0、1对应；action_confidence只是0..1自评辅助信号。',
  'transmission_evidence只列证明风险已传导到目标企业的证据ID；threshold_evidence只列证明已达经营调整门槛的证据ID；counter_evidence列反向证据ID。',
  '不得把0当作不确定时的默认答案；-1、0、1按同一席位支持标准竞争。选择0时，action_reason或counter_evidence应说明为什么收紧与放宽均未达到门槛。',
  '逻辑每项只包含claim、mechanism、evidence_refs；证据字段由程序按逻辑引用排序去重生成。'
].join('\n')

const COMPETITION_ADVICE_OUTPUT_INSTRUCTION = [
  '只返回一个JSON对象，不要Markdown代码块或解释。',
  '顶层字段必须且只能是：execution_agent、set_confidence、label_assessments、执行员、风控建议、逻辑、证据。',
  '风控建议必须是0至4个1..9数字字符串的唯一数组；空数组合法。',
  'label_assessments必须覆盖每个已保留码，每项只含code、necessary、why_required、why_deletable、counter_evidence。',
  '目标是标准答案exact-set，同时控制漏选与多选；空集合与非空集合适用相同标准，Action=0不等于没有风控建议，只有明确判断1至9均不应入选时才输出空数组。',
  '逻辑每项只包含claim、mechanism、evidence_refs；证据字段由程序按逻辑引用排序去重生成。'
].join('\n')

const INDUSTRY_CHAIN_ACTION_OUTPUT_INSTRUCTION = [
  '不要输出JSON。先输出以 ## FINAL_DECISION 开始、以 ## END_FINAL_DECISION 结束的短核心块。',
  '核心块只写 action_candidate: -1|0|1 与可选 decision_confidence: low|medium|high。',
  '随后以 ## INDUSTRY_CHAIN_ANALYSIS 开始输出Markdown分析；分析文本不得写入核心块。'
].join('\n')

const INDUSTRY_CHAIN_RISK_OUTPUT_INSTRUCTION = [
  '不要输出JSON。先输出以 ## FINAL_DECISION 开始、以 ## END_FINAL_DECISION 结束的短核心块。',
  '核心块只写 risk_control_advice: [] 或0至4个唯一1..9编码数组，以及可选 decision_confidence: low|medium|high。',
  '随后以 ## INDUSTRY_CHAIN_ANALYSIS 开始输出Markdown分析；分析文本不得写入核心块。'
].join('\n')

const COMPETITION_JOINT_OUTPUT_INSTRUCTION = [
  '只返回一个JSON对象，不要Markdown代码块或解释。',
  '这是Competition Mode唯一一次联合席位判断；同时输出Action候选与Risk必要标签完整集合。',
  '核心必填字段只有action_candidate与风控建议；action_reason与逻辑建议提供，以保留关键理由和证据引用。',
  '推荐审计字段为execution_agent、action_confidence、transmission_evidence、threshold_evidence、counter_evidence、set_confidence、label_assessments；缺失不会改变核心Action/Risk。',
  'action_candidate必须为-1、0、1，且与risk_up、risk_flat、risk_down按-1、0、1对应；action_confidence和set_confidence仅为0..1自评辅助信号。',
  '不得把0当作不确定时的默认答案；-1、0、1按同一席位支持标准竞争。',
  'action_reason必须是字符串数组。label_assessments中why_required、why_deletable、counter_evidence必须是数组。',
  '风控建议必须是0至4个1..9数字字符串的唯一数组；空数组合法但不享有优先级。不得把仅因业务上合理的措施加入集合，也不得因证据不确定就机械删空；Action=0不等于没有风控建议。',
  'label_assessments必须覆盖每个已保留码，每项只含code、necessary、why_required、why_deletable、counter_evidence。',
  'transmission_evidence只列传导证据ID；threshold_evidence只列经营调整门槛证据ID；counter_evidence列反证ID。',
  '逻辑每项只包含claim、mechanism、evidence_refs；每项evidence_refs至少一个登记证据ID。',
  '执行员、经营调整方向、证据是Program派生字段，禁止模型输出：Program分别从路由身份、action_candidate、逻辑引用确定性生成。'
].join('\n')

const COMPETITION_CALIBRATION_OUTPUT_INSTRUCTION = [
  '响应的第一个字符必须是{，最后一个字符必须是}；只返回一个JSON对象。',
  '禁止输出分析过程、思考过程、开场白、Markdown代码块或JSON之外的任何文字。',
  '你只能从Program提供的冻结候选池中选择，不得重新输出Action或Risk真实值。',
  '必填字段：selected_action_candidate_id、selected_risk_candidate_id、challenge_intent、evidence_strength。',
  'selected_action_candidate_id和selected_risk_candidate_id必须原样取自输入候选池；challenge_intent必须是boolean。',
  'evidence_strength只能是strong、moderate、weak；selection_reason是可选字符串数组。',
  '禁止输出action、recommended_action、risk_control_advice、recommended_risk_set或任何新标签。',
  '禁止输出重新分析、重新广播、重新采集、下一轮审查或任何请求字段。'
].join('\n')

const IMPROVEMENT_OUTPUT_INSTRUCTION = [
  '只返回一个JSON对象，不要Markdown代码块或解释。',
  '对象必须且只能包含：目标席位、选择因子、调整理由、评估依据；执行员由程序按调用身份填写。',
  '选择因子必须原样取自输入allowed_mutations。',
  '评估依据必须原样包含输入的checkpoint、evaluated_cases、scorecard_sha256。'
].join('\n')

const MONITOR_OUTPUT_INSTRUCTION = [
  '只返回一个 JSON 对象，不要 Markdown 代码块或解释。',
  '对象必须包含：agent_id(string)、relevant_evidence_ids(string[])、topic_signals(array)、monitoring_gaps(string[])、query_refinements(string[])、abstain(boolean)。',
  'topic_signals 每项包含 topic、direction(risk_up|neutral|risk_down)、evidence_refs(string[])、summary。',
  '所有 evidence_refs 和 relevant_evidence_ids 必须来自输入证据账本。',
  '监控员不参与预测投票：禁止输出三态概率、action 或 risk_control_advice。'
].join('\n')

const CREDIT_STRATEGY_OUTPUT_INSTRUCTION = [
  '只返回一个 JSON 对象，不要 Markdown 代码块或解释。',
  '对象必须包含 agent_id、agent_version、action、risk_control_advice、strategy_summary、rationale、monitoring_conditions、evidence_refs。',
  'action 和 risk_control_advice 必须原样复制程序冻结值；禁止输出 probabilities 或任何概率覆盖字段。',
  'rationale 和 monitoring_conditions 是字符串数组；所有 evidence_refs 必须来自输入证据账本。'
].join('\n')

class MultiModelProvider {
  constructor({ config, configPath = null, fetchImpl = modelFetch, environment = process.env, healthMonitor = null, scheduler = null } = {}) {
    if (!config || config.contract_version !== '1.0.0' || !config.profiles) {
      throw new Error('model profile config must use contract_version 1.0.0 and define profiles')
    }
    if (typeof fetchImpl !== 'function') throw new Error('global fetch is unavailable; Node.js 20+ is required')
    this.config = structuredClone(config)
    this.configPath = configPath
    this.fetch = fetchImpl
    this.environment = environment
    this.healthMonitor = healthMonitor
    this.scheduler = scheduler || globalProviderScheduler()
    this.healthTrackingErrors = []
  }

  async planIndustry({ agent, prompt }) {
    const value = await this.callForJson({ agent, prompt, outputInstruction: INDUSTRY_PLAN_OUTPUT_INSTRUCTION, operation: 'planIndustry' })
    return value
  }

  async decideStage({ agent, prompt, phase, mode = 'business' }) {
    return this.callForJson({ agent, prompt, outputInstruction: stageOutputInstruction(phase, mode, agent), operation: 'decideStage', stagePhase: phase, decisionMode: mode })
  }

  async reviewStage({ agent, prompt, phase, mode = 'business' }) {
    return this.callForJson({ agent, prompt, outputInstruction: stageOutputInstruction(phase, mode, agent), operation: 'reviewStage', stagePhase: phase, decisionMode: mode })
  }

  async reviewCalibration({ agent, prompt, reviewCandidatePool = null }) {
    return this.callForJson({ agent, prompt, outputInstruction: COMPETITION_CALIBRATION_OUTPUT_INSTRUCTION, operation: 'reviewCalibration', adapterContext: { reviewCandidatePool } })
  }

  async proposeImprovement({ agent, prompt }) {
    return this.callForJson({ agent, prompt, outputInstruction: IMPROVEMENT_OUTPUT_INSTRUCTION, operation: 'proposeImprovement' })
  }

  async monitor({ agent, prompt }) {
    return this.callForJson({ agent, prompt, outputInstruction: MONITOR_OUTPUT_INSTRUCTION, operation: 'monitor' })
  }

  async conclude({ agent, prompt }) {
    return this.callForJson({ agent, prompt, outputInstruction: CREDIT_STRATEGY_OUTPUT_INSTRUCTION, operation: 'conclude' })
  }

  async callForJson({ agent, prompt, outputInstruction, operation, stagePhase = null, decisionMode = 'business', adapterContext = null, constraintRevisionAttempt = 0, validationLoopHistory = [], emptyResponseRetry = false, transportPolicy = null }) {
    const enterpriseProtocol = usesEnterpriseProtocol(operation, decisionMode)
    const strictSinglePass = enterpriseProtocol || ['competition_calibrated', 'competition_calibrated_v2'].includes(decisionMode) || operation === 'reviewCalibration'
    const { profileId, profile } = this.resolveProfile(agent)
    const messages = appendInstruction(prompt, outputInstruction)
    const traceBase = traceIdentity({
      messages,
      agent,
      operation,
      stagePhase,
      model: resolveSetting(profile, 'model', this.environment),
      profileId,
      outputInstruction
    })
    traceBase.audit_required = enterpriseProtocol
    const stableIndustryOutput = decisionMode === 'competition_calibrated_v2' && agent.agent_id === 'industry_chain_analyst' && ['decideStage', 'reviewStage'].includes(operation)
    const request = this.buildRequest(profile, messages, { forceText: stableIndustryOutput })
    let response
    try {
      response = await this.scheduler.schedule(profileId, operation, () => requestWithRetry({
          fetchImpl: this.fetch,
          url: request.url,
          init: request.init,
          timeoutMs: resolveNumber(profile.timeout_ms, DEFAULT_MODEL_TIMEOUT_MS),
          maxRetries: strictSinglePass ? resolveNumber(profile.max_transport_retries, 2) : resolveNumber(profile.max_retries, 3),
          maxTimeoutRetries: transportPolicy?.maxTimeoutRetries ?? Infinity,
          timeoutRetryMs: transportPolicy?.timeoutRetryMs ?? null,
          baseDelayMs: resolveNumber(profile.retry_base_delay_ms, 1000),
          maxDelayMs: resolveNumber(profile.retry_max_delay_ms, 15000),
          jitterRatio: strictSinglePass ? 0 : resolveNumber(profile.retry_jitter_ratio, 0.2),
          retryDelaysMs: strictSinglePass ? profile.transport_retry_delays_ms : null,
          onRequestRepair: async repair => {
            traceBase.request_repairs = [...(traceBase.request_repairs || []), repair]
            await this.recordOutputTrace({ ...traceBase, call_id: `${traceBase.call_id}-request-repair-${repair.attempt}`, parent_call_id: traceBase.call_id, status: 'REQUEST_RETRY', error_code: 'JSON_MODE_INPUT_REQUIRED' })
          }
        }))
    } catch (error) {
      await this.recordHealth('recordFailure', {
        profileId,
        model: resolveSetting(profile, 'model', this.environment),
        operation,
        error
      })
      Object.assign(error, { agent_id: agent.agent_id, agent_label: agent.label, model_profile: profileId, model: traceBase.model })
      await this.recordOutputTrace({ ...traceBase, status: 'FAILED', error_code: error.code || 'MODEL_API_ERROR', transport_diagnostics: error.transport_diagnostics || null })
      throw error
    }
    traceBase.transport_diagnostics = response.transport_diagnostics || null
    let content
    try {
      content = await extractResponseContent(profile.provider, response)
    } catch (error) {
      Object.assign(error, { agent_id: agent.agent_id, agent_label: agent.label, model_profile: profileId, model: traceBase.model })
      await this.recordHealth('recordFailure', { profileId, model: traceBase.model, operation, error })
      await this.recordOutputTrace({ ...traceBase, status: 'FAILED', error_code: error.code || 'MODEL_RESPONSE_INVALID', core_validation_result: { pass: false, reason: error.code || 'MODEL_RESPONSE_INVALID' } })
      if (error.code === 'MODEL_API_EMPTY_RESPONSE' && !emptyResponseRetry) {
        return this.callForJson({ ...arguments[0], emptyResponseRetry: true })
      }
      throw error
    }
    await this.recordHealth('recordSuccess', {
      profileId,
      model: resolveSetting(profile, 'model', this.environment),
      operation
    })
    let finalContent = content
    let value
    let normalizationOperations = /^```(?:json)?\s*/i.test(String(content).trim())
      ? [{ type: 'SAFE_NORMALIZATION', operation: 'strip_json_fence', field: '$' }]
      : []
    let normalizedResponse = null
    let protocolValidation = null
    let outputRecovery = null
    try {
      if (enterpriseProtocol) {
        const recovered = recoverEnterpriseOutput(content)
        outputRecovery = recovered.output_recovery
        const adapted = adaptEnterpriseOutput(recovered.value, { operation, expectedAgentId: agent.agent_id, referenceBinding: prompt.reference_binding || adapterContext?.referenceBinding })
        value = adapted.value
        finalContent = recovered.normalized_text
        outputRecovery = recovered.output_recovery
        normalizedResponse = adapted.normalized_response
        normalizationOperations = [...outputRecovery.operations.map(operation => ({ type: 'SAFE_NORMALIZATION', operation, field: '$' })), ...(adapted.operations || [])]
        protocolValidation = { syntax_pass: true, adapter_applied: true, contract_review: 'PENDING_CALLER_GATE', semantic_review: 'NOT_PERFORMED_BY_ADAPTER' }
      } else if (strictSinglePass) {
        const recovered = recoverCompetitionOutput(content, { stagePhase, operation })
        value = recovered.value
        finalContent = recovered.normalized_text
        outputRecovery = recovered.output_recovery
        if (outputRecovery.repair_applied) {
          normalizationOperations.push(...outputRecovery.operations.map(operation => ({ type: 'SAFE_NORMALIZATION', operation, field: '$' })))
          normalizationOperations.push({ type: 'PROTOCOL_WARNING', operation: 'OUTPUT_RECOVERED' })
        }
      } else value = parseJsonObject(content)
      if (['decideStage', 'reviewStage'].includes(operation) && ['competition_calibrated', 'competition_calibrated_v2'].includes(decisionMode)) {
        const oldWireShapePass = oldCompetitionWireShapeValid(value, stagePhase)
        const normalized = decisionMode === 'competition_calibrated_v2'
          ? stagePhase === 'decision_direction'
            ? adaptCompetitionActionOutput(value, { expectedAgentId: agent.agent_id, referenceBinding: prompt.reference_binding || adapterContext?.referenceBinding })
            : adaptCompetitionRiskOutput(value, { expectedAgentId: agent.agent_id, referenceBinding: prompt.reference_binding || adapterContext?.referenceBinding })
          : adaptCompetitionSeatOutput(value, { expectedAgentId: agent.agent_id, referenceBinding: prompt.reference_binding || adapterContext?.referenceBinding })
        value = normalized.value
        normalizationOperations = [...normalizationOperations, ...normalized.warnings.map(operation => ({ type: 'PROTOCOL_WARNING', operation }))]
        if (!oldWireShapePass) normalizationOperations.push({ type: 'PROTOCOL_WARNING', operation: 'old_wire_validation_warning' })
        normalizedResponse = normalized.normalized_response
        protocolValidation = {
          old_wire_shape_pass: oldWireShapePass,
          core_contract_pass: decisionMode === 'competition_calibrated_v2'
            ? stagePhase === 'decision_direction' ? [-1, 0, 1].includes(Number(value.action_candidate)) : competitionRiskDecisionValid(value)
            : competitionCoreDecisionValid(value),
          adapter_applied: true,
          warnings: [...new Set([...normalized.warnings, ...(!oldWireShapePass ? ['old_wire_validation_warning'] : [])])]
        }
      }
      if (operation === 'reviewCalibration') {
        const normalized = adaptCompetitionReviewerOutput(value, adapterContext || {})
        value = normalized.value
        normalizationOperations = [...normalizationOperations, ...normalized.warnings.map(operation => ({ type: 'PROTOCOL_WARNING', operation }))]
        normalizedResponse = normalized.normalized_response
        protocolValidation = { core_contract_pass: true, adapter_applied: true, warnings: [...normalized.warnings] }
      }
      if (['decideStage', 'reviewStage'].includes(operation) && !['competition_calibrated', 'competition_calibrated_v2'].includes(decisionMode)) value = normalizeStageWireFormat(value, stagePhase)
      if (['decideStage', 'reviewStage'].includes(operation) && !stageWireShapeValid(value, stagePhase, decisionMode)) {
        const shapeError = new Error('stage response does not contain exactly the required stage contract fields')
        if (strictSinglePass) throw rawResponseError(shapeError, content, response.transport_attempts)
        finalContent = await this.repairJsonResponse({ profileId, profile, operation, content, outputInstruction, parseError: shapeError, stagePhase, decisionMode })
        value = parseJsonObject(finalContent)
        if (!['competition_calibrated', 'competition_calibrated_v2'].includes(decisionMode)) value = normalizeStageWireFormat(value, stagePhase)
        if (!stageWireShapeValid(value, stagePhase, decisionMode)) {
          finalContent = await this.repairJsonResponse({ profileId, profile, operation, content: finalContent, outputInstruction, parseError: shapeError, stagePhase, decisionMode })
          value = parseJsonObject(finalContent)
          if (!['competition_calibrated', 'competition_calibrated_v2'].includes(decisionMode)) value = normalizeStageWireFormat(value, stagePhase)
        }
      }
    } catch (parseError) {
      if (enterpriseProtocol) {
        await this.recordOutputTrace({ ...traceBase, status: 'FAILED', raw_model_response: String(content), raw_response_sha256: sha256(String(content)), recovery_result: outputRecovery || { status: 'FAILED', reason: parseError.message }, adapter_result: normalizedResponse ? safeJson(normalizedResponse) : null, normalization_operations: parseError.normalization_operations || normalizationOperations, core_validation_result: { pass: false, stage: 'recovery_adapter', reason: parseError.message } })
        const error = rawResponseError(Object.assign(new Error(parseError.message), { code: 'MODEL_SCHEMA_FAILURE', call_id: traceBase.call_id }), content, response.transport_attempts)
        error.output_recovery = outputRecovery
        error.normalization_operations = parseError.normalization_operations || normalizationOperations
        throw error
      }
      if (strictSinglePass) {
        const validationResult = ['decideStage', 'reviewStage'].includes(operation) && decisionMode === 'competition_calibrated_v2'
          ? classifyCompetitionValidationFailure({ rawResponse: content, stagePhase, operation, error: parseError, attempt: constraintRevisionAttempt })
          : { status: HARD_FAIL, feedback: null, feedback_hash: null, reason: 'validation_loop_not_applicable' }
        await this.recordOutputTrace({
          ...traceBase,
          status: 'FAILED',
          raw_model_response: String(content),
          raw_response_sha256: sha256(String(content)),
          recovery_result: parseError.output_recovery_diagnostic || { status: 'RECOVERY_OR_ADAPTER_FAILED', reason: String(parseError.message || parseError) },
          adapter_result: normalizedResponse ? safeJson(normalizedResponse) : null,
          core_validation_result: { pass: false, code: parseError.code || 'MODEL_SCHEMA_FAILURE', reason: String(parseError.message || parseError), validation_result: validationResult },
          ...(stableIndustryOutput ? { industry_chain_output: industryChainOutputDiagnostics(content, outputRecovery, false, String(parseError.message || parseError)) } : {})
        })
        if (validationResult.status === REVISE_REQUIRED) {
          const nextHistory = [...validationLoopHistory, validationResult]
          return this.callForJson({
            agent,
            prompt: [...prompt, ...buildConstraintRevisionPrompt(validationResult.feedback)],
            outputInstruction,
            operation,
            stagePhase,
            decisionMode,
            adapterContext,
            constraintRevisionAttempt: constraintRevisionAttempt + 1,
            validationLoopHistory: nextHistory
          })
        }
        const error = new Error(`competition single-pass JSON gate rejected without repair: ${parseError.message}`)
        error.code = validationResult.status === PAUSED_SEAT_FAILURE ? PAUSED_SEAT_FAILURE : 'MODEL_SCHEMA_FAILURE'
        error.validation_result = validationResult
        throw rawResponseError(error, content, response.transport_attempts)
      }
      finalContent = await this.repairJsonResponse({ profileId, profile, operation, content, outputInstruction, parseError, stagePhase, decisionMode })
      value = parseJsonObject(finalContent)
      if (['decideStage', 'reviewStage'].includes(operation) && !['competition_calibrated', 'competition_calibrated_v2'].includes(decisionMode)) value = normalizeStageWireFormat(value, stagePhase)
    }
    if (['decideStage', 'reviewStage'].includes(operation) && !stageWireShapeValid(value, stagePhase, decisionMode)) {
      const error = new Error(`model stage response remains outside the ${stagePhase || 'unknown'} stage contract after bounded repair`)
      error.code = 'MODEL_SCHEMA_FAILURE'
      throw rawResponseError(error, finalContent, response.transport_attempts)
    }
    Object.defineProperty(value, 'model_provenance', { enumerable: false, configurable: true, value: {
      call_id: traceBase.call_id,
      operation_id: crypto.randomUUID(),
      profile_id: profileId,
      provider: profile.provider,
      model: resolveSetting(profile, 'model', this.environment),
      operation,
      prompt_sha256: sha256(canonicalJson(messages)),
      model_config_sha256: sha256(canonicalJson(redactConfig(profile))),
      response_sha256: sha256(finalContent),
      format_repaired: finalContent !== content,
      original_response_sha256: finalContent !== content ? sha256(content) : null,
      transport_attempts: Number(response.transport_attempts || 1),
      transport_retries: Math.max(0, Number(response.transport_attempts || 1) - 1),
      request_repairs: structuredClone(response.request_repairs || []),
      normalized_response_sha256: normalizedResponse ? sha256(normalizedResponse) : null,
      normalization_operations: structuredClone(normalizationOperations),
      protocol_validation: protocolValidation ? structuredClone(protocolValidation) : null
      ,output_recovery: outputRecovery ? structuredClone(outputRecovery) : null
      ,validation_loop: {
        attempt: constraintRevisionAttempt,
        status: 'PASS',
        feedback_hashes: validationLoopHistory.map(item => item.feedback_hash).filter(Boolean),
        history: structuredClone(validationLoopHistory)
      }
    } })
    Object.defineProperty(value, 'raw_model_response', { enumerable: false, configurable: true, value: content })
    Object.defineProperty(value, 'normalized_model_response', { enumerable: false, configurable: true, value: normalizedResponse })
    Object.defineProperty(value, 'normalization_operations', { enumerable: false, configurable: true, value: structuredClone(normalizationOperations) })
    Object.defineProperty(value, 'output_recovery', { enumerable: false, configurable: true, value: outputRecovery ? structuredClone(outputRecovery) : null })
    await this.recordOutputTrace({
      ...traceBase,
      status: enterpriseProtocol ? 'PARSED_AWAITING_CONTRACT_REVIEW' : 'COMPLETED',
      raw_model_response: String(content),
      raw_response_sha256: sha256(String(content)),
      recovery_result: outputRecovery ? structuredClone(outputRecovery) : null,
      adapter_result: normalizedResponse ? safeJson(normalizedResponse) : structuredClone(value),
      normalization_operations: structuredClone(normalizationOperations),
      core_validation_result: {
        ...(protocolValidation ? structuredClone(protocolValidation) : { pass: true, adapter_applied: false }),
        validation_loop: { attempt: constraintRevisionAttempt, status: 'PASS', feedback_hashes: validationLoopHistory.map(item => item.feedback_hash).filter(Boolean) }
      },
      ...(stableIndustryOutput ? { industry_chain_output: industryChainOutputDiagnostics(content, outputRecovery, true, '') } : {})
    })
    return value
  }

  async repairJsonResponse({ profileId, profile, operation, content, outputInstruction, parseError, stagePhase = null, decisionMode = 'business' }) {
    const stageInstruction = ['competition_calibrated', 'competition_calibrated_v2'].includes(decisionMode)
      ? 'Competition calibrated模式：必须严格保留当前指定的Competition字段，不得投影成旧四模块。'
      : stagePhase === 'decision_direction'
      ? '当前是经营方向阶段：顶层字段必须且只能是执行员、经营调整方向、逻辑、证据；禁止输出风控建议。'
      : stagePhase === 'risk_control_advice'
        ? '当前是风控建议阶段：顶层字段必须且只能是执行员、风控建议、逻辑、证据；禁止输出经营调整方向。'
        : null
    const repairMessages = [{
      role: 'system',
      content: [
        '你是严格的JSON格式修复器。只转换格式，不新增事实、不改变结论、不补充证据。',
        outputInstruction,
        stageInstruction,
        '只返回一个可由JSON.parse解析的对象。'
      ].filter(Boolean).join('\n')
    }, {
      role: 'user',
      content: JSON.stringify({
        task: '将original_response转换为满足上述协议的JSON对象',
        parse_error: String(parseError.message || '').slice(0, 300),
        original_response: String(content).slice(0, 24000)
      })
    }]
    const request = this.buildRequest(profile, repairMessages)
    const response = await this.scheduler.schedule(profileId, `${operation}:format_repair`, () => requestWithRetry({
      fetchImpl: this.fetch,
      url: request.url,
      init: request.init,
      timeoutMs: resolveNumber(profile.timeout_ms, DEFAULT_MODEL_TIMEOUT_MS),
      maxRetries: 1,
      baseDelayMs: resolveNumber(profile.retry_base_delay_ms, 1000),
      maxDelayMs: resolveNumber(profile.retry_max_delay_ms, 15000),
      jitterRatio: resolveNumber(profile.retry_jitter_ratio, 0.2)
    }))
    return extractResponseContent(profile.provider, response)
  }

  async recordHealth(method, value) {
    if (!this.healthMonitor || typeof this.healthMonitor[method] !== 'function') return
    try { await this.healthMonitor[method](value) } catch (error) {
      this.healthTrackingErrors.push({ method, error_sha256: sha256(error.message), at: new Date().toISOString() })
    }
  }

  async recordOutputTrace(value) {
    try {
      return await persistLlmOutputTrace(value, { rootDirectory: this.environment.LLM_OUTPUT_TRACE_ROOT })
    } catch (error) {
      this.healthTrackingErrors.push({ method: 'persistLlmOutputTrace', error_sha256: sha256(error.message), at: new Date().toISOString() })
      if (value.audit_required) throw Object.assign(new Error('模型输出审计写入失败，结果未放行'), { code: 'OUTPUT_AUDIT_WRITE_FAILED', cause: error })
      return null
    }
  }

  resolveProfile(agent) {
    const profileId = agent.model_profile || this.config.role_profiles?.[agent.agent_id] || this.config.default_profile
    if (!profileId) throw new Error(`no model profile configured for ${agent.agent_id}`)
    const configuredProfile = this.config.profiles[profileId]
    if (!configuredProfile) throw new Error(`unknown model profile ${profileId} for ${agent.agent_id}`)
    const profile = mergeProfile(this.config.defaults, configuredProfile)
    if (!['openai_compatible', 'anthropic'].includes(profile.provider)) {
      throw new Error(`unsupported model provider: ${profile.provider}`)
    }
    if (profile.provider === 'openai_compatible' && profile.api && profile.api !== 'openai-completions') {
      throw new Error(`unsupported OpenAI-compatible API mode: ${profile.api}`)
    }
    return { profileId, profile }
  }

  buildRequest(profile, messages, { forceText = false } = {}) {
    const baseUrl = String(resolveSetting(profile, 'base_url', this.environment) || '').replace(/\/$/, '')
    const model = resolveSetting(profile, 'model', this.environment)
    const apiKey = resolveSecret(profile, this.environment)
    if (!baseUrl) throw new Error('model profile base_url is required')
    if (!model) throw new Error('model profile model is required')
    if (!apiKey && profile.api_key_optional !== true) {
      throw new Error(`missing model API key in ${profile.api_key_env || 'configured environment variable'}`)
    }
    if (profile.provider === 'anthropic') {
      const { system, dialogue } = toAnthropicMessages(messages)
      return {
        url: `${baseUrl}/messages`,
        init: {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'anthropic-version': profile.anthropic_version || '2023-06-01',
            ...(apiKey ? { 'x-api-key': apiKey } : {})
          },
          body: JSON.stringify({
            model,
            system,
            messages: dialogue,
            temperature: resolveNumber(profile.temperature, 0.1),
            max_tokens: resolveNumber(profile.max_tokens, 7000),
            ...(profile.extra_body || {}),
            stream: false
          })
        }
      }
    }
    const effectiveFormat = profile.extra_body?.response_format || (forceText || profile.json_mode === false ? null : { type: 'json_object' })
    const wireMessages = effectiveFormat?.type === 'json_object'
      ? ensureJsonInputMessages(profile.extra_body?.messages || messages)
      : structuredClone(profile.extra_body?.messages || messages)
    return {
      url: `${baseUrl}/chat/completions`,
      init: {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(profile.send_user_agent === false ? {} : {
            'user-agent': profile.user_agent || 'RuloraRiskAgents/0.1 OpenAI-Compatible'
          }),
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
          ...(profile.extra_headers || {})
        },
        body: JSON.stringify({
          model,
          messages,
          ...(profile.temperature === undefined || profile.temperature === null
            ? {}
            : { temperature: resolveNumber(profile.temperature, 0.1) }),
          ...(profile.max_tokens ? { max_tokens: Number(profile.max_tokens) } : {}),
          ...(forceText || profile.json_mode === false ? {} : { response_format: { type: 'json_object' } }),
          ...(profile.extra_body || {}),
          messages: wireMessages,
          stream: false
        })
      }
    }
  }
}

function stageWireShapeValid(value, stagePhase = null, decisionMode = 'business') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const keys = Object.keys(value).sort()
  const direction = ['执行员', '经营调整方向', '逻辑', '证据'].sort()
  const advice = ['执行员', '风控建议', '逻辑', '证据'].sort()
  if (decisionMode === 'competition_calibrated') return competitionCoreDecisionValid(value)
  if (decisionMode === 'competition_calibrated_v2') {
    if (stagePhase === 'decision_direction') return [-1, 0, 1].includes(Number(value.action_candidate))
    if (stagePhase === 'risk_control_advice') return competitionRiskDecisionValid(value)
  }
  if (stagePhase === 'decision_direction') return JSON.stringify(keys) === JSON.stringify(direction)
  if (stagePhase === 'risk_control_advice') return JSON.stringify(keys) === JSON.stringify(advice)
  return JSON.stringify(keys) === JSON.stringify(direction) || JSON.stringify(keys) === JSON.stringify(advice)
}

function competitionCoreDecisionValid(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const action = Number(value.action ?? value.action_candidate)
  if (![-1, 0, 1].includes(action)) return false
  const risk = value.risk_control_advice
  if (!Array.isArray(risk) || risk.length > 4) return false
  const codes = risk.map(String)
  return new Set(codes).size === codes.length && codes.every(code => /^[1-9]$/.test(code))
}

function competitionRiskDecisionValid(value) {
  const risk = value?.risk_control_advice
  if (!Array.isArray(risk) || risk.length > 4) return false
  const codes = risk.map(String)
  return new Set(codes).size === codes.length && codes.every(code => /^[1-9]$/.test(code))
}

function oldCompetitionWireShapeValid(value, stagePhase) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const keys = Object.keys(value).sort()
  const calibratedJoint = ['execution_agent', 'action_candidate', 'action_confidence', 'action_reason', 'transmission_evidence', 'threshold_evidence', 'counter_evidence', 'set_confidence', 'label_assessments', '执行员', '经营调整方向', '风控建议', '逻辑', '证据'].sort()
  const calibratedDirection = ['execution_agent', 'action_candidate', 'action_confidence', 'action_reason', 'transmission_evidence', 'threshold_evidence', 'counter_evidence', '执行员', '经营调整方向', '逻辑', '证据'].sort()
  const calibratedAdvice = ['execution_agent', 'set_confidence', 'label_assessments', '执行员', '风控建议', '逻辑', '证据'].sort()
  if (stagePhase === 'competition_joint_decision') return JSON.stringify(keys) === JSON.stringify(calibratedJoint)
  if (stagePhase === 'decision_direction') return JSON.stringify(keys) === JSON.stringify(calibratedDirection)
  if (stagePhase === 'risk_control_advice') return JSON.stringify(keys) === JSON.stringify(calibratedAdvice)
  return false
}

function stageOutputInstruction(stagePhase, decisionMode = 'business', agent = null) {
  if (decisionMode === 'competition_calibrated_v2' && agent?.agent_id === 'industry_chain_analyst' && stagePhase === 'decision_direction') return INDUSTRY_CHAIN_ACTION_OUTPUT_INSTRUCTION
  if (decisionMode === 'competition_calibrated_v2' && agent?.agent_id === 'industry_chain_analyst' && stagePhase === 'risk_control_advice') return INDUSTRY_CHAIN_RISK_OUTPUT_INSTRUCTION
  if (decisionMode === 'competition_calibrated' && stagePhase === 'competition_joint_decision') return COMPETITION_JOINT_OUTPUT_INSTRUCTION
  if (decisionMode === 'competition_calibrated' && stagePhase === 'decision_direction') return COMPETITION_DIRECTION_OUTPUT_INSTRUCTION
  if (decisionMode === 'competition_calibrated' && stagePhase === 'risk_control_advice') return COMPETITION_ADVICE_OUTPUT_INSTRUCTION
  if (decisionMode === 'competition_calibrated_v2' && stagePhase === 'decision_direction') return COMPETITION_DIRECTION_OUTPUT_INSTRUCTION
  if (decisionMode === 'competition_calibrated_v2' && stagePhase === 'risk_control_advice') return COMPETITION_ADVICE_OUTPUT_INSTRUCTION
  if (stagePhase === 'decision_direction') return CREDIT_DIRECTION_OUTPUT_INSTRUCTION
  if (stagePhase === 'risk_control_advice') return RISK_CONTROL_ADVICE_OUTPUT_INSTRUCTION
  throw new Error(`unsupported decision stage: ${stagePhase || '(missing)'}`)
}

function normalizeStageWireFormat(value, stagePhase) {
  if (!['decision_direction', 'risk_control_advice'].includes(stagePhase)) return value
  const answerKey = stagePhase === 'decision_direction' ? '经营调整方向' : '风控建议'
  const legacyAnswer = stagePhase === 'decision_direction' ? value?.result_candidate : value?.recommended_advice
  const legacyValid = stagePhase === 'decision_direction'
    ? ['risk_up', 'risk_flat', 'risk_down'].includes(legacyAnswer)
    : Array.isArray(legacyAnswer) && legacyAnswer.length >= 1 && legacyAnswer.length <= 3 && legacyAnswer.every(code => /^[1-9]$/.test(String(code)))
  if (typeof value?.agent_id === 'string' && legacyValid && Array.isArray(value?.factors) && value.factors.length) {
    const logic = value.factors.map(factor => ({
      claim: String(factor.name || factor.id || 'factor'),
      mechanism: String(factor.transmission_mechanism || factor.invalidation_condition || '按公开证据所示传导'),
      evidence_refs: [...new Set((factor.evidence_refs || []).map(String))]
    }))
    return canonicalStageEnvelope({
      executor: value.agent_id,
      answerKey,
      answer: stagePhase === 'risk_control_advice' ? legacyAnswer.map(String) : legacyAnswer,
      logic,
      reportedEvidence: value.evidence_refs,
      stagePhase,
      normalizationPath: 'legacy_opinion_projection'
    })
  }
  const aliases = stagePhase === 'decision_direction'
    ? ['经营调整方向', '当前阶段答案', '当前阶段最终答案', 'decision_direction', 'result', 'answer']
    : ['风控建议', '当前阶段答案', '当前阶段最终答案', 'risk_control_advice', 'advice', 'answer']
  const queue = [{ value, depth: 0 }]
  while (queue.length) {
    const current = queue.shift()
    const node = current.value
    if (!node || typeof node !== 'object' || Array.isArray(node)) continue
    const answerAlias = aliases.find(key => Object.hasOwn(node, key))
    const answer = answerAlias ? node[answerAlias] : undefined
    const validAnswer = stagePhase === 'decision_direction'
      ? ['risk_up', 'risk_flat', 'risk_down'].includes(answer)
      : Array.isArray(answer) && answer.length >= 1 && answer.length <= 3 && answer.every(code => /^[1-9]$/.test(String(code)))
    const executor = node['执行员'] ?? node.executor ?? node.agent_id
    const logic = node['逻辑'] ?? node.logic ?? node.reasoning ?? node.rationale
    const evidence = node['证据'] ?? node.evidence ?? node.evidence_refs
    if (typeof executor === 'string' && Array.isArray(logic) && validAnswer) {
      return canonicalStageEnvelope({
        executor,
        answerKey,
        answer: stagePhase === 'risk_control_advice' ? answer.map(String) : answer,
        logic,
        reportedEvidence: evidence,
        stagePhase,
        normalizationPath: current.depth === 0 ? 'canonical_wire' : 'wrapped_wire_projection'
      })
    }
    if (current.depth < 3) {
      for (const child of Object.values(node)) {
        if (child && typeof child === 'object' && !Array.isArray(child)) queue.push({ value: child, depth: current.depth + 1 })
      }
    }
  }
  return value
}

function canonicalStageEnvelope({ executor, answerKey, answer, logic, reportedEvidence, stagePhase, normalizationPath }) {
  const reported = Array.isArray(reportedEvidence) ? reportedEvidence.map(String) : []
  const derived = [...new Set(logic.flatMap(item => Array.isArray(item?.evidence_refs) ? item.evidence_refs.map(String) : []))].sort()
  const envelope = {
    '执行员': executor,
    [answerKey]: answer,
    '逻辑': logic,
    '证据': derived
  }
  Object.defineProperty(envelope, 'stage_evidence_derivation', {
    enumerable: false,
    configurable: true,
    value: {
      contract_version: '1.0.0',
      stage_phase: stagePhase,
      field: '证据',
      rule: 'sorted_unique_union_of_logic_evidence_refs',
      normalization_path: normalizationPath,
      model_reported_field_present: Array.isArray(reportedEvidence),
      model_reported_count: reported.length,
      derived_count: derived.length,
      model_reported_sha256: sha256(canonicalJson(reported)),
      derived_sha256: sha256(canonicalJson(derived)),
      changed: canonicalJson(reported) !== canonicalJson(derived)
    }
  })
  return envelope
}

function mergeProfile(defaults, profile) {
  return {
    ...(defaults || {}),
    ...(profile || {}),
    extra_headers: { ...(defaults?.extra_headers || {}), ...(profile?.extra_headers || {}) },
    extra_body: { ...(defaults?.extra_body || {}), ...(profile?.extra_body || {}) }
  }
}

function redactConfig(value) {
  if (Array.isArray(value)) return value.map(redactConfig)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, /api.?key|secret|token/i.test(key) ? '[REDACTED]' : redactConfig(item)]))
}

async function createMultiModelProvider(configPath, options = {}) {
  const resolved = path.resolve(configPath)
  const config = JSON.parse(await fs.readFile(resolved, 'utf8'))
  let healthMonitor = options.healthMonitor
  let execution = {}
  if (healthMonitor === undefined) {
    const root = path.resolve(path.dirname(resolved), '..')
    try { execution = JSON.parse(await fs.readFile(path.join(root, 'config', 'execution.json'), 'utf8')) } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    healthMonitor = new ProviderHealthMonitor({ root, config: execution.provider_connectivity })
  }
  if (!Object.keys(execution).length) {
    const root = path.resolve(path.dirname(resolved), '..')
    try { execution = JSON.parse(await fs.readFile(path.join(root, 'config', 'execution.json'), 'utf8')) } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
  const schedulerConfig = execution.global_model_scheduler || {}
  const scheduler = options.scheduler || globalProviderScheduler({
    maximumConcurrent: schedulerConfig.maximum_concurrent,
    maximumConcurrentPerProfile: schedulerConfig.maximum_concurrent_per_profile,
    circuitFailureThreshold: schedulerConfig.circuit_failure_threshold,
    circuitCooldownMs: schedulerConfig.circuit_cooldown_ms
  })
  return new MultiModelProvider({ config, configPath: resolved, ...options, healthMonitor, scheduler })
}

const JSON_INPUT_INSTRUCTION = 'Return one valid json object following the specified output schema. Do not include markdown or explanatory text.'

function ensureJsonInputMessages(messages, reinforce = false) {
  const result = structuredClone(messages || [])
  if (!reinforce) {
    if (!result.some(message => message.role === 'user' && /json/i.test(typeof message.content === 'string' ? message.content : JSON.stringify(message.content)))) result.push({ role: 'user', content: JSON_INPUT_INSTRUCTION })
    return result
  }
  if (!result.some(message => message.role === 'user')) result.push({ role: 'user', content: JSON_INPUT_INSTRUCTION })
  const targets = result.filter(message => ['user', 'system', 'developer'].includes(message.role))
  for (const message of targets) {
    if (typeof message.content === 'string') {
      if (!message.content.includes(JSON_INPUT_INSTRUCTION)) message.content = `${JSON_INPUT_INSTRUCTION}\n\n${message.content}`
    } else if (Array.isArray(message.content)) {
      if (!message.content.some(part => part.type === 'text' && part.text?.includes(JSON_INPUT_INSTRUCTION))) message.content.unshift({ type: 'text', text: JSON_INPUT_INSTRUCTION })
    }
  }
  return result
}

function jsonModeRepairBody(init, status, responseText) {
  if (status !== 400 || !/messages?[\s\S]*must contain[\s\S]*json[\s\S]*json_object/i.test(String(responseText))) return null
  let body
  try { body = JSON.parse(init.body) } catch { return null }
  if (body.response_format?.type !== 'json_object' || !Array.isArray(body.messages)) return null
  body.messages = ensureJsonInputMessages(body.messages, true)
  return JSON.stringify(body)
}

function appendInstruction(messages, instruction) {
  const cloned = structuredClone(messages || [])
  const system = cloned.find(message => message.role === 'system')
  if (system) system.content = `${system.content}\n\n${instruction}`
  else cloned.unshift({ role: 'system', content: instruction })
  return cloned
}

function resolveSetting(profile, key, environment) {
  const envName = profile[`${key}_env`]
  return (envName && environment[envName]) || profile[key]
}

function resolveSecret(profile, environment) {
  if (!profile.api_key_env) return profile.api_key || ''
  return environment[profile.api_key_env] || ''
}

function resolveNumber(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

function toAnthropicMessages(messages) {
  const system = messages.filter(message => message.role === 'system').map(message => String(message.content)).join('\n\n')
  const dialogue = messages.filter(message => message.role !== 'system').map(message => ({
    role: message.role === 'assistant' ? 'assistant' : 'user',
    content: String(message.content)
  }))
  return { system, dialogue }
}

function streamResponseError(detail) {
  const code = String(detail?.code || detail?.type || '')
  const status = Number(detail?.status || detail?.status_code) || (/auth|api_key/.test(code) ? 401 : /permission/.test(code) ? 403 : /rate|capacity/.test(code) ? 429 : 502)
  return httpTransportError(status, '模型流返回错误事件', 1)
}

function extractContent(provider, body) {
  if (body?.error) throw streamResponseError(body.error)
  if (provider === 'anthropic') {
    const content = (body.content || []).filter(item => item.type === 'text').map(item => item.text).join('\n')
    if (!content) throw Object.assign(new Error('模型接口返回了空文本，未取得可用于分析的结果。'), { code: 'MODEL_API_EMPTY_RESPONSE' })
    return content
  }
  const message = body.choices?.[0]?.message || {}
  const content = message.content
  if (Array.isArray(content)) {
    const text = content.map(item => typeof item === 'string' ? item : item.text || '').join('\n')
    if (text) return text
  }
  if (typeof content !== 'string' || !content.trim()) {
    throw Object.assign(new Error('模型接口返回了空文本，未取得可用于分析的结果。'), { code: 'MODEL_API_EMPTY_RESPONSE' })
  }
  return content
}

async function extractResponseContent(provider, response) {
  if (typeof response.text !== 'function' && typeof response.json === 'function') return extractContent(provider, await response.json())
  const raw = await response.text()
  try { return extractContent(provider, JSON.parse(raw)) } catch (error) {
    if (!/^\s*(?:event:|data:)/m.test(raw)) throw error
  }
  let content = ''
  let completed = null
  for (const line of raw.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue
    const payload = line.slice(5).trim()
    if (!payload || payload === '[DONE]') continue
    let event
    try { event = JSON.parse(payload) } catch { continue }
    if (event.error) throw streamResponseError(event.error)
    if (event.choices?.[0]?.message) completed = event
    const delta = event.choices?.[0]?.delta || {}
    if (typeof delta.content === 'string') content += delta.content
    if (provider === 'anthropic' && event.type === 'content_block_delta' && typeof event.delta?.text === 'string') content += event.delta.text
  }
  if (completed) return extractContent(provider, completed)
  if (content.trim()) return content
  throw Object.assign(new Error('模型接口返回了空文本，未取得可用于分析的结果。'), { code: 'MODEL_API_EMPTY_RESPONSE' })
}

function parseJsonObject(content) {
  const trimmed = String(content).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  try {
    const parsed = JSON.parse(trimmed)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('response JSON is not an object')
    return parsed
  } catch (firstError) {
    const start = trimmed.indexOf('{')
    const end = trimmed.lastIndexOf('}')
    if (start < 0 || end <= start) throw new Error(`model did not return valid JSON: ${firstError.message}`)
    const parsed = JSON.parse(trimmed.slice(start, end + 1))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('response JSON is not an object')
    return parsed
  }
}

async function requestWithRetry({
  fetchImpl,
  url,
  init,
  timeoutMs,
  maxRetries,
  baseDelayMs = 1000,
  maxDelayMs = 15000,
  jitterRatio = 0.2,
  random = Math.random,
  delayImpl = delay,
  retryDelaysMs = null,
  onRequestRepair = async () => {},
  maxTimeoutRetries = Infinity,
  timeoutRetryMs = null
}) {
  let lastError
  let requestInit = init
  let requestCount = 0
  const repairs = []
  const transportDiagnostics = []
  let timeoutFailures=0
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const controller = new AbortController()
    requestCount += 1
    let timeout
    const attemptTimeoutMs = timeoutFailures > 0 && Number.isFinite(timeoutRetryMs) && timeoutRetryMs > timeoutMs ? timeoutRetryMs : timeoutMs
    const deadline = new Promise((_, reject) => {
      timeout = setTimeout(() => {
        controller.abort()
        reject(Object.assign(new Error('model response deadline exceeded'), { name: 'AbortError' }))
      }, attemptTimeoutMs)
    })
    let response
    const startedAt = Date.now()
    const diagnostic = { attempt: requestCount, timeout_ms: attemptTimeoutMs, phase: 'waiting_headers' }
    transportDiagnostics.push(diagnostic)
    try {
      response = await Promise.race([deadline, (async () => {
        const received = await fetchImpl(url, { ...requestInit, signal: controller.signal })
        Object.assign(diagnostic, { phase: 'reading_body', headers_ms: Date.now() - startedAt, http_status: received.status, request_id: received.headers?.get?.('x-request-id') || null })
        // Keep the same deadline through body download, including SSE and error bodies.
        if (typeof received.text === 'function') {
          const raw = await received.text()
          Object.defineProperties(received, {
            text: { configurable: true, value: async () => raw },
            json: { configurable: true, value: async () => JSON.parse(raw) }
          })
        } else if (typeof received.json === 'function') {
          const body = await received.json()
          Object.defineProperty(received, 'json', { configurable: true, value: async () => body })
        }
        Object.assign(diagnostic, { phase: 'complete', elapsed_ms: Date.now() - startedAt })
        return received
      })()])
    } catch (error) {
      diagnostic.elapsed_ms = Date.now() - startedAt
      diagnostic.network_cause_code = error?.cause?.code || error?.code || null
      const transport = networkTransportError(error, requestCount)
      transport.transport_diagnostics = structuredClone(transportDiagnostics)
      transport.request_repairs = structuredClone(repairs)
      lastError = transport
      if(transport.code==='MODEL_API_TIMEOUT' && ++timeoutFailures>maxTimeoutRetries)throw transport
      if (!transport.retryable || attempt === maxRetries) throw transport
    } finally {
      clearTimeout(timeout)
    }
    if (response) {
      if (response.ok) {
        Object.defineProperty(response, 'transport_diagnostics', { value: structuredClone(transportDiagnostics) })
        Object.defineProperty(response, 'transport_attempts', { enumerable: false, configurable: true, value: requestCount })
        Object.defineProperty(response, 'request_repairs', { value: structuredClone(repairs) })
        return response
      }
      const responseText = await response.text()
      const repairedBody = repairs.length === 0 ? jsonModeRepairBody(requestInit, response.status, responseText) : null
      if (repairedBody !== null) {
        const repair = { attempt: 1, reason: 'JSON_MODE_INPUT_REQUIRED', http_status: 400, failed_transport_attempt: requestCount, original_body_sha256: sha256(requestInit.body), repaired_body_sha256: sha256(repairedBody) }
        repairs.push(repair)
        await onRequestRepair(repair)
        requestInit = { ...requestInit, body: repairedBody }
        attempt -= 1 // One format correction, separate from the finite transport retry budget.
        continue
      }
      const transport = httpTransportError(response.status, responseText, requestCount)
      transport.transport_diagnostics = structuredClone(transportDiagnostics)
      transport.request_repairs = structuredClone(repairs)
      lastError = transport
      if (!transport.retryable || attempt === maxRetries) throw transport
      await delayImpl(retryDelay({ response, attempt, baseDelayMs, maxDelayMs, jitterRatio, random, retryDelaysMs }))
      continue
    }
    await delayImpl(retryDelay({ response: null, attempt, baseDelayMs, maxDelayMs, jitterRatio, random, retryDelaysMs }))
  }
  throw lastError
}

function isTransientNetworkError(error) {
  return /fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN/i.test(String(error?.message || ''))
}

function networkTransportError(error, attempts) {
  const causeCode = error?.cause?.code || error?.code || null
  const timedOut = error?.name === 'AbortError' || ['UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_CONNECT_TIMEOUT', 'ETIMEDOUT'].includes(causeCode)
  const retryable = timedOut || isTransientNetworkError(error)
  const wrapped = new Error(timedOut ? 'model API request timed out' : `model API network failure: ${String(error?.message || 'unknown network error').slice(0, 400)}`)
  wrapped.code = timedOut ? 'MODEL_API_TIMEOUT' : 'MODEL_API_NETWORK_FAILURE'
  wrapped.retryable = retryable
  wrapped.connectivity_category = timedOut ? 'network_timeout' : retryable ? 'network' : 'request_configuration'
  wrapped.connection_attempts = attempts
  wrapped.network_cause_code = causeCode
  wrapped.is_model_transport_failure = true
  return wrapped
}

function httpTransportError(status, responseText, attempts) {
  const retryableStatuses = new Set([408, 409, 429, 500, 502, 503, 504])
  const error = new Error(`model API ${status}: ${String(responseText).slice(0, 800)}`)
  error.code = status === 401 ? 'MODEL_API_AUTHENTICATION_FAILED'
    : status === 403 ? 'MODEL_API_ACCESS_DENIED'
      : status === 404 ? 'MODEL_API_NOT_FOUND'
        : status === 429 ? 'MODEL_API_CAPACITY_OR_RATE_LIMIT'
          : status >= 500 ? 'MODEL_API_UPSTREAM_FAILURE'
            : 'MODEL_API_REQUEST_REJECTED'
  error.http_status = status
  error.retryable = retryableStatuses.has(status)
  error.connectivity_category = [401, 403, 404].includes(status) ? 'access_configuration'
    : status === 429 ? 'upstream_capacity'
      : retryableStatuses.has(status) ? 'upstream_transport'
        : 'request_configuration'
  error.connection_attempts = attempts
  error.is_model_transport_failure = true
  return error
}

function retryDelay({ response, attempt, baseDelayMs, maxDelayMs, jitterRatio, random, retryDelaysMs = null }) {
  const retryAfter = parseRetryAfter(response?.headers?.get?.('retry-after'))
  const configured = Array.isArray(retryDelaysMs) ? Number(retryDelaysMs[attempt]) : NaN
  if (Number.isFinite(configured) && configured >= 0) return Math.max(retryAfter, configured)
  const exponential = Math.min(Number(baseDelayMs) * (2 ** attempt), Number(maxDelayMs))
  const base = Math.max(retryAfter, exponential)
  const jitter = base * Math.max(0, Number(jitterRatio)) * Number(random())
  return Math.round(Math.min(base + jitter, Number(maxDelayMs)))
}

function rawResponseError(error, content, transportAttempts = 1) {
  error.code ||= 'MODEL_SCHEMA_FAILURE'
  error.raw_model_response = String(content)
  error.raw_response_sha256 = sha256(String(content))
  error.transport_attempts = Number(transportAttempts || 1)
  return error
}

function safeJson(value) {
  if (value && typeof value === 'object') return structuredClone(value)
  try { return JSON.parse(String(value)) } catch { return String(value) }
}

function parseRetryAfter(value) {
  if (!value) return 0
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000
  const timestamp = Date.parse(value)
  return Number.isNaN(timestamp) ? 0 : Math.max(0, timestamp - Date.now())
}

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

function safeErrorBody(body) {
  return JSON.stringify(body, (key, value) => /key|token|secret/i.test(key) ? '[REDACTED]' : value).slice(0, 800)
}

function industryChainOutputDiagnostics(content, recovery, coreDecisionExtracted, failureReason) {
  const source = String(content || '')
  const analysisMarker = source.search(/##\s*INDUSTRY_CHAIN_ANALYSIS\b/i)
  const hasDecisionBlock = /##\s*FINAL_DECISION\b/i.test(source)
  const looksJson = /^\s*\{/.test(source)
  return {
    seat: 'industry_chain_analyst',
    core_decision_extracted: Boolean(coreDecisionExtracted),
    analysis_length: analysisMarker < 0 ? 0 : source.slice(analysisMarker).length,
    output_format: looksJson ? 'json' : hasDecisionBlock ? 'mixed' : 'markdown',
    recovery_used: Boolean(recovery?.repair_applied),
    failure_reason: failureReason || ''
  }
}

module.exports = {
  MultiModelProvider,
  createMultiModelProvider,
  extractContent,
  extractResponseContent,
  mergeProfile,
  parseJsonObject,
  requestWithRetry
}
