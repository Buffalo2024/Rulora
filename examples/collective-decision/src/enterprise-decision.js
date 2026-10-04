const { createBinding, encodePrompt } = require('./enterprise-reference-binding')
const promptBindings = new WeakMap()
const deliberation = require('./enterprise-deliberation')
const { REVIEW_POLICY } = require('./decision-policy')
const { buildEvidenceBrief, recallSnapshotText } = require('./evidence-brief')
const { cleanText, cleanItems } = require('./decision-copy')
const crypto = require('node:crypto')
const Ajv2020 = require('ajv/dist/2020')
const validateReportSchema = new Ajv2020({ allErrors: true }).compile(require('../schemas/enterprise-report.schema.json'))
const fs = require('node:fs/promises')
const path = require('node:path')
const { buildEnterpriseDecisionGraph, buildEnterpriseSeatLoopGraph } = require('./cluster-graph')
const { loadProvider } = require('./provider-loader')
const { loadRulora, projectRoot } = require('./rulora-loader')
const { enterpriseDecisionScenario } = require('./scenario')
const { FileRepository } = require('./file-repository')
const { ModelCallCheckpointStore } = require('./model-call-checkpoint-store')
const { validateEvidenceRegistry, verifyEvidenceSnapshots } = require('./evidence-registry')
const { UserSourceConfigStore } = require('./user-source-config')
const { canonicalJson, sha256, writeJsonAtomic } = require('./utils')

const { MODE, LABELS, ACTIONS, ACTION_LABELS, ACTION_OPTIONS_VERSION, isActualAction, isNoNewMeasures, fixedQuestion, candidateKey, candidateSignature, validateActions, stageInstruction } = require('./enterprise-action-contract')
const SEATS = Object.freeze({
  direction: [
    ['demand_growth', '需求与增长席', '需求、订单、客户变化与增长持续性'],
    ['supply_competition', '供给与竞争席', '产能、替代、竞争、上下游约束'],
    ['enterprise_operations', '企业经营席', '有证据的经营质量、能力和财务承受情况；内部信息未知不可补造'],
    ['external_environment', '外部环境席', '政策、宏观、技术变化与外部事件'],
    ['direction_countercheck', '反向核查席', '反证、替代解释、关键假设与证据冲突；不预设反对']
  ],
  condition: [
    ['technology_fit', '技术发展匹配席', '技术成熟度、性能、可靠性、配套与实际应用证据'],
    ['revenue_cost', '收入与成本趋势席', '同一时间、产品和规模口径下比较收入与成本趋势；客户增加不等于涨价'],
    ['chain_risk', '产业链风险席', '上下游集中度、供应依赖、替代能力及风险传导'],
    ['external_constraints', '外部约束席', '政策准入、标准认证、知识产权及禁止条件'],
    ['condition_countercheck', '反向核查席', '反证、替代解释、证据冲突与推翻假设']
  ]
})

function clarifyQuestion(input) {
  const question = String(input?.question || '').trim()
  const subject = String(input?.subject || '').trim()
  const matter = String(input?.matter || '').trim()
  const timeRange = String(input?.time_range || '').trim()
  const baseline = String(input?.baseline || '').trim()
  const missing = []
  if (!question) missing.push('决策问题')
  if (!subject) missing.push('分析对象')
  return { valid: missing.length === 0, missing, question, subject, matter: matter || null, time_range: timeRange || null, baseline: baseline || null }
}

function sourceIdentity(item) {
  const publisher = String(item.original_publisher || item.publisher || '').trim().toLowerCase().replace(/\s+/g, '')
  const original = String(item.original_url || item.source_url || '').split('#')[0].toLowerCase()
  const title = String(item.title || '').trim().toLowerCase().replace(/\s+/g, '')
  const publication = String(item.published_at || '')
  const work = String(item.original_content_sha256 || (title ? `${title}|${publication}` : item.content_sha256 || original))
  return { publisher, original, work }
}

function independentChannels(evidence, refs) {
  const selected = evidence.filter(item => refs.includes(item.id))
  const seen = new Set()
  const works = new Set()
  const publishers = new Set()
  for (const item of selected) {
    const identity = sourceIdentity(item)
    if (!identity.publisher || !identity.original || !identity.work) continue
    seen.add(identity.original)
    works.add(identity.work)
    publishers.add(identity.publisher)
  }
  return { count: Math.min(seen.size, works.size, publishers.size), publishers: [...publishers], original_count: seen.size, work_count: works.size }
}

function validateCandidate(value, stage, evidenceIds, frozenDirection = null) {
  const errors = []
  const key = candidateKey(stage)
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ['候选必须是对象']
  const allowed = new Set([key, 'reason', 'evidence_refs', 'gaps', 'assumptions', 'factors', 'seat_summary', ...(stage === 'condition' ? ['direction_version', 'actions', 'label_assessments', 'combination_reason', 'no_action_basis'] : [])])
  for (const field of Object.keys(value)) if (!allowed.has(field)) errors.push(`候选含有未授权字段：${field}`)
  if (stage === 'direction' && (!Object.hasOwn(value, key) || !(value[key] === null || [-1, 0, 1].includes(value[key])))) errors.push(`${key}必须是-1、0、1或null`)
  if (stage === 'condition') errors.push(...validateActions(value, evidenceIds, frozenDirection))
  if (typeof value.reason !== 'string' || !value.reason.trim()) errors.push('理由不能为空')
  if (!Array.isArray(value.evidence_refs) || value.evidence_refs.some(ref => !evidenceIds.has(ref))) errors.push('证据引用未登记或未判定相关')
  const hasAdvice = value[key] !== null && !(stage === 'condition' && Array.isArray(value[key]) && value[key].includes(10))
  if (hasAdvice && !value.evidence_refs?.length) errors.push('有结论必须关联证据')
  if (stage === 'condition' && value.direction_version !== frozenDirection?.version) errors.push(`第二层未绑定冻结方向版本：程序绑定的direction_version与冻结版本不一致`)
  if (!Array.isArray(value.gaps) || value.gaps.some(item => typeof item !== 'string')) errors.push('缺口必须是字符串数组')
  if (value.assumptions !== undefined && (!Array.isArray(value.assumptions) || value.assumptions.some(item => typeof item !== 'string'))) errors.push('假设必须是字符串数组')
  if (!Array.isArray(value.factors)) errors.push('因子必须是结构化数组')
  for (const factor of Array.isArray(value.factors) ? value.factors : []) {
    if (!factor || typeof factor !== 'object' || Array.isArray(factor)) { errors.push('因子必须为对象'); continue }
    if (!factor || typeof factor.name !== 'string' || !factor.name.trim() || typeof factor.mechanism !== 'string' || !factor.mechanism.trim() || !['positive', 'neutral', 'negative', 'mixed', 'unknown'].includes(factor.effect)) errors.push('因子缺少名称、机制或有效方向')
    if (!Array.isArray(factor.evidence_refs) || factor.evidence_refs.some(ref => !evidenceIds.has(ref))) errors.push('因子引用未登记或未判定相关')
    if (factor.counter_evidence_refs !== undefined && (!Array.isArray(factor.counter_evidence_refs) || factor.counter_evidence_refs.some(ref => !evidenceIds.has(ref)))) errors.push('因子反证引用无效')
  }
  if (hasAdvice && !value.factors?.length) errors.push('有结论必须列出结构化因子')
  if (value[key] === null && !value.gaps?.length) errors.push('暂无法判断必须说明缺口')
  return [...new Set(errors)]
}

