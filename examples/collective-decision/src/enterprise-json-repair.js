// Diagnostic feedback only: never parse a substring, salvage a candidate or alter business fields.
const { canonicalJson } = require('./utils')
const VERSION = '1.0.0'
function syntaxDiagnostic(raw) {
  if (typeof raw !== 'string') return null
  let text = raw.trim()
  const fence = text.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i)
  if (fence) text = fence[1].trim()
  try { JSON.parse(text); return null } catch (error) {
    const position = Number(error.message.match(/position\s+(\d+)/)?.[1])
    if (!Number.isInteger(position) || position < 0 || position > text.length) return { version: VERSION, kind: 'invalid_json', complete_object_boundary: text.startsWith('{') && text.endsWith('}') }
    const start = text.lastIndexOf('\n', position - 1) + 1
    const lineText = text.slice(start, text.indexOf('\n', position) < 0 ? text.length : text.indexOf('\n', position))
    const property = [...text.slice(0,position).matchAll(/"([A-Za-z_][\w]*)"\s*:\s*"/g)].at(-1)
    const field = property?.[1] || null
    const propertyText = property ? lineText.slice(Math.max(0,property.index-start)) : lineText
    const quotes = [...propertyText.matchAll(/(?<!\\)(?:\\\\)*"/g)].length
    const preceding = text.slice(start, position).trimEnd().at(-1)
    const quoteError = Boolean(field && quotes >= 5 && preceding === '"' && !/[}\],]/.test(text[position] || ''))
    return { version: VERSION, kind: quoteError ? 'suspected_unescaped_quote' : 'invalid_json', position,
      line: text.slice(0, position).split('\n').length, column: position - start + 1, field,
      complete_object_boundary: text.startsWith('{') && text.endsWith('}') }
  }
}
function nextCandidateRepair({ attempt, errors, firstErrors, value, rawOutput, seatRepair }) {
  const diagnostic = value == null ? syntaxDiagnostic(rawOutput) : null
  const targetedExtra = seatRepair && diagnostic?.kind === 'suspected_unescaped_quote' && diagnostic.complete_object_boundary
  if (!(attempt === 0 || (seatRepair && attempt === 1 && (targetedExtra || canonicalJson(errors) !== canonicalJson(firstErrors))))) return null
  return { mode: diagnostic ? 'format_only' : 'contract_repair', errors, previous_output: value ?? rawOutput ?? null,
    ...(diagnostic ? { syntax_diagnostic: diagnostic } : {}),
    ...(seatRepair && value ? { feedback: require('./enterprise-candidate-feedback').candidateFeedback(value, { errors }) } : {}) }
}
module.exports = { VERSION, syntaxDiagnostic, nextCandidateRepair }
