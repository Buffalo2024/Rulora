const { canonicalJson } = require('./utils')

function recoverCompetitionOutput(raw, { stagePhase = null, operation = null } = {}) {
  const original = String(raw ?? '')
  const decisionBlock = parseFinalDecisionBlock(original, { stagePhase, operation })
  if (decisionBlock) {
    return result(decisionBlock, 'decision_block', false, ['extract_final_decision_block'], canonicalJson(decisionBlock))
  }
  const direct = parseObject(original.trim())
  if (direct) return result(direct, 'json', false, [], original.trim())

  const candidates = []
  const fenced = stripFence(original)
  if (fenced !== original.trim()) candidates.push({ text: fenced, operations: ['strip_markdown_fence'] })
  const extracted = extractUniqueObject(fenced)
  if (extracted && extracted !== fenced) candidates.push({ text: extracted, operations: ['extract_unique_json_object'] })
  if (!candidates.length) candidates.push({ text: fenced, operations: [] })

  for (const candidate of candidates) {
    const parsed = parseObject(candidate.text)
    if (parsed) return result(parsed, 'json_repair', true, candidate.operations, candidate.text)
    let current = candidate.text
    const operations = [...candidate.operations]
    for (const repair of [repairSingleQuotes, repairMissingCommas, repairTrailingCommas, repairClosingDelimiters]) {
      const next = repair(current)
      if (next.text !== current) operations.push(...next.operations)
      current = next.text
      const repaired = parseObject(current)
      if (repaired) return result(repaired, 'json_repair', true, unique(operations), current)
    }
  }

  const markdown = parseMarkdownDecision(original, { stagePhase, operation })
  if (markdown) return result(markdown, 'markdown', true, ['parse_explicit_markdown_decision'], canonicalJson(markdown))
  const error = new Error('model did not return recoverable Competition output')
  error.output_recovery_diagnostic = diagnoseCompetitionRecoveryFailure(original, { stagePhase, operation })
  throw error
}