// Diagnose exact references; never infer the intended document or rewrite a decision.
function evidenceReferenceDiagnostic(value, allowedIds) {
  const invalid = [], outside = []
  const top = new Set(Array.isArray(value?.evidence_refs) ? value.evidence_refs : [])
  function inspect(refs, field, mustBeInCandidate = false) {
    if (!Array.isArray(refs)) return
    refs.forEach((ref, index) => {
      const item = { path: `${field}[${index}]`, value: ref }
      if (!allowedIds.has(ref)) invalid.push(item)
      else if (mustBeInCandidate && !top.has(ref)) outside.push(item)
    })
  }
  inspect(value?.evidence_refs, 'evidence_refs')
  for(const [i,row] of (Array.isArray(value?.no_action_basis?.existing_arrangements)?value.no_action_basis.existing_arrangements:[]).entries())inspect(row?.evidence_refs,`no_action_basis.existing_arrangements[${i}].evidence_refs`,true)
  for (const field of ['factors','actions','label_assessments']) {
    if (!Array.isArray(value?.[field])) continue
    value[field].forEach((item, index) => {
      inspect(item?.evidence_refs, `${field}[${index}].evidence_refs`, field !== 'factors')
      if (field === 'factors' || field === 'label_assessments') inspect(item?.counter_evidence_refs, `${field}[${index}].counter_evidence_refs`)
    })
  }
  return { invalid_refs: invalid, outside_candidate_refs: outside, allowed_evidence_ids: [...allowedIds] }
}

function validateEvidenceScreen(value, evidenceIds) {
  const errors = []
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ['证据筛选结果必须是对象']
  if (Object.keys(value).some(key => !['relevant_evidence_ids', 'reasons_by_id', 'gaps', 'analysis_limitations'].includes(key))) errors.push('证据筛选含未授权字段')
  if (!Array.isArray(value.relevant_evidence_ids) || value.relevant_evidence_ids.some(id => !evidenceIds.has(id)) || new Set(value.relevant_evidence_ids).size !== value.relevant_evidence_ids.length) errors.push('相关证据ID无效或重复')
  if (!value.reasons_by_id || typeof value.reasons_by_id !== 'object' || Array.isArray(value.reasons_by_id)) errors.push('缺少逐条相关性说明')
  else for (const id of Array.isArray(value.relevant_evidence_ids) ? value.relevant_evidence_ids : []) if (typeof value.reasons_by_id[id] !== 'string' || !value.reasons_by_id[id].trim()) errors.push(`证据${id}缺少相关性说明`)
  if (!Array.isArray(value.gaps) || value.gaps.some(item => typeof item !== 'string')) errors.push('证据缺口必须是字符串数组')
  if (value.analysis_limitations !== undefined && (!Array.isArray(value.analysis_limitations) || value.analysis_limitations.some(item => typeof item !== 'string'))) errors.push('分析限制必须是字符串数组')
  return [...new Set(errors)]
}

function freezeStage(stage, candidates, evidence, prior = null, sourceGate = { satisfied: true }) {
  const key = candidateKey(stage)
  const values = candidates.map(item => item[key])
  const signatures = new Set(candidates.map(value => candidateSignature(value, stage)))
  const refs = [...new Set(candidates.flatMap(item => item.evidence_refs || []))]
  const code = signatures.size === 1 && sourceGate.satisfied === true && (stage !== 'condition' || prior?.code !== null) ? values[0] : null
  const gaps = [...new Set(candidates.flatMap(item => item.gaps || []))]
  if (signatures.size > 1) gaps.push('五席候选尚有差异，待语义复核判断')
  if (sourceGate.satisfied !== true) gaps.push('整份相关证据集缺少两个独立来源')
  if (stage === 'condition' && prior?.code === null) gaps.push('第一层方向未决')
  const frozen = { contract_version: MODE, action_options_version: ACTION_OPTIONS_VERSION, ...(stage==='condition' && isNoNewMeasures(code)?{no_action_basis:structuredClone(candidates[0].no_action_basis)}:{}), time_range: prior?.time_range || '未来12个月', actions: stage === 'condition' && code !== null ? structuredClone(candidates[0]?.actions || []) : [], stage, code: code ?? null, reason: code === null ? cleanItems(gaps).join('；') || '当前无法形成结论' : candidates[0].reason, evidence_refs: refs, gaps, assumptions: [...new Set(candidates.flatMap(item => item.assumptions || []))], candidates, evidence_version: sha256(canonicalJson(evidence)), prior_direction_version: prior?.version || null, frozen_at: new Date().toISOString() }
  frozen.version = sha256(canonicalJson({ stage, code: frozen.code, candidates: candidates.map(c => ({seat_id:c.seat_id, ...deliberation.candidatePayload(c,stage)})), evidence_version: frozen.evidence_version, prior_direction_version: frozen.prior_direction_version, source_gate: sourceGate }))
  return frozen
}

function meaningfulProgress(before, after, stage) {
  const key = candidateKey(stage)
  return before.some((item, index) => {
    const next = after[index]
    if (candidateSignature(item, stage) !== candidateSignature(next, stage)) return true
    if (next.evidence_refs.some(id => !item.evidence_refs.includes(id))) return true
    if (item.gaps.some(gap => !next.gaps.includes(gap))) return true
    if ((next.assumptions || []).some(assumption => !(item.assumptions || []).includes(assumption))) return true
    return false
  })
}

function modelAgent(row) {
  const [id, label, lens] = row
  return { agent_id: id, label, method_family: `enterprise_${id}`, model_profile: id.includes('countercheck') ? 'red_team_reasoner' : ['demand_growth', 'chain_risk'].includes(id) ? 'chain_reasoner' : 'factor_reasoner', lens }
}

function budget(config) {
  const used = { model_operations: 0, searches: 0 }
  return {
    used,
    consume(kind) {
      if (kind === 'model_operations' && ++used.model_operations > config.max_model_operations) throw Object.assign(new Error('企业决策模型调用预算耗尽'), { code: 'ENTERPRISE_MODEL_BUDGET_EXHAUSTED' })
      if (kind === 'searches' && ++used.searches > config.max_search_rounds) throw Object.assign(new Error('企业决策检索预算耗尽'), { code: 'ENTERPRISE_SEARCH_BUDGET_EXHAUSTED' })
    }
  }
}

