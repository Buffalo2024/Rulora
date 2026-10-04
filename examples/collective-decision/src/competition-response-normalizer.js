const { canonicalJson } = require('./utils')

const ACTION_TO_DIRECTION = Object.freeze({
  '-1': 'risk_up',
  '0': 'risk_flat',
  '1': 'risk_down'
})

function normalizeCompetitionStageDecision(input, { phase = 'competition_joint_decision', expectedAgentId = null } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { value: input, operations: [] }
  }
  const value = structuredClone(input)
  const operations = []
  const beforeAction = value.action_candidate
  const beforeRisk = Array.isArray(value['风控建议']) ? value['风控建议'].map(String) : value['风控建议']

  canonicalizeInteger(value, 'action_candidate', [-1, 0, 1], operations)
  canonicalizeNumber(value, 'action_confidence', operations)
  canonicalizeNumber(value, 'set_confidence', operations)
  wrapStringAsArray(value, 'action_reason', operations)
  for (const field of ['transmission_evidence', 'threshold_evidence', 'counter_evidence']) {
    wrapStringAsArray(value, field, operations)
  }

  if (Array.isArray(value['风控建议'])) {
    const normalized = value['风控建议'].map(item => typeof item === 'number' && Number.isInteger(item) ? String(item) : item)
    replaceIfChanged(value, '风控建议', normalized, operations, 'SAFE_CANONICALIZATION', 'risk_codes_number_to_string')
  }

  if (Array.isArray(value.label_assessments)) {
    for (const assessment of value.label_assessments) {
      if (!assessment || typeof assessment !== 'object' || Array.isArray(assessment)) continue
      if (typeof assessment.code === 'number' && Number.isInteger(assessment.code)) {
        replaceIfChanged(assessment, 'code', String(assessment.code), operations, 'SAFE_CANONICALIZATION', 'assessment_code_number_to_string')
      }
      if (assessment.necessary === 'true' || assessment.necessary === 'false') {
        replaceIfChanged(assessment, 'necessary', assessment.necessary === 'true', operations, 'SAFE_CANONICALIZATION', 'boolean_string_to_boolean')
      }
      wrapStringAsArray(assessment, 'why_required', operations)
      wrapStringAsArray(assessment, 'why_deletable', operations)
      wrapStringAsArray(assessment, 'counter_evidence', operations)
    }
    const selected = new Set(Array.isArray(value['风控建议']) ? value['风控建议'].map(String) : [])
    const retained = value.label_assessments.filter(item => selected.has(String(item?.code)) || item?.necessary !== false)
    if (retained.length !== value.label_assessments.length) {
      operations.push({
        type: 'PROGRAM_DERIVED',
        operation: 'drop_explicitly_unselected_label_assessments',
        removed_codes: value.label_assessments.filter(item => !retained.includes(item)).map(item => String(item?.code))
      })
      value.label_assessments = retained
    }
  }

  if (expectedAgentId) {
    replaceIfChanged(value, '执行员', expectedAgentId, operations, 'PROGRAM_DERIVED', 'bind_executor_from_routing')
  } else if (typeof value.execution_agent === 'string' && value['执行员'] === undefined) {
    replaceIfChanged(value, '执行员', value.execution_agent, operations, 'PROGRAM_DERIVED', 'derive_executor_alias')
  }

  const derivedDirection = ACTION_TO_DIRECTION[String(value.action_candidate)]
  if (derivedDirection) {
    const reported = value['经营调整方向']
    const compatibleReported = reported === undefined || reported === derivedDirection || String(reported) === String(value.action_candidate)
    if (compatibleReported) {
      replaceIfChanged(value, '经营调整方向', derivedDirection, operations, 'PROGRAM_DERIVED', 'derive_direction_from_action_candidate')
    }
  }

  if (Array.isArray(value['逻辑'])) {
    const derivedEvidence = [...new Set(value['逻辑'].flatMap(item => Array.isArray(item?.evidence_refs) ? item.evidence_refs.map(String) : []))].sort()
    replaceIfChanged(value, '证据', derivedEvidence, operations, 'PROGRAM_DERIVED', 'derive_evidence_union_from_logic')
  }

  assertCoreDecisionUnchanged({ beforeAction, beforeRisk, value })
  return {
    value,
    operations,
    normalized_response: canonicalJson(value)
  }
}

function canonicalizeInteger(target, field, allowed, operations) {
  const current = target[field]
  if (typeof current !== 'string' || !/^-?\d+$/.test(current.trim())) return
  const number = Number(current)
  if (!allowed.includes(number)) return
  replaceIfChanged(target, field, number, operations, 'SAFE_CANONICALIZATION', 'integer_string_to_number')
}

function canonicalizeNumber(target, field, operations) {
  const current = target[field]
  if (typeof current !== 'string' || current.trim() === '') return
  const number = Number(current)
  if (!Number.isFinite(number)) return
  replaceIfChanged(target, field, number, operations, 'SAFE_CANONICALIZATION', 'numeric_string_to_number')
}

function wrapStringAsArray(target, field, operations) {
  if (typeof target[field] !== 'string') return
  replaceIfChanged(target, field, [target[field]], operations, 'SAFE_CANONICALIZATION', 'string_to_single_item_array')
}

function replaceIfChanged(target, field, next, operations, type, operation) {
  if (canonicalJson(target[field]) === canonicalJson(next)) return
  operations.push({ type, operation, field })
  target[field] = next
}

function assertCoreDecisionUnchanged({ beforeAction, beforeRisk, value }) {
  if (beforeAction !== undefined && String(beforeAction) !== String(value.action_candidate)) {
    const error = new Error('competition normalizer changed Action semantics')
    error.code = 'NORMALIZER_SEMANTIC_CHANGE'
    throw error
  }
  if (Array.isArray(beforeRisk)) {
    const afterRisk = Array.isArray(value['风控建议']) ? value['风控建议'].map(String) : value['风控建议']
    if (canonicalJson(beforeRisk) !== canonicalJson(afterRisk)) {
      const error = new Error('competition normalizer changed Risk set semantics')
      error.code = 'NORMALIZER_SEMANTIC_CHANGE'
      throw error
    }
  }
}

module.exports = { ACTION_TO_DIRECTION, normalizeCompetitionStageDecision }