function parseFinalDecisionBlock(text, { stagePhase = null, operation = null } = {}) {
  if (operation === 'reviewCalibration') return null
  const match = String(text).match(/##\s*FINAL_DECISION\s*\n([\s\S]*?)\n##\s*END_FINAL_DECISION\b/i)
  if (!match) return null
  const block = match[1]
  if (stagePhase === 'decision_direction') {
    const action = block.match(/(?:^|\n)\s*action_candidate\s*:\s*(-1|0|1)\s*(?:\n|$)/i)
    return action ? { action_candidate: Number(action[1]) } : null
  }
  if (stagePhase === 'risk_control_advice') {
    const risk = block.match(/(?:^|\n)\s*risk_control_advice\s*:\s*([^\n]*)/i)
    if (!risk) return null
    const codes = explicitRiskCodes(risk[1])
    return codes === null ? null : { risk_control_advice: codes }
  }
  return null
}

function diagnoseCompetitionRecoveryFailure(raw, { stagePhase = null, operation = null } = {}) {
  const source = String(raw ?? '')
  let jsonParseError = null
  try { JSON.parse(source.trim()) } catch (error) { jsonParseError = String(error.message || error) }
  const detectedFields = []
  const patterns = {
    action_candidate: /\baction_candidate\b|\baction\s*[:=]|经营(?:调整)?方向/i,
    risk_control_advice: /\brisk_control_advice\b|\brisk_set_candidate\b|\brisk_mitigation|风控建议/i,
    conditional_risk_tree: /\brisk_up\b[\s\S]*\brisk_flat\b[\s\S]*\brisk_down\b/i,
    reviewer_action_candidate_id: /selected_action_candidate_id/i,
    reviewer_risk_candidate_id: /selected_risk_candidate_id/i
  }
  for (const [field, pattern] of Object.entries(patterns)) if (pattern.test(source)) detectedFields.push(field)
  const reviewer = operation === 'reviewCalibration'
  const missing = []
  if (reviewer) {
    if (!detectedFields.includes('reviewer_action_candidate_id')) missing.push('selected_action_candidate_id')
    if (!detectedFields.includes('reviewer_risk_candidate_id')) missing.push('selected_risk_candidate_id')
  } else {
    if (stagePhase === 'decision_direction' && !detectedFields.includes('action_candidate')) missing.push('action_candidate')
    if (stagePhase === 'risk_control_advice' && !detectedFields.includes('risk_control_advice')) missing.push('risk_control_advice')
  }
  const attempts = []
  const fenced = stripFence(source)
  if (fenced !== source.trim()) attempts.push('strip_markdown_fence')
  if (extractUniqueObject(fenced) && extractUniqueObject(fenced) !== fenced) attempts.push('extract_unique_json_object')
  let current = extractUniqueObject(fenced) || fenced
  for (const repair of [repairSingleQuotes, repairMissingCommas, repairTrailingCommas, repairClosingDelimiters]) {
    const next = repair(current)
    attempts.push(...next.operations)
    current = next.text
  }
  const classification = detectedFields.includes('conditional_risk_tree') && !/final[_ ]risk[_ ]control[_ ]advice|final[_ ]risk[_ ]set/i.test(source)
    ? 'TYPE_C'
    : detectedFields.some(field => field !== 'conditional_risk_tree') ? 'TYPE_B' : 'TYPE_A'
  return {
    status: 'RECOVERY_FAILED',
    reason: classification === 'TYPE_A' ? 'no explicit core decision field detected'
      : classification === 'TYPE_C' ? 'conditional decision tree detected without an explicit final selection'
        : 'explicit core field detected but deterministic recovery did not produce an accepted object',
    json_parse_error: jsonParseError,
    repair_attempts: unique(attempts),
    detected_fields: detectedFields,
    missing_core_fields: missing,
    classification
  }
}

function parseObject(text) {
  try {
    const value = JSON.parse(text)
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null
  } catch { return null }
}

function stripFence(text) {
  return String(text).trim().replace(/^```(?:json|javascript|js)?\s*/i, '').replace(/\s*```$/, '').trim()
}

function extractUniqueObject(text) {
  const source = String(text).trim()
  const start = source.indexOf('{')
  const end = source.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  const before = source.slice(0, start)
  const after = source.slice(end + 1)
  if (before.includes('{') || after.includes('}')) return null
  return source.slice(start, end + 1).trim()
}

function repairSingleQuotes(text) {
  if (!text.includes("'")) return unchanged(text)
  const replaced = text.replace(/'([^'\\]*(?:\\.[^'\\]*)*)'/g, (_, value) => JSON.stringify(value.replace(/\\'/g, "'")))
  return changed(text, replaced, 'single_quoted_string_to_json_string')
}

function repairMissingCommas(text) {
  let repaired = text.replace(/([}\]"0-9]|true|false|null)\s*(\r?\n\s*)(?="(?:[^"\\]|\\.)*"\s*:)/g, '$1,$2')
  repaired = repaired.replace(/([}\]"0-9]|true|false|null)\s+(?="(?:[^"\\]|\\.)*"\s*:)/g, '$1, ')
  return changed(text, repaired, 'insert_missing_property_comma')
}

function repairTrailingCommas(text) {
  return changed(text, text.replace(/,\s*([}\]])/g, '$1'), 'remove_trailing_comma')
}

function repairClosingDelimiters(text) {
  const stack = []
  let inString = false
  let escaped = false
  for (const character of text) {
    if (inString) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') inString = false
      continue
    }
    if (character === '"') inString = true
    else if (character === '{' || character === '[') stack.push(character)
    else if (character === '}' || character === ']') {
      const expected = character === '}' ? '{' : '['
      if (stack.at(-1) !== expected) return unchanged(text)
      stack.pop()
    }
  }
  if (inString || !stack.length) return unchanged(text)
  const suffix = stack.reverse().map(item => item === '{' ? '}' : ']').join('')
  return changed(text, `${text}${suffix}`, 'append_missing_closing_delimiter')
}

function parseMarkdownDecision(text, { stagePhase = null, operation = null } = {}) {
  const source = String(text)
  const actionMatch = source.match(/(?:^|\n)\s*(?:#{1,6}\s*)?(?:recommended[_ ]action|action(?:_candidate)?|经营调整方向)\s*(?::|=)?\s*(?:\r?\n\s*)?(-1|0|1)\s*(?:$|\n)/im)
  const riskMatch = source.match(/(?:^|\n)\s*(?:#{1,6]\s*)?(?:recommended[_ ]risk[_ ]set|risk(?:_control_advice|_set_candidate)?|风控建议)\s*(?::|=)\s*([^\n]*)/im)
  let risk = null
  if (riskMatch) risk = explicitRiskCodes(riskMatch[1])
  if (risk === null) {
    const header = source.match(/(?:^|\n)\s*(?:#{1,6]\s*)?(?:recommended[_ ]risk[_ ]set|risk|风控建议)\s*:\s*(?:\r?\n)((?:\s*[-*]\s*[1-9]\s*(?:\r?\n|$)){1,4})/im)
    if (header) risk = [...header[1].matchAll(/[-*]\s*([1-9])/g)].map(match => match[1])
  }
  const needsAction = stagePhase === 'decision_direction'
  const needsRisk = stagePhase === 'risk_control_advice'
  const reviewer = operation === 'reviewCalibration'
  if ((needsAction && !actionMatch) || (needsRisk && risk === null) || (reviewer && (!actionMatch || risk === null))) return null
  if (!actionMatch && risk === null) return null
  const challengeMatch = source.match(/(?:^|\n)\s*(?:#{1,6]\s*)?(?:challenge(?:[_ ]level|[_ ]strength)?|挑战等级)\s*(?::|=)?\s*(?:\r?\n\s*)?(HIGH|MEDIUM|LOW|REVIEW)\s*(?:$|\n)/im)
  if (reviewer && !challengeMatch) return null
  return {
    ...(actionMatch ? { action_candidate: Number(actionMatch[1]) } : {}),
    ...(risk !== null ? { risk_control_advice: risk } : {}),
    ...(challengeMatch ? { challenge_level: challengeMatch[1].toUpperCase() } : {})
  }
}

function explicitRiskCodes(value) {
  const trimmed = String(value).trim().replace(/^\[|\]$/g, '').trim()
  if (!trimmed) return []
  const tokens = trimmed.split(/[,，\s]+/).map(item => item.replace(/^['"]|['"]$/g, '')).filter(Boolean)
  if (!tokens.length || tokens.some(item => !/^[1-9]$/.test(item))) return null
  return tokens
}

function result(value, mode, repairApplied, operations, normalizedText) {
  return {
    value,
    normalized_text: normalizedText,
    output_recovery: { mode, repair_applied: repairApplied, operations: unique(operations) }
  }
}
function unchanged(text) { return { text, operations: [] } }
function changed(before, after, operation) { return { text: after, operations: before === after ? [] : [operation] } }
function unique(values) { return [...new Set(values)] }

module.exports = { diagnoseCompetitionRecoveryFailure, recoverCompetitionOutput }
