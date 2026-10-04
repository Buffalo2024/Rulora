const { canonicalJson, sha256 } = require('./utils')
const { recoverCompetitionOutput } = require('./competition-output-recovery')
const { riskFieldAliases } = require('./competition-output-adapter')

const PASS = 'PASS'
const REVISE_REQUIRED = 'REVISE_REQUIRED'
const HARD_FAIL = 'HARD_FAIL'
const PAUSED_SEAT_FAILURE = 'PAUSED_SEAT_FAILURE'
const MAX_CONSTRAINT_REVISIONS_PER_NODE = 2
const ACTION_ALIASES = Object.freeze(['action', 'action_candidate', '经营调整方向'])

function classifyCompetitionValidationFailure({ rawResponse, stagePhase, operation, error, attempt = 0 } = {}) {
  const raw = String(rawResponse || '')
  const recovered = recoverForInspection(raw, { stagePhase, operation })
  const value = recovered?.value && typeof recovered.value === 'object' ? unwrap(recovered.value) : null
  const exhausted = Number(attempt) >= MAX_CONSTRAINT_REVISIONS_PER_NODE
  const fail = (status, rule, field, currentValue, instruction, reason) => validationResult({
    status: exhausted && status === REVISE_REQUIRED ? PAUSED_SEAT_FAILURE : status,
    reason: exhausted && status === REVISE_REQUIRED ? 'revision_budget_exhausted' : reason,
    feedback: status === REVISE_REQUIRED ? feedback({ field, rule, currentValue, instruction }) : null,
    original_status: status,
    attempt
  })

  if (stagePhase === 'risk_control_advice') {
    const risk = findAlias(value, riskFieldAliases)
    const conditional = hasConditionalRiskTree(value) || /\brisk_(?:up|flat|down)\b/i.test(raw)
    if (!risk.found && conditional) return fail(REVISE_REQUIRED, 'FINAL_RISK_SET_REQUIRED', 'risk_control_advice', null, '从条件分析中选择一个最终完整Risk集合，明确输出risk_control_advice，数量0-4项。', 'conditional_risk_without_final_selection')
    if (!risk.found && value) return fail(REVISE_REQUIRED, 'CORE_FIELD_REQUIRED', 'risk_control_advice', null, '明确输出最终完整risk_control_advice集合；若无需措施，必须显式输出空数组。', 'risk_set_missing_and_empty_not_explicit')
    if (!risk.found) return fail(HARD_FAIL, 'CORE_FIELD_REQUIRED', 'risk_control_advice', null, null, 'unrelated_or_unrecoverable_output')
    const normalized = normalizeRiskForInspection(risk.value)
    if (!normalized) return fail(REVISE_REQUIRED, 'RISK_SET_FORMAT', 'risk_control_advice', risk.value, '输出唯一的Risk编码数组，只能包含1-9。', 'risk_set_format_invalid')
    if (normalized.length > 4) return fail(REVISE_REQUIRED, 'MAX_ITEMS_4', 'risk_control_advice', normalized, '重新选择最必要的0-4项风险控制措施，不得由Program删减。', 'risk_set_exceeds_maximum')
    if (new Set(normalized).size !== normalized.length) return fail(REVISE_REQUIRED, 'UNIQUE_ITEMS', 'risk_control_advice', normalized, '重新输出无重复的完整Risk集合。', 'risk_set_contains_duplicates')
    if (normalized.some(code => !/^[1-9]$/.test(code))) return fail(REVISE_REQUIRED, 'VALID_CODES_1_9', 'risk_control_advice', normalized, '重新选择Risk集合，仅允许编码1-9。', 'risk_code_out_of_range')
  }

  if (stagePhase === 'decision_direction') {
    const action = findAlias(value, ACTION_ALIASES)
    const explicitDirection = raw.match(/\b(?:risk_up|risk_flat|risk_down)\b/i)?.[0] || null
    if (!action.found && explicitDirection) return fail(REVISE_REQUIRED, 'ACTION_FIELD_REQUIRED', 'action_candidate', explicitDirection, '将已经明确的经营方向以action_candidate=-1、0或1输出。', 'explicit_direction_without_action_field')
    if (!action.found && value) return fail(REVISE_REQUIRED, 'CORE_FIELD_REQUIRED', 'action_candidate', null, '明确输出唯一action_candidate，只能是-1、0或1。', 'action_missing_from_recoverable_output')
    if (!action.found) return fail(REVISE_REQUIRED, 'CORE_FIELD_REQUIRED', 'action_candidate', null, '上一输出未形成可解析的经营方向。请重新执行当前席位判断，并明确输出唯一action_candidate，只能是-1、0或1。', 'action_missing_or_unrecoverable_output')
    if (!validAction(action.value)) return fail(REVISE_REQUIRED, 'ACTION_ENUM', 'action_candidate', action.value, '重新输出唯一action_candidate，只能是-1、0或1。', 'action_value_invalid')
  }

  return fail(HARD_FAIL, 'UNCLASSIFIED_SEMANTIC_FAILURE', stagePhase || operation || 'output', null, null, String(error?.message || error || 'validation failed'))
}

function validationResult({ status, reason = null, feedback = null, original_status = status, attempt = 0 }) {
  return {
    contract_version: '1.0.0', status, original_status, reason, attempt,
    max_revision_per_node: MAX_CONSTRAINT_REVISIONS_PER_NODE,
    feedback,
    feedback_hash: feedback ? sha256(canonicalJson(feedback)) : null
  }
}

function feedback({ field, rule, currentValue, instruction }) {
  return { type: 'CONSTRAINT_VIOLATION', field, rule, current_value: currentValue, instruction }
}

function buildConstraintRevisionPrompt(feedbackValue) {
  return [{
    role: 'user',
    content: JSON.stringify({
      program_validation_feedback: feedbackValue,
      task: '根据确定性约束反馈重新选择并输出完整核心结果。不得要求Program代替删减或生成业务答案。只输出JSON。'
    })
  }]
}

function recoverForInspection(raw, context) {
  try { return recoverCompetitionOutput(raw, context) } catch { return null }
}
function unwrap(value) {
  let current = value
  for (let depth = 0; depth < 3; depth += 1) {
    const keys = Object.keys(current || {})
    if (keys.length !== 1 || !current[keys[0]] || typeof current[keys[0]] !== 'object' || Array.isArray(current[keys[0]])) break
    current = current[keys[0]]
  }
  return current
}
function findAlias(value, aliases) {
  if (!value) return { found: false, value: undefined }
  for (const alias of aliases) if (Object.prototype.hasOwnProperty.call(value, alias)) return { found: true, value: value[alias] }
  return { found: false, value: undefined }
}
function hasConditionalRiskTree(value) { return value && ['risk_up', 'risk_flat', 'risk_down'].some(key => Object.prototype.hasOwnProperty.call(value, key)) }
function normalizeRiskForInspection(value) {
  if (Array.isArray(value)) return value.map(String)
  if (typeof value === 'string') return value.trim() === '' ? [] : value.split(/[,，]/).map(item => item.trim()).filter(Boolean)
  return null
}
function validAction(value) {
  if ([-1, 0, 1].includes(Number(value)) && String(value).trim() !== '') return true
  return ['risk_up', 'risk_flat', 'risk_down'].includes(String(value))
}

module.exports = { PASS, REVISE_REQUIRED, HARD_FAIL, PAUSED_SEAT_FAILURE, MAX_CONSTRAINT_REVISIONS_PER_NODE, buildConstraintRevisionPrompt, classifyCompetitionValidationFailure }
