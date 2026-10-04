// This layer handles syntax and trusted routing metadata only. It never maps
// business words, supplies decisions, guesses semantic enums, or changes review verdicts.
// Reference binding may derive applicability from an explicit empty action set.
const { canonicalJson } = require('./utils')
function usesEnterpriseProtocol(operation, mode) {
  return mode === 'enterprise_decision_v2' || /^enterprise/.test(operation || '') || ['planIndustry', 'proposeImprovement'].includes(operation)
}
function reject(message) { throw Object.assign(new Error(message), { code: 'MODEL_SCHEMA_FAILURE' }) }
function rejectDuplicateKeys(text) {
  const stack = []
  for (const match of text.matchAll(/"(?:\\.|[^"\\])*"|[{}\[\],:]|[^\s{}\[\],:]+/g)) {
    const token = match[0], frame = stack.at(-1)
    if (token === '{' || token === '[') stack.push({ object: token === '{', key: token === '{', keys: new Set() })
    else if (token === '}' || token === ']') stack.pop()
    else if (token === ',' && frame?.object) frame.key = true
    else if (token === ':' && frame?.object) frame.key = false
    else if (frame?.object && frame.key && token.startsWith('"')) {
      const key = JSON.parse(token)
      if (frame.keys.has(key)) reject(`JSON包含重复字段：${key}`)
      frame.keys.add(key)
    }
  }
}
function recoverEnterpriseOutput(raw) {
  let text = String(raw ?? '').trim()
  const operations = []
  const fence = text.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i)
  if (fence) { text = fence[1].trim(); operations.push('strip_complete_json_fence') }
  // No arbitrary substring extraction: two answers or prose may contradict.
  let value
  try { value = JSON.parse(text) } catch { reject('输出必须是唯一完整JSON对象；不接受截断、多个答案或夹带说明') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) reject('输出顶层必须是JSON对象')
  rejectDuplicateKeys(text)
  return { value, normalized_text: text, output_recovery: { status: 'RECOVERED', repair_applied: operations.length > 0, operations } }
}
function adaptEnterpriseOutput(value, { operation = null, expectedAgentId = null, referenceBinding = null } = {}) {
  const operations = []
  let envelope
  try { envelope = require('./enterprise-envelope-adapter').normalizeEnterpriseEnvelope(structuredClone(value), operation, operations) }
  catch (error) { error.normalization_operations = structuredClone(operations); throw error }
  // Compare before reference binding: decoding must not make distinct raw
  // actions appear equal. No merging, field coercion or semantic comparison.
  for (const [candidate, field] of [[envelope, 'actions'], [envelope.candidate, 'candidate.actions']]) {
    if (!Array.isArray(candidate?.actions)) continue
    const seen = new Map()
    candidate.actions = candidate.actions.filter((action, index) => {
      if (!action || !Number.isInteger(action.id)) return true
      const key = canonicalJson(action)
      if (!seen.has(key)) { seen.set(key, index); return true }
      operations.push({ type: 'SAFE_NORMALIZATION', operation: 'remove_exact_duplicate_action', field, removed_index: index, retained_index: seen.get(key), id: action.id, removed_value: structuredClone(action) })
      return false
    })
  }
  const adapted = require('./enterprise-reference-binding').bindOutput(envelope, referenceBinding, operations)
  if (['planIndustry', 'proposeImprovement'].includes(operation)) {
    if (typeof expectedAgentId !== 'string' || !expectedAgentId.trim()) reject('输出适配缺少可信调用身份')
    operations.push({ type: 'ROUTING_METADATA', operation: 'bind_trusted_route_agent_id', field: '执行员', model_reported_value: structuredClone(value['执行员'] ?? null), derived_value: expectedAgentId })
    adapted['执行员'] = expectedAgentId
  }
  if (operation === 'planIndustry') normalizeIndustryPlanWireFormat(adapted, operations)
  // Business decisions remain untouched; their errors still go to contract review.
  return { value: adapted, normalized_response: canonicalJson(adapted), warnings: [], operations }
}

const SOURCE_TYPE_ALIASES = new Map([
  ['公司公告', 'company_disclosure'],
  ['上市公司公告', 'company_disclosure'],
  ['政府政策', 'government_policy'],
  ['政策文件', 'government_policy'],
  ['政府统计', 'government_statistics'],
  ['统计数据', 'government_statistics'],
  ['政府信用', 'government_credit'],
  ['信用中国', 'government_credit'],
  ['企业工商', 'enterprise_registry'],
  ['工商信息', 'enterprise_registry'],
  ['官方市场数据', 'official_market_data'],
  ['大宗商品价格', 'official_market_data'],
  ['权威媒体', 'reputable_media'],
  ['媒体报道', 'reputable_media']
])

function normalizeIndustryPlanWireFormat(value, operations) {
  if (!Array.isArray(value?.['证据需求'])) return value
  for (const [index, requirement] of value['证据需求'].entries()) {
    if (!requirement || typeof requirement !== 'object') continue
    const before = structuredClone(requirement)
    if (typeof requirement.query_terms === 'string' && requirement.query_terms.trim()) {
      requirement.query_terms = [requirement.query_terms.trim()]
    }
    if (Array.isArray(requirement.preferred_source_types)) {
      requirement.preferred_source_types = requirement.preferred_source_types.map(item => SOURCE_TYPE_ALIASES.get(String(item)) || item)
    }
    if (canonicalJson(before) !== canonicalJson(requirement)) operations.push({ type: 'SAFE_NORMALIZATION', operation: 'canonicalize_evidence_requirement', field: `证据需求[${index}]`, before, after: structuredClone(requirement) })
  }
  return value
}


module.exports = { usesEnterpriseProtocol, recoverEnterpriseOutput, adaptEnterpriseOutput }
