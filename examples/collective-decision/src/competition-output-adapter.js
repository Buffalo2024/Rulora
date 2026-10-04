const { ACTION_TO_DIRECTION } = require('./competition-response-normalizer')
const { expandReviewerSelection } = require('./competition-mode')
const { canonicalJson } = require('./utils')

const VALID_ACTIONS = new Set([-1, 0, 1])
const VALID_RISKS = new Set(['1', '2', '3', '4', '5', '6', '7', '8', '9'])
const riskFieldAliases = Object.freeze([
  'risk_control_advice',
  'risk_set_candidate',
  'risk_mitigation_labels',
  'risk_mitigation_recommendations',
  '风控建议'
])

function adaptCompetitionSeatOutput(input, { expectedAgentId = null } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw semanticFailure('competition output is not an object')
  input = unwrapSingleDecisionObject(input, ['action', 'action_candidate', '经营调整方向', ...riskFieldAliases])
  const warnings = []
  const action = uniqueAction(input)
  const { risk, sourceField: riskSourceField } = uniqueRiskSet(input)
  const reason = textArray(firstDefined(input.action_reason, input.risk_reason, input.reason))
  const rawLogic = Array.isArray(input['逻辑']) ? input['逻辑'] : []
  const logic = rawLogic.map(item => normalizeLogic(item, warnings)).filter(Boolean).slice(0, 6)
  const evidence = unique(logic.flatMap(item => item.evidence_refs))
  if (rawLogic.length > logic.length) warnings.push('FULL_SCHEMA_MISMATCH')
  if (!evidence.length) warnings.push('MISSING_EVIDENCE_REF')
  if (!logic.length && evidence.length) logic.push({ claim: reason[0] || '模型给出比赛决策', mechanism: reason[0] || '模型给出比赛决策', evidence_refs: evidence })

  const selected = new Set(risk)
  const assessments = []
  for (const item of Array.isArray(input.label_assessments) ? input.label_assessments : []) {
    const code = String(item?.code ?? '')
    if (!selected.has(code) || !VALID_RISKS.has(code) || assessments.some(existing => existing.code === code)) {
      warnings.push('FULL_SCHEMA_MISMATCH')
      continue
    }
    assessments.push({
      code,
      necessary: typeof item.necessary === 'boolean' ? item.necessary : null,
      why_required: textArray(item.why_required).filter(Boolean).slice(0, 4),
      why_deletable: textArray(item.why_deletable).filter(Boolean).slice(0, 4),
      counter_evidence: evidenceArray(item.counter_evidence),
      assessment_source: 'model',
      necessary_source: typeof item.necessary === 'boolean' ? 'model' : 'missing'
    })
  }
  for (const code of risk) if (!assessments.some(item => item.code === code)) {
    assessments.push({ code, necessary: null, why_required: [], why_deletable: [], counter_evidence: [], assessment_source: 'missing', necessary_source: 'missing' })
    warnings.push('OPTIONAL_FIELD_MISSING')
  }

  const agentId = expectedAgentId || String(input.execution_agent || input['执行员'] || '')
  const value = {
    action,
    risk_control_advice: risk,
    risk_source_field: riskSourceField,
    execution_agent: agentId,
    action_candidate: action,
    action_confidence: boundedNumber(input.action_confidence),
    action_reason: reason.slice(0, 6),
    transmission_evidence: evidenceArray(input.transmission_evidence),
    threshold_evidence: evidenceArray(input.threshold_evidence),
    counter_evidence: evidenceArray(input.counter_evidence),
    set_confidence: boundedNumber(firstDefined(input.set_confidence, input.risk_set_confidence)),
    label_assessments: assessments,
    '执行员': agentId,
    '经营调整方向': ACTION_TO_DIRECTION[String(action)],
    '风控建议': risk,
    '逻辑': logic,
    '证据': evidence,
    audit_field_sources: {
      action: sourceOf(input, ['action', 'action_candidate', '经营调整方向']),
      risk_control_advice: riskSourceField,
      action_confidence: sourceOf(input, ['action_confidence']),
      set_confidence: sourceOf(input, ['set_confidence', 'risk_set_confidence']),
      label_assessments: Array.isArray(input.label_assessments) ? 'model' : 'missing',
      execution_agent: 'derived'
    },
    warnings: unique(warnings)
  }
  if (canonicalJson(value) !== canonicalJson(input)) warnings.push('SCHEMA_NORMALIZED')
  value.warnings = unique(warnings)
  Object.defineProperty(value, 'protocol_warnings', { enumerable: false, configurable: true, value: unique(warnings) })
  return { value, warnings: unique(warnings), normalized_response: canonicalJson(value) }
}