async function runEnterpriseDecision({ caseData, question, rules = [], experience = [], outputDirectory, checkpointRoot, provider: providedProvider = null, core: providedCore = null, onProgress = () => {}, supplementalSearch = null, config: providedConfig = null }) {
  const parsed = { ...clarifyQuestion(fixedQuestion(caseData.company?.name || caseData.company?.company_name || question?.subject)), scope: '目标企业整体经营' }
  if (!parsed.valid) return { status: 'awaiting_question', missing: parsed.missing }
  if (!Array.isArray(rules) || !Array.isArray(experience)) throw new Error('rules and experience must be arrays')
  const root = projectRoot()
  const outputRoot = path.resolve(outputDirectory || path.join(root, '.runtime', 'enterprise-output'))
  await fs.mkdir(outputRoot, { recursive: true })
  const config = providedConfig || JSON.parse(await fs.readFile(path.join(root, 'config', 'enterprise-decision.json'), 'utf8'))
  const sourceConfig = JSON.parse(await fs.readFile(path.join(root, 'config', 'enterprise-sources.json'), 'utf8'))
  const manualSources = JSON.parse(await fs.readFile(path.join(root, 'config', 'enterprise-manual-sources.json'), 'utf8'))
  const userSources = await new UserSourceConfigStore({ filePath: path.join(root, '.runtime', 'web-ui', 'user-public-sources.json') }).load()
  sourceConfig.sources = [
    ...sourceConfig.sources.filter(item => item.id !== 'web_search' || userSources.search_backend.enabled),
    ...(userSources.websites || []).filter(item => item.enabled !== false).map(item => ({ ...item, production_ingest_enabled: true, default_grade: 'C' })),
    ...manualSources.sources.filter(item => item.manual_import_enabled === true)
  ]
  const source = providedProvider ? { provider: providedProvider, executionFingerprint: 'injected-enterprise-provider' } : await loadProvider()
  const provider = source.provider
  if (typeof provider.callForJson !== 'function' && typeof provider.enterpriseDecision !== 'function') throw new Error('enterprise provider must support callForJson or enterpriseDecision')
  const { core, source: ruloraSource } = providedCore ? { core: providedCore, source: 'injected-rulora-core' } : loadRulora()
  const checkpointer = new ModelCallCheckpointStore({ rootDirectory: checkpointRoot || path.join(outputRoot, 'enterprise-checkpoints'), enabled: true })
  const repository = new FileRepository(path.join(outputRoot, 'rulora-sessions'))
  const limits = { max_exchange_rounds: config.max_exchange_rounds || { direction: 6, condition: 10 }, max_search_rounds: Number(config.max_search_rounds ?? 2), max_model_operations: Number(config.max_model_operations ?? 560) }
  for (const n of [...Object.values(limits.max_exchange_rounds), limits.max_search_rounds, limits.max_model_operations]) if (!Number.isInteger(n) || n < 0) throw new Error('循环与预算配置必须为非负整数')
  if (!limits.max_exchange_rounds.direction || !limits.max_exchange_rounds.condition) throw new Error('两层交换轮次须分别配置为正整数')
  const counters = budget(limits)
  const runId = `enterprise-${crypto.randomUUID()}`
  const machine = new core.OrchestrationMachine({ repository, scenario: enterpriseDecisionScenario })
  let currentSessionId = null
  let currentAttempt = 0
  const trace = []
  const priorAttempts = []
  const recallCache = new Map()
  const emit = async event => { trace.push({ at: new Date().toISOString(), ...event }); await onProgress(event) }
  const baseContext = { caseData: structuredClone(caseData), parsed, rules: structuredClone(rules), experience: structuredClone(experience), search_round: 0, route: 'intake', evidence_screen: null, source_gate: null, direction: null, condition: null, attempts: priorAttempts }

  function revisionPrompt(prompt, revision) {
    const binding = promptBindings.get(prompt)
    const wire = encodePrompt(prompt, binding)
    Object.defineProperty(wire, 'reference_binding', { value: binding })
    if (!revision) return wire
    if (revision.mode === 'fresh_reassessment') {
      const fresh = [...wire, {role:'user',content:JSON.stringify({revision_mode:'fresh_reassessment',instruction:'格式修订出现有效裁决变化，该修订已被拒绝。本次基于原始冻结证据和完整候选池独立重新复核，不沿用被拒绝输出，不拼装候选。仅返回原定复核JSON。'})}]
      Object.defineProperty(fresh,'reference_binding',{value:binding})
      return fresh
    }
    const revised = [...wire, { role: 'user', content: JSON.stringify({ revision_mode:revision.mode, instruction: (revision.mode==='format_only'?'本次仅修正格式，必须保留原选案、通过与否、逐项必要性判断及已有非空判断理由原文；只补缺失字段或修正结构，不改写已有理由；不得借修正格式重新裁决。':'') + '上一份JSON未通过程序校验。依据校验反馈和当前阶段输出契约纠正字段。仍仅执行本次原定岗位和阶段；第一层不要求第二层行动或冻结方向绑定，证据筛选不承担经营方向裁决。涉及业务含义的判断由你完成，不能只改枚举掩盖矛盾。保留可核验事实与原有有效证据引用。counter_evidence是说明文本，counter_evidence_refs是证据序号，不得相互替换；错误引用须回到本次证据表核对。结构修订期间仍与原始own候选比较revision_kind：若方案已发生实质变化不能因本次仅修字段而改为wording_only。必须重新输出完整JSON对象；不得猜测缺失证据。', program_errors: revision.errors, previous_output: binding ? require('./enterprise-reference-binding').transform(revision.previous_output, binding) : revision.previous_output }) }]
    Object.defineProperty(revised, 'reference_binding', { value: binding })
    return revised
  }

  async function modelCall({ operation, agent, prompt, gate, invoke, identity, reviewContext }) {
    const referenceBinding = createBinding(prompt)
    promptBindings.set(prompt, referenceBinding)
    counters.consume('model_operations')
    const attempts = []
    const pipeline = new core.HybridPipeline({ id: `${MODE}-${operation}-${agent.agent_id}`, steps: [
      { id: `${operation}_model`, owner: 'model', run: async () => {
        let revision = null, firstErrors = null
        const seatRepair = ['seat_initial','seat_self_review'].includes(operation)
        for (let attempt = 0; attempt < (operation === 'semantic_review' || seatRepair ? 3 : 2); attempt++) {
          let value, errors, failure
          try { value = await invoke(revision);
            if (referenceBinding && !value?.normalization_operations?.some(item => item.type === 'DETERMINISTIC_REFERENCE_BINDING')) {
              const original = value
              const adapted = require('./enterprise-output-protocol').adaptEnterpriseOutput(value, { operation: operation === 'seat_self_review' ? 'enterpriseDecisionReview' : null, referenceBinding })
              value = adapted.value
              const operations = adapted.operations
              for (const key of ['model_provenance','raw_model_response','output_recovery']) if (original[key] !== undefined) Object.defineProperty(value,key,{value:original[key],configurable:true})
              if (value.raw_model_response === undefined) Object.defineProperty(value,'raw_model_response',{value:JSON.stringify(original),configurable:true})
              Object.defineProperty(value,'normalization_operations',{value:operations,configurable:true})
            }
            errors = gate(value) }
          catch (error) {
            if (error.code !== 'MODEL_SCHEMA_FAILURE') throw error
            failure = error
            if (value != null) { failure.raw_model_response ||= value.raw_model_response ?? JSON.stringify(value); value = null }
            errors = [error.message]
          }
          let verdictDrift=null
          if(operation==='semantic_review' && revision?.mode==='format_only' && value) {
            try { require('./enterprise-review-repair').assertRepairPreservesVerdict(revision.previous_output,value,reviewContext) }
            catch(error) { verdictDrift=error;errors.push(error.message) }
          }
          const record = { run_id: runId, operation, agent_id: agent.agent_id, attempt,
            revision_mode: revision?.mode || null,
            verdict_drift: verdictDrift ? {previous:verdictDrift.previous_verdict,revised:verdictDrift.revised_verdict} : null,
            call_id: value?.model_provenance?.call_id || failure?.call_id || null,
            raw_model_response: value?.raw_model_response ?? failure?.raw_model_response ?? null,
            recovery: value?.output_recovery || failure?.output_recovery || null,
            reference_binding: referenceBinding,
            normalization_operations: value?.normalization_operations || failure?.normalization_operations || [],
            adapter_result: value == null ? null : structuredClone(value),
            program_review: { pass: errors.length === 0, errors },
            semantic_review: operation === 'semantic_review' && value ? structuredClone(value) : null }
          const file = path.join(outputRoot, `${runId}-${operation}-${agent.agent_id}-${crypto.randomUUID()}.json`)
          await writeJsonAtomic(file, record)
          attempts.push(file)
          
          if (!errors.length) return value
          const nextRepair = operation === 'semantic_review' ? require('./enterprise-review-repair').nextReviewRepair({attempt,errors,value,verdictDrift}) : (attempt === 0 || (seatRepair && attempt === 1 && canonicalJson(errors)!==canonicalJson(firstErrors)) ? {mode:'contract_repair',errors,previous_output:value ?? failure?.raw_model_response ?? null} : null)
          if(attempt === 0)firstErrors=[...errors]
          if (!nextRepair) throw Object.assign(new Error(`${operation} program gate rejected: ${errors.join('; ')}`), { code: 'ENTERPRISE_MODEL_CONTRACT_INVALID', validation_errors: errors, output_audit_paths: attempts })
          counters.consume('model_operations')
          const mode=nextRepair.mode
          await emit({ type: 'model_revision_requested', phase: operation, agent_id: agent.agent_id, errors, revision_mode:mode })
          revision = nextRepair
        }
      } },
      { id: `${operation}_program_gate`, owner: 'program', run: value => { const errors = gate(value); if (errors.length) throw Object.assign(new Error(errors.join('; ')), { code: 'ENTERPRISE_MODEL_CONTRACT_INVALID', validation_errors: errors }); return value } }
    ] })
    const result = await checkpointer.execute({ identity: { reference_binding: referenceBinding, contract_version: '1.0.0', output_protocol_version: deliberation.VERSION, action_options_version: ACTION_OPTIONS_VERSION, ...(operation==='semantic_review'?{review_repair_version:'2.0.0'}:{}), mode: MODE, operation, agent: { agent_id: agent.agent_id, model_profile: agent.model_profile, method_family: agent.method_family || null }, question: parsed, rules, experience, evidence_version: identity?.evidence_version || sha256(canonicalJson(baseContext.caseData.evidence || [])), model_fingerprint: source.executionFingerprint, ...identity }, run: () => pipeline.run({}), validate: value => { const errors = gate(value); if (errors.length) throw new Error(errors.join('; ')) } })
    await emit({ type: 'output_contract_reviewed', phase: operation, agent_id: agent.agent_id, audit_paths: attempts, checkpoint: result.checkpoint, output_sha256: sha256(canonicalJson(result.output)) })
    return { output: result.output, events: result.events || [], checkpoint: result.checkpoint }
  }

  async function verifyCase(context) {
    const event = { phase: 'evidence_intake', agent_id: 'public_evidence_monitor', agent_label: '信息搜集与核验' }
    await emit({ ...event, type: 'agent_started' })
    try {
      const result = await verifyCaseEvidence(context)
      await emit({ ...event, type: 'agent_completed' })
      return result
    } catch (error) {
      error.agent_id = event.agent_id
      error.agent_label = event.agent_label
      await emit({ ...event, type: 'agent_failed', error_code: error.code || 'ENTERPRISE_EVIDENCE_INVALID' })
      throw error
    }
  }

  async function verifyCaseEvidence(context) {
    const evidence = (context.caseData.evidence || []).filter(item => sourceConfig.sources.some(source => source.id === item.source_id) && item.public === true && item.published_at <= context.caseData.as_of_date)
    if (evidence.length && !context.caseData.evidence_snapshot_root) throw Object.assign(new Error('企业证据缺少快照根目录'), { code: 'ENTERPRISE_EVIDENCE_SNAPSHOT_ROOT_MISSING' })
    const errors = [
      ...validateEvidenceRegistry(evidence, { asOfDate: context.caseData.as_of_date, sourceConfig, productionMode: true }),
      ...(context.caseData.evidence_snapshot_root ? await verifyEvidenceSnapshots(evidence, { snapshotRoot: context.caseData.evidence_snapshot_root, productionMode: true }) : [])
    ].filter(message => !message.startsWith('at least '))
    if (errors.length) throw Object.assign(new Error(`企业证据门禁未通过：${errors.join('; ')}`), { code: 'ENTERPRISE_EVIDENCE_INVALID' })
    context.caseData.evidence = evidence
    const allIds = new Set(evidence.map(item => item.id))
    if (!evidence.length) return { relevant_evidence_ids: [], reasons_by_id: {}, gaps: ['未取得可核验的公开证据'] }
    const agent = { agent_id: 'enterprise_evidence_broker', model_profile: 'monitor_extractor', method_family: 'question_relevance_screen' }
    const prompt = [{ role: 'system', content: REVIEW_POLICY + '你是证据筛选员。当前仅判断已有公开证据的相关性，不要求完整供应链尽调或量化预测。无法取得的内部明细、预测及精确测算列入analysis_limitations，不作为检索目标或阻断缺口。逐条判断公开材料是否支持当前企业决策。企业自身披露可用于企业事实；适用于该企业所属行业或当前决策事项的官方政策也可作为相关背景，即使政策没有点名企业，但不得由政策推断企业已受益、已合规或具备偿债能力。排除与该企业行业和决策事项均无关的泛政策。只输出JSON：relevant_evidence_ids数组、reasons_by_id对象、gaps数组、analysis_limitations字符串数组。gaps仅列影响已有公开材料核验或相关性判断的缺口；分析限制列analysis_limitations。不得创造证据、默认结论或把转载当独立原文。' }, { role: 'user', content: JSON.stringify({ question: parsed, company: context.caseData.company, evidence: buildEvidenceBrief(evidence).documents.map(({ summary, ...item }) => item) }) }]
    const result = await modelCall({ operation: 'evidence_screen', agent, prompt, identity: { case_id: context.caseData.case_id, evidence_version: sha256(canonicalJson(evidence)), prompt_sha256: sha256(prompt) }, gate: value => validateEvidenceScreen(value, allIds), invoke: revision => typeof provider.enterpriseEvidenceScreen === 'function' ? provider.enterpriseEvidenceScreen({ agent, prompt: revisionPrompt(prompt, revision) }) : provider.callForJson({ agent, prompt: revisionPrompt(prompt, revision), operation: 'enterpriseEvidenceScreen', outputInstruction: '只返回指定JSON对象。' }) })
    await emit({ type: 'evidence_screened', phase: 'evidence_intake', relevant_count: result.output.relevant_evidence_ids.length })
    return result.output
  }

  async function callWithFallback(request, phase) {
    return require('./enterprise-model-routing').callWithModelRouting(provider, request, phase, emit)
  }

  async function settleSeats(calls) {
    const results = await Promise.allSettled(calls)
    const failure = results.find(item => item.status === 'rejected')
    if (failure) throw failure.reason
    return results.map(item => item.value)
  }

  async function runSeatStage(stage, context, prior) {
    const evidence = context.caseData.evidence.filter(item => context.evidence_screen.relevant_evidence_ids.includes(item.id))
    let brief = buildEvidenceBrief(evidence)
    let seatEvidence = brief.documents.map(({ summary, ...item }) => item)
    await emit({ type: 'evidence_brief', phase: stage, version: brief.version, text_chars: brief.total_chars })
    await writeJsonAtomic(path.join(outputRoot, `${runId}-${stage}-core-evidence-${brief.version.slice(0,12)}.json`), brief)
    const ids = new Set(evidence.map(item => item.id))
    const seatRows = SEATS[stage]
    const rounds = []
    const additions = {}
    const actionHistory = []
    const actionReceipts = {}
    const maxRounds = limits.max_exchange_rounds[stage]
    const arbitrationRules = [...deliberation.reviewRules(stage), ...rules.map((text, index) => ({ id: `USER_RULE_${index + 1}`, text }))]
    const validateSeat = value => {
      const errors = [...validateCandidate(value, stage, ids, prior), ...(value && typeof value === 'object' && !Array.isArray(value) ? deliberation.validateAnalysis(value, stage, ids) : [])]
      if (errors.length) {
        const diagnostic = evidenceReferenceDiagnostic(value, ids)
        if (diagnostic.invalid_refs.length || diagnostic.outside_candidate_refs.length) errors.push(`证据引用诊断（按path检查，选择本次allowed_evidence_ids整数序号；原始编号由程序绑定，不得猜测）：${JSON.stringify({ ...diagnostic, allowed_evidence_ids: [...ids].sort().map((_, index) => index + 1) })}`)
      }
      return errors
    }
    const operation = async (row, review, own, differencePacket, round, broadcastVersion = null, reviewerFeedback = null) => {
      const agent = modelAgent(row)
      agent.model_profile = require('./enterprise-model-routing').callProfiles(provider, agent)[0]
      const prompt = deliberation.buildSeatPrompt({ agent, stage, review, question: parsed, company: context.caseData.company, rules, experience, evidence: seatEvidence, prior, own, peers: differencePacket, round, broadcastVersion, reviewerFeedback, policy: REVIEW_POLICY, stageInstruction })
      await emit({ type: 'agent_started', phase: review ? `${stage}_self_review` : `${stage}_initial`, agent_id: agent.agent_id, agent_label: agent.label, model_profile:agent.model_profile, round, max_rounds: maxRounds })
      const invokeSeat = async revision => {
        const currentPrompt = revisionPrompt(prompt, revision)
        if (typeof provider.enterpriseDecision === 'function') return provider.enterpriseDecision({ agent, prompt: currentPrompt, stage, review, round })
        const request = { agent, prompt: currentPrompt, operation: review ? 'enterpriseDecisionReview' : 'enterpriseDecision', decisionMode: MODE, outputInstruction: '只返回指定JSON对象；事实、规则和证据ID不得补造。' }
        return callWithFallback(request, review ? `${stage}_self_review` : `${stage}_initial`)
      }
      try {
      const result = await modelCall({ operation: review ? 'seat_self_review' : 'seat_initial', agent, prompt, identity: { stage, evidence_version: context.evidence_packet.version, review_round: round, direction_version: prior?.version || null, prompt_sha256: sha256(prompt) }, gate: value => review ? deliberation.validateExchange(value, { stage, own, peers: differencePacket, broadcastVersion, validate: validateSeat }) : validateSeat(value), invoke: invokeSeat })
      await emit({ type: 'agent_completed', phase: review ? `${stage}_self_review` : `${stage}_initial`, agent_id: agent.agent_id, agent_label: agent.label, model_profile:agent.model_profile, round, max_rounds: maxRounds })
      if (review) return { exchange: result.output, seat_id: agent.agent_id, checkpoint: result.checkpoint }
      return { ...result.output, seat_id: agent.agent_id, pipeline_events: result.events, checkpoint: result.checkpoint }

      } catch (error) {
        Object.assign(error, { agent_id: agent.agent_id, agent_label: agent.label })
        await emit({ type: 'agent_failed', phase: review ? `${stage}_self_review` : `${stage}_initial`, agent_id: agent.agent_id, agent_label: agent.label, error_code: error.code || 'MODEL_CALL_FAILED' })
        throw error
      }
    }
    const graph = buildEnterpriseSeatLoopGraph({
      initial: async state => {
        if (state.decisions) return { ...state, route: state.round >= maxRounds ? 'freeze' : 'broadcast' }
        await emit({ type: 'phase_started', phase: `${stage}_initial`, max_rounds: maxRounds })
        const decisions = (await settleSeats(seatRows.map(row => operation(row, false, null, null, 0)))).map(candidate => ({...candidate,discussion_version:deliberation.discussionVersion(candidate,stage)}))
        if(stage==='condition')require('./enterprise-action-audit').recordActionHistory(actionHistory,[],decisions,0)
        const seatStates = Object.fromEntries(decisions.map(c => [c.seat_id, { status: 'active', label: seatRows.find(row=>row[0]===c.seat_id)[1], last_changed_round: 0, frozen_round: null, reviewed_broadcast_version: null, review_summary: '', seen_peer_versions: {} }]))
        return { ...state, decisions, initial: decisions, seatStates, route: 'broadcast' }
      },
      broadcast: async state => {
        const queries = state.decisions.flatMap(item => item.gaps || [])
        brief = buildEvidenceBrief(await recallSnapshotText(evidence, context.caseData.evidence_snapshot_root, recallCache), { queries })
        seatEvidence = brief.documents.map(({ summary, ...item }) => item)
        await writeJsonAtomic(path.join(outputRoot, `${runId}-${stage}-recall-${state.round + 1}.json`), { queries: cleanItems(queries), ...brief })
        await emit({ type: 'evidence_recall', phase: stage, round: state.round + 1, version: brief.version, text_chars: brief.total_chars })
        const feedbackHistory = { ...(state.basis?.reviewer_feedback || {}), ...(state.reviewer_feedback || {}) }
        const basis = { reviewer_feedback_version: sha256(canonicalJson(feedbackHistory)), reviewer_feedback: feedbackHistory, evidence_version: context.evidence_packet.version, brief_version: brief.version, direction_version: prior?.version || null, rules_version: sha256(canonicalJson(arbitrationRules)), protocol: deliberation.VERSION }
        const differencePacket = state.decisions.map(item => ({ seat_id: item.seat_id, ...deliberation.candidatePayload(item, stage),discussion_version:item.discussion_version }))
        const versions = Object.fromEntries(state.decisions.map(item => [item.seat_id, deliberation.inputVersion(state.decisions, item.seat_id, stage, basis)]))
        const seatStates = structuredClone(state.seatStates)
        for (const row of seatRows) {
          const status = seatStates[row[0]]
          if (status.status === 'frozen' && status.reviewed_broadcast_version !== versions[row[0]]) {
            status.status = 'active'
            await emit({ type: 'seat_reactivated', phase: `${stage}_self_review`, agent_id: row[0], round: state.round + 1, reason: 'broadcast_version_changed' })
          }
        }
        await emit({ type: 'difference_broadcast', phase: stage, round: state.round + 1, max_rounds: maxRounds, differences: differencePacket.length })
        return { ...state, differencePacket, basis, versions, seatStates }
      },
      self_review: async state => {
        const round = state.round + 1
        const deliveries = Object.fromEntries(seatRows.map(row => [row[0], deliberation.peerDelivery(state.differencePacket.filter(item => item.seat_id !== row[0]), stage, state.seatStates[row[0]].seen_peer_versions, state.seatStates[row[0]].seen_peer_payloads)]))
        const responses = await settleSeats(seatRows.map((row, index) => state.seatStates[row[0]].status === 'frozen' ? Promise.resolve(null) : operation(row, true, state.decisions[index], deliveries[row[0]], round, state.versions[row[0]], state.reviewer_feedback?.[row[0]] || null)))
        const seatStates = structuredClone(state.seatStates)
        const decisions = responses.map((response, index) => {
          if (!response) return state.decisions[index]
          const e = response.exchange, id = response.seat_id
          if (stage === 'condition' && e.candidate) {
            additions[id] ||= {}
            for (const code of Object.keys(additions[id])) if (!e.candidate.recommendations.includes(Number(code))) delete additions[id][code]
            for (const basis of e.addition_basis || []) additions[id][basis.code] = structuredClone(basis)
          }
          seatStates[id] = { ...seatStates[id], seen_peer_versions: Object.fromEntries(deliveries[id].map(peer => [peer.seat_id, peer.candidate_version])), seen_peer_payloads: { ...seatStates[id].seen_peer_payloads, ...Object.fromEntries(deliveries[id].filter(peer=>!peer.unchanged).map(peer=>[peer.seat_id,deliberation.candidatePayload(peer,stage)])) }, status: e.review_decision === 'revise' && e.revision_kind !== 'wording_only' ? 'active' : 'frozen', freeze_reason: e.review_decision, frozen_round: e.review_decision === 'revise' && e.revision_kind !== 'wording_only' ? null : round, last_changed_round: e.review_decision === 'maintain' ? seatStates[id].last_changed_round : round, reviewed_broadcast_version: e.broadcast_version, review_summary: e.review_summary }
          return e.review_decision === 'maintain' ? state.decisions[index] : { ...e.candidate, seat_id: id, checkpoint: response.checkpoint,discussion_version:e.revision_kind === 'wording_only' ? state.decisions[index].discussion_version : deliberation.discussionVersion(e.candidate,stage) }
        })
        for (const row of seatRows) if (seatStates[row[0]].status === 'frozen' && responses[seatRows.indexOf(row)]) await emit({ type: 'seat_frozen', phase: `${stage}_self_review`, agent_id: row[0], round, broadcast_version: seatStates[row[0]].reviewed_broadcast_version })
        // A freeze acknowledges only the peer versions actually seen. Changed
        // peers invalidate it without any program interpretation of their text.
        for (const row of seatRows) {
          const status = seatStates[row[0]]
          if (status.status === 'frozen' && status.reviewed_broadcast_version !== deliberation.inputVersion(decisions, row[0], stage, state.basis)) {
            status.status = 'active'
            await emit({ type: 'seat_reactivated', phase: `${stage}_self_review`, agent_id: row[0], round, reason: 'peer_candidate_updated' })
          }
        }
        if(stage==='condition')require('./enterprise-action-audit').recordActionHistory(actionHistory,state.decisions,decisions,round,deliveries,actionReceipts)
        const allFrozen = Object.values(seatStates).every(s => s.status === 'frozen')
        const file = path.join(outputRoot, `${runId}-${stage}-exchange-${round}.json`)
        const record = { round, max_rounds: maxRounds, basis: state.basis, broadcast: state.differencePacket, delivered_differences: deliveries, responses, addition_basis: structuredClone(additions), action_history: structuredClone(actionHistory), seat_states: seatStates }
        await writeJsonAtomic(file, record)
        rounds.push({ round, max_rounds: maxRounds, all_frozen: allFrozen, changed_seat_ids: responses.filter(r => r && r.exchange.review_decision !== 'maintain').map(r=>r.seat_id), substantive_changed_seat_ids: responses.filter(r => r && r.exchange.review_decision !== 'maintain' && r.exchange.revision_kind !== 'wording_only').map(r=>r.seat_id), wording_updated_seat_ids: responses.filter(r => r?.exchange.revision_kind === 'wording_only').map(r=>r.seat_id), active_seat_ids: Object.keys(seatStates).filter(id=>seatStates[id].status==='active'), response_summaries: responses.filter(Boolean).map(r=>({seat_id:r.seat_id,review_decision:r.exchange.review_decision,review_summary:r.exchange.review_summary})), audit_path: file, audit_sha256: sha256(canonicalJson(record)) })
        return { ...state, reviewer_feedback: null, decisions, seatStates, round, route: allFrozen || round >= maxRounds ? 'freeze' : 'broadcast', stop_reason: allFrozen ? 'all_seats_frozen' : round >= maxRounds ? 'round_limit' : null }
      },
      freeze: async state => ({ ...state, frozen: freezeStage(stage, state.decisions, evidence, prior, context.source_gate) })
    })
    let state = await graph.invoke({ context: { round: 0, route: 'initial' } }, { recursionLimit: 2 * maxRounds + 6 })
    const reviewHistory = []
    for (let reviewPass = 0; reviewPass < 2; reviewPass++) {
    const frozen = state.context.frozen
    frozen.initial_candidates = state.context.initial
    frozen.loop_rounds = rounds
    frozen.termination_reason = state.context.stop_reason
    frozen.max_exchange_rounds = maxRounds
    frozen.addition_basis = structuredClone(additions)
    if(stage==='condition')frozen.action_history = structuredClone(actionHistory)
    frozen.seat_summaries = deliberation.summarizeSeats(state.context.decisions, stage, state.context.seatStates)
    frozen.arbitration_rules = arbitrationRules
    frozen.version = sha256(canonicalJson({ previous: frozen.version, seat_summaries: frozen.seat_summaries, loop_rounds: rounds.map(({ audit_path, audit_sha256, ...round }) => round), protocol: deliberation.VERSION }))
    if (context.source_gate.satisfied && (stage !== 'condition' || prior?.code != null)) {
      const reviewQueries = state.context.decisions.flatMap(item => item.gaps || [])
      if (reviewQueries.length) {
        brief = buildEvidenceBrief(await recallSnapshotText(evidence, context.caseData.evidence_snapshot_root, recallCache), { queries: reviewQueries })
        seatEvidence = brief.documents.map(({ summary, ...item }) => item)
        await writeJsonAtomic(path.join(outputRoot, `${runId}-${stage}-review-evidence.json`), brief)
      }
      const agent = { agent_id: 'enterprise_semantic_reviewer', model_profile: 'red_team_reasoner', method_family: 'candidate_selection_only' }
      const prompt = deliberation.buildReviewPrompt({ stage, policy: REVIEW_POLICY, question: parsed, rules, arbitrationRules, prior, candidates: state.context.decisions, evidence: seatEvidence, seats: seatRows, additions, actionHistory, exchangeReviews: rounds.map(r=>({round:r.round,responses:r.response_summaries || []})) })
      await emit({ type: 'agent_started', phase: `${stage}_semantic_review`, agent_id: agent.agent_id, model_profile:agent.model_profile, agent_label: '语义复核席' })
      let result
      try {
        result = await modelCall({ operation: 'semantic_review', agent, prompt, reviewContext: {stage,candidates:state.context.decisions,actionHistory,arbitrationRules}, identity: { stage, candidate_version: frozen.version, prompt_sha256: sha256(prompt) }, gate: value => deliberation.validateReview(value, state.context.decisions, stage, arbitrationRules,{requireActionAudit:true,requireSelectionComparison:stage==='condition',actionHistory}), invoke: revision => typeof provider.enterpriseReview === 'function' ? provider.enterpriseReview({ agent, prompt: revisionPrompt(prompt, revision), stage }) : callWithFallback({ agent, prompt: revisionPrompt(prompt, revision), operation: 'enterpriseSemanticReview', outputInstruction: '只返回指定JSON，不得新增候选。' }, `${stage}_semantic_review`) })
        await emit({ type: 'agent_completed', phase: `${stage}_semantic_review`, agent_id: agent.agent_id, agent_label: '语义复核席' })
      } catch (error) {
        await emit({ type: 'agent_failed', phase: `${stage}_semantic_review`, agent_id: agent.agent_id, agent_label: '语义复核席', error_code: error.code || 'SEMANTIC_REVIEW_FAILED' })
        throw error
      }
      reviewHistory.push({ pass: reviewPass, review: result.output, candidate_version: frozen.version })
      const requests = result.output.revision_requests || []
      if (stage === 'condition' && requests.length && reviewPass === 0 && state.context.round < maxRounds) {
        const feedback = Object.fromEntries(requests.map(r=>[r.seat_id,r]))
        await emit({ type: 'review_returned_to_seats', phase: stage, round: state.context.round, seats: Object.keys(feedback) })
        // One bounded return, within the existing total exchange-round budget.
        // All seats observe any resulting changes via the ordinary broadcast graph.
        state = await graph.invoke({ context: { ...state.context, route: 'broadcast', reviewer_feedback: feedback,
          seatStates: Object.fromEntries(Object.entries(state.context.seatStates).map(([id,s])=>[id,{...s,status:feedback[id] ? 'active' : s.status}]))
        } }, { recursionLimit: 2 * maxRounds + 6 })
        continue
      }
      frozen.review_history = reviewHistory
      frozen.semantic_review_original = reviewHistory[0].review
      frozen.semantic_review = result.output
      frozen.requires_human_confirmation = result.output.authority === 'requires_human' || requests.length > 0
      if (!result.output.consistent || result.output.unresolved_gaps.length) {
        frozen.code = null
        frozen.gaps = cleanItems([...result.output.unresolved_gaps, ...(frozen.requires_human_confirmation ? [result.output.review_reason] : []), ...(result.output.unresolved_gaps.length || frozen.requires_human_confirmation ? [] : [result.output.review_reason])])
        frozen.actions = []
        delete frozen.no_action_basis
        frozen.reason = cleanItems(frozen.gaps).join('；')
      } else {
        const selected = state.context.decisions.find(item => item.seat_id === result.output.selected_seat_id)
        frozen.code = selected[candidateKey(stage)]
        frozen.gaps = cleanItems(selected.gaps)
        frozen.reason = cleanText(selected.reason)
        frozen.selected_seat_id = selected.seat_id
        frozen.actions = structuredClone(selected.actions || [])
        if(isNoNewMeasures(frozen.code))frozen.no_action_basis=structuredClone(selected.no_action_basis)
        else delete frozen.no_action_basis
        frozen.evidence_refs = [...selected.evidence_refs]
        frozen.assumptions = cleanItems(selected.assumptions || [])
      }
      frozen.version = sha256(canonicalJson({ prior_version: frozen.version, review: result.output, code: frozen.code, actions: frozen.actions, no_action_basis:frozen.no_action_basis ?? null, action_options_version:ACTION_OPTIONS_VERSION, selected_seat_id: frozen.selected_seat_id }))
    }
    return frozen
    }
  }

  async function commitBranch(sessionId, branchId, fields) {
    const turnId = `${branchId}-${sha256(fields).slice(0, 16)}`
    await machine.recordUserTurn(sessionId, { turnId, text: JSON.stringify(fields) })
    const result = await machine.submitFields(sessionId, { fields, sourceTurnId: turnId })
    if (result.rejected.length || result.missing.length) throw new Error(`Rulora ${branchId} branch rejected: ${JSON.stringify({ rejected: result.rejected, missing: result.missing })}`)
  }

  function unresolved(stage, evidenceVersion, prior = null, gaps = []) {
    const record = { stage, code: null, reason: cleanItems(gaps).join('；') || '必要证据或规则不足', evidence_refs: [], gaps, assumptions: [], seat_summaries: [], candidates: [], initial_candidates: [], loop_rounds: [], termination_reason: 'gate_unresolved', evidence_version: evidenceVersion, prior_direction_version: prior?.version || null, frozen_at: new Date().toISOString() }
    const { frozen_at, ...content } = record
    record.version = sha256(canonicalJson(content))
    return record
  }

  async function closeAttempt(context, status) {
    const evidenceVersion = context.evidence_packet?.version || sha256(canonicalJson(context.caseData.evidence || []))
    context.direction ||= unresolved('direction', evidenceVersion, null, context.source_gate?.gaps || ['方向未决'])
    context.condition ||= unresolved('condition', evidenceVersion, context.direction, ['行动建议未决'])
    if (!context.direction_committed) await commitBranch(currentSessionId, 'direction', { direction_record: context.direction })
    if (!context.condition_committed) await commitBranch(currentSessionId, 'condition', { condition_record: context.condition })
    const report = buildReport(context.direction, context.condition)
    const reportVersion = sha256(canonicalJson({ report, direction: context.direction.version, condition: context.condition.version }))
    await commitBranch(currentSessionId, 'report', { report_envelope: { report, report_version: reportVersion, status } })
    const frozen = await machine.freeze(currentSessionId, {})
    const attempt = { attempt: currentAttempt, status, evidence_version: evidenceVersion, direction_version: context.direction.version, condition_version: context.condition.version, rulora_session_id: currentSessionId, rulora_snapshot_sha256: sha256(canonicalJson(frozen)), source_gate: context.source_gate, evidence_screen: context.evidence_screen, report_version: reportVersion }
    priorAttempts.push(attempt)
    return { report, reportVersion, frozen, attempt }
  }

  const graph = buildEnterpriseDecisionGraph({
    intake: async context => {
      currentAttempt += 1
      currentSessionId = `${runId}-attempt-${currentAttempt}`
      await machine.createSession({ id: currentSessionId, subject: context.caseData.company })
      await emit({ type: 'phase_started', phase: 'evidence_intake', attempt: currentAttempt })
      const screen = await verifyCase(context)
      const gate = independentChannels(context.caseData.evidence || [], screen.relevant_evidence_ids || [])
      const sourceGate = { satisfied: gate.count >= Number(sourceConfig.policy.minimum_independent_relevant_sources || 2), independent_source_count: gate.count, publishers: gate.publishers, relevant_evidence_count: screen.relevant_evidence_ids.length, gaps: gate.count < Number(sourceConfig.policy.minimum_independent_relevant_sources || 2) ? ['整份相关证据集不足两个独立来源'] : [], analysis_limitations: screen.analysis_limitations || [], screening_notes: screen.gaps, per_claim_corroboration_required: false }
      const evidencePacket = { version: sha256(canonicalJson(context.caseData.evidence || [])), relevant_evidence_ids: screen.relevant_evidence_ids, source_gate: sourceGate }
      await commitBranch(currentSessionId, 'question_evidence', { question: parsed, evidence_packet: evidencePacket })
      await emit({ type: 'source_gate', phase: 'evidence_intake', ...sourceGate })
      return { ...context, evidence_screen: screen, source_gate: sourceGate, evidence_packet: evidencePacket, direction: null, condition: null, direction_committed: false, condition_committed: false, route: sourceGate.satisfied ? 'direction' : context.search_round < limits.max_search_rounds && supplementalSearch ? 'supplemental_search' : 'finalize' }
    },
    direction: async context => {
      await emit({ type: 'phase_started', phase: 'direction' })
      const record = await runSeatStage('direction', context, null)
      await commitBranch(currentSessionId, 'direction', { direction_record: record })
      await emit({ type: 'stage_frozen', phase: 'direction', version: record.version, code: record.code })
      return { ...context, direction: record, direction_committed: true }
    },
    condition: async context => {
      if (context.direction.code === null) {
        const record = unresolved('condition', context.evidence_packet.version, context.direction, ['第一层方向未决'])
        await commitBranch(currentSessionId, 'condition', { condition_record: record })
        return { ...context, condition: record, condition_committed: true, route: !context.direction.requires_human_confirmation && context.search_round < limits.max_search_rounds && supplementalSearch ? 'supplemental_search' : 'finalize' }
      }
      await emit({ type: 'phase_started', phase: 'condition' })
      const record = await runSeatStage('condition', context, context.direction)
      await commitBranch(currentSessionId, 'condition', { condition_record: record })
      await emit({ type: 'stage_frozen', phase: 'condition', version: record.version, code: record.code })
      return { ...context, condition: record, condition_committed: true, route: !record.requires_human_confirmation && (record.code === null || record.code?.includes(10)) && context.search_round < limits.max_search_rounds && supplementalSearch ? 'supplemental_search' : 'finalize' }
    },
    supplemental_search: async context => {
      const gaps = cleanItems([...(context.direction?.gaps || []), ...(context.condition?.gaps || []), ...(context.source_gate?.gaps || [])])
      const fingerprint = new Set((context.caseData.evidence || []).map(item => `${item.source_url}|${item.content_sha256}`))
      let retrieved = { evidence: [], status: 'no_new_relevant_evidence' }
      for (const scope of ['targeted', 'expanded']) {
        if (context.search_round >= limits.max_search_rounds) break
        counters.consume('searches')
        await emit({ type: 'phase_started', phase: 'supplemental_search', scope, round: context.search_round + 1, gaps })
        const result = await supplementalSearch({ gaps, caseData: context.caseData, question: parsed, scope, round: context.search_round + 1 })
        context.search_round += 1
        const fresh = (result?.evidence || []).filter(item => !fingerprint.has(`${item.source_url}|${item.content_sha256}`))
        retrieved = { ...result, evidence: fresh }
        if (fresh.length) break
      }
      if (retrieved.evidence.length) {
        await closeAttempt(context, 'superseded_by_new_evidence')
        const nextCase = { ...context.caseData, evidence: [...context.caseData.evidence, ...retrieved.evidence], evidence_snapshot_root: retrieved.snapshot_root || context.caseData.evidence_snapshot_root }
        await emit({ type: 'evidence_rebased', phase: 'supplemental_search', previous_version: context.evidence_packet.version, new_version: sha256(canonicalJson(nextCase.evidence)), added_count: retrieved.evidence.length })
        return { ...context, caseData: nextCase, direction: null, condition: null, route: 'intake' }
      }
      await emit({ type: 'search_stopped', phase: 'supplemental_search', reason: 'no_new_effective_evidence', status: retrieved.status })
      context.search_diagnostic = { status: retrieved.status, rounds: context.search_round }
      return { ...context, route: 'finalize' }
    },
    finalize: async context => {
      const codes=context.condition?.code
      const validAdvice=Array.isArray(codes) && codes.length>0 && new Set(codes).size===codes.length && (isNoNewMeasures(codes) || codes.every(isActualAction))
      const status = context.source_gate?.satisfied && [-1,0,1].includes(context.direction?.code) && validAdvice && context.condition?.semantic_review?.consistent===true && !context.condition.requires_human_confirmation ? 'approved' : 'awaiting_assistance'
      const finalized = await closeAttempt(context, status)
      await emit({ type: 'phase_completed', phase: 'report', status, report_version: finalized.reportVersion })
      return { ...context, status, report: finalized.report, report_version: finalized.reportVersion, final_attempt: finalized.attempt, route: 'complete' }
    }
  })

  const state = await graph.invoke({ context: baseContext }, { recursionLimit: Number(config.max_graph_steps || 24) })
  const context = state.context
  const metadata = { contract_version: MODE, action_options_version: ACTION_OPTIONS_VERSION, run_id: runId, question: parsed, status: context.status, report_version: context.report_version, direction_version: context.direction.version, condition_version: context.condition.version, evidence_version: context.evidence_packet.version, stages: { direction: context.direction, condition: context.condition }, evidence_processing: { screen: context.evidence_screen, source_gate: context.source_gate, source_runs: context.search_diagnostic || null }, attempts: priorAttempts, graph_trace: trace, budgets: counters.used, rulora_source: ruloraSource, checkpoint_diagnostics: checkpointer.diagnostics(), created_at: new Date().toISOString() }
  const paths = { report_json: path.join(outputRoot, `${runId}.report.json`), run_json: path.join(outputRoot, `${runId}.run.json`) }
  await writeJsonAtomic(paths.report_json, context.report)
  await writeJsonAtomic(paths.run_json, metadata)
  return { status: context.status, run_id: runId, report: context.report, metadata, gaps: cleanItems([...(context.direction.code === null ? context.direction.gaps || [] : []), ...(context.condition.code === null || context.condition.code?.includes(10) ? context.condition.gaps || [] : []), ...(context.source_gate.satisfied ? [] : context.source_gate.gaps || [])]), artifacts: paths }
}


