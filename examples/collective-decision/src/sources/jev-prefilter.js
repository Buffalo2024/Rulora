const { modelFetch, DEFAULT_MODEL_TIMEOUT_MS } = require('../model-http')
const crypto = require('node:crypto')
const { persistLlmOutputTrace } = require('../llm-output-trace')
const { recoverEnterpriseOutput, adaptEnterpriseOutput } = require('../enterprise-output-protocol')
const { sha256 } = require('../utils')
const { typeSafeApiKey } = require('./jev-key')

async function screenSearchHitsWithJev(question, evidence, { enabled = false, fetchImpl = modelFetch, apiKey = typeSafeApiKey() } = {}) {
  if (!enabled) return { status: 'disabled', signals: {} }
  if (!apiKey) return { status: 'not_configured', signals: {} }
  const items = (evidence || []).slice(0, 60)
  if (!items.length) return { status: 'no_items', signals: {} }
  const signals = {}
  let model = null
  const audit = []
  for (let offset = 0; offset < items.length; offset += 20) {
    const batch = items.slice(offset, offset + 20)
    const questions = Object.fromEntries(batch.map((item, index) => [`hit_${index}`, {
      type: 'noul',
      instructions: `Is hit_${index} likely relevant to the user's specific enterprise, matter and time horizon? Judge only the listed title and summary, not source truth.`
    }]))
    const trace = { call_id: crypto.randomUUID(), seat: 'jev_prefilter', operation: 'search_candidate_ranking', model: 'jev-latest', status: 'FAILED' }
    try {
      const response = await fetchImpl('https://api.typesafe.ai/v1/systemone', {
        method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'jev-latest', state: { question, hits: batch.map((item, index) => ({ key: `hit_${index}`, title: item.title, summary: item.summary, publisher: item.publisher, published_at: item.published_at })) }, questions }),
        signal: AbortSignal.timeout(DEFAULT_MODEL_TIMEOUT_MS)
      })
      if (!response.ok) { trace.error_code = `HTTP_${response.status}`; continue }
      const raw = typeof response.text === 'function' ? await response.text() : JSON.stringify(await response.json())
      trace.raw_model_response = raw
      trace.raw_response_sha256 = sha256(raw)
      const recovered = recoverEnterpriseOutput(raw)
      trace.recovery_result = recovered.output_recovery
      const body = adaptEnterpriseOutput(recovered.value).value
      trace.adapter_result = body
      trace.core_validation_result = { accepted_ids: [], rejected_ids: [] }
      trace.semantic_review = 'DOWNSTREAM_ENTERPRISE_EVIDENCE_SCREEN'
      trace.status = 'RANKING_ONLY' 
      model = body.model || model
      for (const [index, item] of batch.entries()) {
        const score = body?.answers?.[`hit_${index}`]?.noul
        if (typeof score === 'number' && Number.isFinite(score) && score >= 0 && score <= 1) { signals[item.id] = score; trace.core_validation_result.accepted_ids.push(item.id) }
        else trace.core_validation_result.rejected_ids.push(item.id)
      }
    } catch (error) {
      trace.status = 'FAILED'
      trace.error_code = error.code || 'JEV_UNAVAILABLE'
      trace.error = String(error.message || error)
    } finally {
      try { audit.push({ call_id: trace.call_id, path: await persistLlmOutputTrace(trace), status: trace.status }) }
      catch { // Optional ranking cannot block collection; do not use unaudited scores.
        for (const item of batch) delete signals[item.id]
        audit.push({ call_id: trace.call_id, status: 'AUDIT_WRITE_FAILED' })
      }
    }
  }
  const count = Object.keys(signals).length
  return { status: count === items.length ? 'completed' : count ? 'partial' : 'unavailable', model, signals, audit }
}

async function rankSearchCandidatesWithJev(query, candidates, options = {}) {
  if (options.enabled !== true) return { candidates, preliminary: { status: 'disabled', signals: {} } }
  const items = candidates.map((candidate, index) => ({ id: `candidate_${index}`, title: candidate.title || '', summary: candidate.content || candidate.description || '', publisher: candidate.engine || '' }))
  const preliminary = await screenSearchHitsWithJev({ search_query: String(query || '') }, items, options)
  if (!['completed', 'partial'].includes(preliminary.status)) return { candidates, preliminary }
  const ranked = candidates.map((candidate, index) => ({ ...candidate, jev_preliminary_relevance: preliminary.signals[`candidate_${index}`] ?? null }))
    .sort((left, right) => (right.jev_preliminary_relevance ?? -1) - (left.jev_preliminary_relevance ?? -1))
  return { candidates: ranked, preliminary: { status: preliminary.status, model: preliminary.model, scored_count: Object.keys(preliminary.signals).length, audit: preliminary.audit } }
}

module.exports = { screenSearchHitsWithJev, rankSearchCandidatesWithJev }