function adaptCompetitionActionOutput(input, { expectedAgentId = null } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw semanticFailure('competition Action output is not an object')
  input = unwrapSingleDecisionObject(input, ['action', 'action_candidate', '经营调整方向'])
  const warnings = []
  const action = uniqueAction(input)
  const reason = textArray(firstDefined(input.action_reason, input.reason)).slice(0, 6)
  const rawLogic = Array.isArray(input['逻辑']) ? input['逻辑'] : Array.isArray(input.logic) ? input.logic : []
  const logic = rawLogic.map(item => normalizeLogic(item, warnings)).filter(Boolean).slice(0, 6)
  const evidence = unique(logic.flatMap(item => item.evidence_refs))
  if (!evidence.length) warnings.push('MISSING_EVIDENCE_REF')
  const agentId = expectedAgentId || String(input.execution_agent || input['执行员'] || '')
  const value = {
    action_candidate: action,
    action_reason: reason,
    threshold_evidence: evidenceArray(input.threshold_evidence),
    counter_evidence: evidenceArray(input.counter_evidence),
    transmission_evidence: evidenceArray(input.transmission_evidence),
    action_confidence: boundedNumber(input.action_confidence),
    execution_agent: agentId,
    '执行员': agentId,
    '经营调整方向': ACTION_TO_DIRECTION[String(action)],
    '逻辑': logic,
    '证据': evidence,
    warnings: unique(warnings)
  }
  if (canonicalJson(value) !== canonicalJson(input)) warnings.push('SCHEMA_NORMALIZED')
  value.warnings = unique(warnings)
  return { value, warnings: value.warnings, normalized_response: canonicalJson(value) }
}

function adaptCompetitionRiskOutput(input, { expectedAgentId = null } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw semanticFailure('competition Risk output is not an object')
  const aliases = ['final_risk_control_advice', ...riskFieldAliases]
  input = unwrapSingleDecisionObject(input, aliases)
  if (['risk_up', 'risk_flat', 'risk_down'].some(key => input[key] !== undefined) && !aliases.some(key => input[key] !== undefined)) {
    throw semanticFailure('SEMANTIC_AMBIGUITY: conditional Risk tree lacks final_risk_control_advice')
  }
  const { risk, sourceField } = uniqueRiskSet(input, aliases)
  const warnings = []
  const reason = textArray(firstDefined(input.risk_reason, input.reason)).slice(0, 6)
  const rawLogic = Array.isArray(input['逻辑']) ? input['逻辑'] : Array.isArray(input.logic) ? input.logic : []
  const logic = rawLogic.map(item => normalizeLogic(item, warnings)).filter(Boolean).slice(0, 6)
  const evidence = unique([...evidenceArray(input.evidence_refs), ...logic.flatMap(item => item.evidence_refs)])
  if (!evidence.length) warnings.push('MISSING_EVIDENCE_REF')
  const selected = new Set(risk)
  const assessments = []
  for (const item of Array.isArray(input.label_assessments) ? input.label_assessments : []) {
    const code = String(item?.code ?? '')
    if (!selected.has(code) || assessments.some(existing => existing.code === code)) {
      warnings.push('FULL_SCHEMA_MISMATCH')
      continue
    }
    assessments.push({
      code,
      necessary: typeof item.necessary === 'boolean' ? item.necessary : null,
      why_required: textArray(item.why_required).slice(0, 4),
      why_deletable: textArray(item.why_deletable).slice(0, 4),
      counter_evidence: evidenceArray(item.counter_evidence)
    })
  }
  const agentId = expectedAgentId || String(input.execution_agent || input['执行员'] || '')
  const value = {
    risk_control_advice: risk,
    risk_source_field: sourceField,
    risk_reason: reason,
    evidence_refs: evidence,
    set_confidence: boundedNumber(firstDefined(input.set_confidence, input.risk_set_confidence)),
    label_assessments: assessments,
    execution_agent: agentId,
    '执行员': agentId,
    '风控建议': risk,
    '逻辑': logic,
    '证据': evidence,
    warnings: unique(warnings)
  }
  if (canonicalJson(value) !== canonicalJson(input)) warnings.push('SCHEMA_NORMALIZED')
  value.warnings = unique(warnings)
  return { value, warnings: value.warnings, normalized_response: canonicalJson(value) }
}

function adaptCompetitionReviewerOutput(input, { reviewCandidatePool = null } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw semanticFailure('competition reviewer output is not an object')
  input = unwrapSingleDecisionObject(input, ['selected_action_candidate_id', 'selected_risk_candidate_id', 'challenge_intent', 'evidence_strength'])
  let value
  try {
    value = expandReviewerSelection(input, reviewCandidatePool)
  } catch (error) {
    throw semanticFailure(error.message)
  }
  const warnings = [...(value.warnings || [])]
  if (canonicalJson(value) !== canonicalJson(input)) warnings.push('SCHEMA_NORMALIZED')
  value.warnings = unique(warnings)
  value.audit_field_sources = {
    selected_action_candidate_id: 'model',
    selected_risk_candidate_id: 'model',
    challenge_intent: 'model',
    evidence_strength: 'model',
    action: 'program_candidate_expansion',
    risk_control_advice: 'program_candidate_expansion',
    challenge_strength: 'program_mapping'
  }
  Object.defineProperty(value, 'protocol_warnings', { enumerable: false, configurable: true, value: warnings })
  return { value, warnings, normalized_response: canonicalJson(value) }
}