function buildReport(direction, condition) {
  const cite = record => record.evidence_refs?.length ? `（证据：${record.evidence_refs.join('、')}）` : ''
  const codes = condition.code === null ? [10] : condition.code
  if(!Array.isArray(codes) || !codes.length)throw new Error('报告行动门禁拒绝：建议缺失或为空，不得自动表示无需新增措施')
  if(isNoNewMeasures(codes)) {
    const review=condition.semantic_review,row=review?.candidate_reviews?.find(r=>r.seat_id===condition.selected_seat_id)
    if(review?.consistent!==true || review.selected_seat_id!==condition.selected_seat_id || row?.assessment!=='supported' || row.independence!=='independent' || row.no_action_review?.assessment!=='supported' || row.no_action_review?.direction_assessment!=='compatible')throw new Error('报告行动门禁拒绝：无需新增措施未经绑定候选的独立复核确认')
  }
  if (!codes.includes(10)) {
    const errors = validateActions({ recommendations: codes, actions: condition.actions, evidence_refs: condition.evidence_refs, gaps: condition.gaps, direction_version:condition.prior_direction_version, ...(condition.no_action_basis?{no_action_basis:condition.no_action_basis}:{}) }, new Set(condition.evidence_refs), direction)
    if (errors.length) throw new Error(`报告行动门禁拒绝：${errors.join('；')}`)
  }
  const recommendations = codes.map(id => id === 10 ? { 编号: 10, 建议: ACTION_LABELS[10], 无法建议原因: condition.reason || '关键缺口未解决' } : id===13 ? {编号:13,建议:ACTION_LABELS[13],无需新增原因:condition.no_action_basis.why_sufficient,已有安排:structuredClone(condition.no_action_basis.existing_arrangements),方向关系:condition.no_action_basis.direction_relation} : { 编号: id, 建议: ACTION_LABELS[id], ...condition.actions.find(a => a.id === id) })
  const report = { 方向: direction.code, 决策建议: recommendations, 理由: `经营方向：${cleanText(direction.reason)}${cite(direction)}\n\n决策建议：${cleanText(condition.reason)}${cite(condition)}` }
  if (![null,-1,0,1].includes(report.方向) || !Array.isArray(codes) || (codes.includes(10) && codes.length !== 1)) throw new Error('企业决策v2报告合同校验失败')
  if (!validateReportSchema(report)) throw new Error(`报告结构校验失败：${JSON.stringify(validateReportSchema.errors)}`)
  return report
}

module.exports = { evidenceReferenceDiagnostic, MODE, LABELS, SEATS, clarifyQuestion, sourceIdentity, independentChannels, validateCandidate, validateEvidenceScreen, meaningfulProgress, freezeStage, buildReport, runEnterpriseDecision }