function normalizeReviewerSelection(selection, risk, candidatePool, fallbackReason) {
  if (selection && typeof selection === 'object' && !Array.isArray(selection)) {
    const deletedLabels = Array.isArray(selection.deleted_labels)
      ? selection.deleted_labels.map(item => typeof item === 'object' ? item?.label : item).filter(value => value !== undefined)
      : []
    return {
      source_candidate_set_id: String(selection.source_candidate_set_id || ''),
      removed_codes: normalizeRiskArray(selection.removed_codes ?? deletedLabels),
      reason: textArray(selection.reason || selection.deletion_reason || deletedLabels.map(code => `Reviewer删除标签${code}。`))
    }
  }
  const candidates = (candidatePool?.candidates || []).filter(item => {
    const value = normalizeRiskArray(item.value || [])
    return risk.every(code => value.includes(code))
  })
  const exact = candidates.filter(item => canonicalJson(normalizeRiskArray(item.value || [])) === canonicalJson(risk))
  const source = exact.length === 1 ? exact[0] : candidates.length === 1 ? candidates[0] : null
  if (!source) return null
  const sourceRisk = normalizeRiskArray(source.value || [])
  return {
    source_candidate_set_id: source.candidate_id,
    removed_codes: sourceRisk.filter(code => !risk.includes(code)),
    reason: textArray(fallbackReason).length ? textArray(fallbackReason) : ['Program按Reviewer明确完整集合匹配冻结候选集。']
  }
}

function uniqueAction(input) {
  const candidates = [input.action, input.action_candidate, input['经营调整方向']]
    .filter(value => value !== undefined && value !== null && value !== '')
    .map(value => directionToAction(value))
  if (!candidates.length || candidates.some(value => !VALID_ACTIONS.has(value)) || new Set(candidates).size !== 1) throw semanticFailure('Action is missing, invalid, or ambiguous')
  return candidates[0]
}

function uniqueRiskSet(input, aliases = riskFieldAliases) {
  const sourceField = aliases.find(alias => input[alias] !== undefined)
  if (!sourceField) throw semanticFailure('Risk set is missing')
  return { risk: normalizeRiskArray(input[sourceField]), sourceField }
}

function normalizeRiskArray(value) {
  const items = Array.isArray(value) ? value : String(value || '').split(',').map(item => item.trim()).filter(Boolean)
  const normalized = items.map(String)
  if (normalized.length > 4 || new Set(normalized).size !== normalized.length || normalized.some(code => !VALID_RISKS.has(code))) throw semanticFailure('Risk set is invalid')
  return normalized.sort((a, b) => Number(a) - Number(b))
}

function normalizeLogic(item, warnings) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null
  const refs = evidenceArray(item.evidence_refs)
  if (!refs.length) { warnings.push('MISSING_EVIDENCE_REF'); return null }
  const claim = String(item.claim || '').trim()
  const mechanism = String(item.mechanism || '').trim()
  if (!claim || !mechanism) return null
  return { claim: claim.slice(0, 300), mechanism: mechanism.slice(0, 600), evidence_refs: refs }
}

function directionToAction(value) {
  const map = {
    risk_up: -1, '上升': -1, '风险上升': -1, '信用风险上升': -1, '收紧': -1,
    risk_flat: 0, '持平': 0, '风险持平': 0, '信用风险持平': 0, '维持': 0,
    risk_down: 1, '下降': 1, '风险下降': 1, '信用风险下降': 1, '放宽': 1
  }
  if (Object.hasOwn(map, String(value))) return map[String(value)]
  if (/^-?[01]$/.test(String(value).trim())) return Number(value)
  return NaN
}

function textArray(value) {
  if (Array.isArray(value)) return value.map(item => typeof item === 'string' ? item : canonicalJson(item)).filter(Boolean)
  if (value === undefined || value === null || value === '') return []
  return [typeof value === 'string' ? value : canonicalJson(value)]
}
function boundedTextArray(value, count, length) { return textArray(value).filter(Boolean).slice(0, count).map(item => item.slice(0, length)) }
function stringArray(value) { return unique((Array.isArray(value) ? value : value ? [value] : []).map(String).filter(Boolean)) }
function evidenceArray(value) { return stringArray(value) }
function boundedNumber(value) { const number = Number(value); return Number.isFinite(number) && number >= 0 && number <= 1 ? number : 0 }
function firstDefined(...values) { return values.find(value => value !== undefined && value !== null) }
function sourceOf(input, keys) { return keys.some(key => input[key] !== undefined && input[key] !== null) ? 'model' : 'missing' }
function unique(values) { return [...new Set(values)] }
function unwrapSingleDecisionObject(input, recognizedKeys) {
  if (recognizedKeys.some(key => input[key] !== undefined)) return input
  const values = Object.values(input)
  if (values.length !== 1 || !values[0] || typeof values[0] !== 'object' || Array.isArray(values[0])) return input
  return recognizedKeys.some(key => values[0][key] !== undefined) ? values[0] : input
}
function semanticFailure(message) { const error = new Error(message); error.code = 'MODEL_SCHEMA_FAILURE'; return error }

module.exports = { adaptCompetitionActionOutput, adaptCompetitionReviewerOutput, adaptCompetitionRiskOutput, adaptCompetitionSeatOutput, riskFieldAliases }
