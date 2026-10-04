const fs = require('node:fs/promises')
const path = require('node:path')
const { CninfoAdapter } = require('./sources/cninfo-adapter')
const { GdeltAdapter } = require('./sources/gdelt-adapter')
const { GovernmentPolicyAdapter } = require('./sources/government-policy-adapter')
const { createConfiguredSourceAdapters } = require('./sources/searxng-site-adapter')
const { SearxngWebAdapter } = require('./sources/searxng-web-adapter')
const { createUserJsonApiAdapters } = require('./sources/user-json-api-adapter')
const { ManualAssistanceService } = require('./manual-assistance')
const { isCalendarDate, sha256, writeJsonAtomic } = require('./utils')
const { withFileLock } = require('./file-lock')

const EMPTY_SHA256 = sha256(Buffer.alloc(0))

class PublicSourceCollector {
  constructor({ adapters, userSourceConfig = null, snapshotDirectory = path.resolve('.runtime', 'evidence-snapshots'), manualAssistance } = {}) {
    const builtInAdapters = {
      cninfo: new CninfoAdapter(),
      government_policy: new GovernmentPolicyAdapter(),
      gdelt: new GdeltAdapter()
    }
    this.adapters = adapters || { ...builtInAdapters, ...(userSourceConfig?.search_backend?.enabled ? { web_search: new SearxngWebAdapter({ searchBackend: userSourceConfig.search_backend }) } : {}), ...createConfiguredSourceAdapters(userSourceConfig), ...createUserJsonApiAdapters(userSourceConfig) }
    this.snapshotDirectory = path.resolve(snapshotDirectory)
    this.manualAssistance = manualAssistance || new ManualAssistanceService({ snapshotDirectory: this.snapshotDirectory })
  }

  async collect(request) {
    validateCollectionRequest(request)
    const results = []
    for (const query of request.queries || []) {
      results.push(await this.collectOne(query, request.as_of_date, { collectionRequestId: request.request_id, company: request.company }))
    }
    const eligible = []
    const quarantined = []
    for (const result of results) {
      for (const item of result.evidence || []) {
        if (item.published_at > request.as_of_date) quarantined.push({ ...item, quarantine_reason: 'after_as_of_date' })
        else eligible.push(item)
      }
    }
    const evidence = await this.persistSnapshots(deduplicateEvidence(eligible))
    const manualAssistanceRequests = results
      .filter(result => result.assistance)
      .map(result => result.assistance)
    const requiredFailures = requiredQueryFailures(request.queries, results, quarantined)
    const packet = {
      contract_version: '1.0.0',
      status: manualAssistanceRequests.length
        ? 'awaiting_manual_assistance'
        : requiredFailures.length ? 'incomplete' : 'complete',
      request_id: request.request_id,
      company: request.company,
      as_of_date: request.as_of_date,
      public_information_only: true,
      query_templates: structuredClone(request.queries),
      evidence,
      snapshot_root: this.snapshotDirectory,
      quarantined,
      manual_assistance_requests: manualAssistanceRequests,
      required_failures: requiredFailures,
      planned_coverage_gaps: structuredClone(request.planned_coverage_gaps || []),
      source_runs: results.map(result => ({
        source_id: result.source_id,
        query_id: result.query_id || null,
        query_origin: result.query_origin || null,
        requirement_id: result.requirement_id || null,
        claim_scope: result.claim_scope || null,
        status: result.status,
        evidence_count: result.evidence?.length || 0,
        total_available: result.total_available || 0,
        preliminary_jev: result.preliminary_jev || null,
        failures: result.failures || [],
        error: result.error || null,
        assistance: result.assistance || null
      })),
      created_at: new Date().toISOString()
    }
    packet.packet_sha256 = sha256(packet)
    return packet
  }

  async persistSnapshots(items) {
    await fs.mkdir(this.snapshotDirectory, { recursive: true })
    const output = []
    for (const rawItem of items) {
      if (rawItem.snapshot_ref) {
        const expectedRef = `${rawItem.content_sha256}.bin`
        if (path.basename(rawItem.snapshot_ref) !== expectedRef) throw new Error(`collector evidence ${rawItem.id} has invalid content-addressed snapshot_ref`)
        const existing = await fs.readFile(path.join(this.snapshotDirectory, expectedRef))
        if (existing.length === 0 || rawItem.content_sha256 === EMPTY_SHA256) throw new Error(`collector evidence ${rawItem.id} has an empty snapshot`)
        if (sha256(existing) !== rawItem.content_sha256) throw new Error(`collector evidence ${rawItem.id} persisted snapshot hash mismatch`)
        output.push(structuredClone(rawItem))
        continue
      }
      const hasSourcePayload = Boolean(rawItem._snapshot_base64)
      const bytes = hasSourcePayload
        ? Buffer.from(rawItem._snapshot_base64, 'base64')
        : Buffer.from(JSON.stringify({ title: rawItem.title, summary: rawItem.summary, source_url: rawItem.source_url, published_at: rawItem.published_at }))
      if (bytes.length === 0 || rawItem.content_sha256 === EMPTY_SHA256) throw new Error(`collector evidence ${rawItem.id} has an empty snapshot`)
      if (hasSourcePayload && sha256(bytes) !== rawItem.content_sha256) throw new Error(`collector evidence ${rawItem.id} snapshot hash mismatch before persist`)
      const item = hasSourcePayload ? rawItem : {
        ...rawItem,
        evidence_grade: ['A', 'B'].includes(rawItem.evidence_grade) ? 'C' : rawItem.evidence_grade,
        metadata_only: true,
        content_sha256: sha256(bytes),
        snapshot_fallback_reason: 'adapter_did_not_return_source_bytes'
      }
      const snapshotRef = `${item.content_sha256}.bin`
      const target = path.join(this.snapshotDirectory, snapshotRef)
      try {
        const existing = await fs.readFile(target)
        if (sha256(existing) !== item.content_sha256) throw new Error(`content-address collision for ${item.id}`)
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
        const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`
        await fs.writeFile(temporary, bytes)
        await fs.rename(temporary, target)
      }
      const sanitized = { ...item, snapshot_ref: snapshotRef }
      delete sanitized._snapshot_base64
      output.push(sanitized)
    }
    const indexPath = path.join(this.snapshotDirectory, 'index.json')
    await withFileLock(`${indexPath}.lock`, async () => {
      let existing = { snapshots: [] }
      try { existing = JSON.parse(await fs.readFile(indexPath, 'utf8')) } catch (error) { if (error.code !== 'ENOENT') throw error }
      const merged = new Map((existing.snapshots || []).map(item => [`${item.id}|${item.content_sha256}`, item]))
      for (const item of output) merged.set(`${item.id}|${item.content_sha256}`, { id: item.id, content_sha256: item.content_sha256, snapshot_ref: item.snapshot_ref })
      await writeJsonAtomic(indexPath, {
        contract_version: '1.0.0',
        updated_at: new Date().toISOString(),
        snapshots: [...merged.values()].sort((left, right) => left.id.localeCompare(right.id) || left.content_sha256.localeCompare(right.content_sha256))
      })
    })
    return output
  }

  async collectOne(query, asOfDate, context = {}) {
    const adapter = this.adapters[query.source_id]
    if (!adapter) {
      const manual = await this.requestManualAssistance(query, asOfDate, context, 'no_automatic_adapter_configured')
      if (manual) return bindQueryAudit(manual, query)
      return bindQueryAudit({ source_id: query.source_id, status: 'unsupported', evidence: [], error: 'no adapter configured' }, query)
    }
    try {
      const result = await adapter.collect({ ...query, end_date: query.end_date || asOfDate })
      return {
        ...result,
        query_id: query.query_id || null,
        query_origin: query.query_origin || null,
        requirement_id: query.requirement_id || null,
        claim_scope: query.claim_scope || null,
        status: result.failures?.length ? 'partial' : 'available'
      }
    } catch (error) {
      if (error.code === 'SITE_CONTROL_BLOCKED') {
        const manual = await this.requestManualAssistance(query, asOfDate, context, 'automatic_access_blocked_by_site_control')
        if (manual) return bindQueryAudit(manual, query)
      }
      return {
        source_id: query.source_id,
        query_id: query.query_id || null,
        query_origin: query.query_origin || null,
        requirement_id: query.requirement_id || null,
        claim_scope: query.claim_scope || null,
        status: error.code === 'SITE_CONTROL_BLOCKED' ? 'blocked_by_site_control' : error.code === 'RATE_LIMITED' ? 'rate_limited' : 'failed',
        evidence: [],
        failures: [],
        error: { code: error.code || 'COLLECTION_FAILED', message: error.message }
      }
    }
  }

  async requestManualAssistance(query, asOfDate, context, reason) {
    if (!this.manualAssistance) return null
    const resolution = await this.manualAssistance.resolveOrRequest({
      collectionRequestId: context.collectionRequestId,
      company: context.company,
      query,
      asOfDate,
      reason
    })
    if (!resolution) return null
    if (resolution.status === 'ready') {
      return { source_id: query.source_id, status: 'available', evidence: [resolution.evidence], total_available: 1, failures: [] }
    }
    return {
      source_id: query.source_id,
      status: 'manual_assistance_required',
      evidence: [],
      total_available: 0,
      failures: [],
      assistance: {
        assistance_id: resolution.request.assistance_id,
        source_id: query.source_id,
        status: resolution.request.status,
        request_path: resolution.request_path,
        response_template_path: resolution.response_template_path
      }
    }
  }
}

function bindQueryAudit(result, query) {
  return {
    ...result,
    query_id: query.query_id || null,
    query_origin: query.query_origin || null,
    requirement_id: query.requirement_id || null,
    claim_scope: query.claim_scope || null
  }
}

function requiredQueryFailures(queries, results, quarantined) {
  const failures = []
  for (let index = 0; index < queries.length; index += 1) {
    const query = queries[index]
    if (query.required !== true) continue
    const result = results[index]
    const sourceEvidence = results
      .filter(candidate => candidate.source_id === query.source_id)
      .flatMap(candidate => candidate.evidence || [])
      .filter(item => !quarantined.some(blocked => blocked.id === item.id))
    const eligibleCount = new Set(sourceEvidence.map(item => `${item.id}|${item.content_sha256 || ''}`)).size
    const minimum = Math.max(1, Number(query.min_evidence || 1))
    const sourceAvailable = results.some(candidate => candidate.source_id === query.source_id && ['available', 'partial'].includes(candidate.status))
    if (!sourceAvailable || eligibleCount < minimum) {
      failures.push({ source_id: query.source_id, data_category: query.data_category || null, status: sourceAvailable ? 'available' : result.status, eligible_count: eligibleCount, min_evidence: minimum })
    }
  }
  return failures
}

function validateCollectionRequest(request) {
  if (!request || request.contract_version !== '1.0.0') throw new Error('collection request contract_version must be 1.0.0')
  if (!String(request.request_id || '').trim()) throw new Error('collection request_id is required')
  if (!request.company?.id || !request.company?.name) throw new Error('collection company.id and company.name are required')
  if (!isCalendarDate(request.as_of_date)) throw new Error('collection as_of_date must be a real YYYY-MM-DD date')
  if (!Array.isArray(request.queries) || request.queries.length === 0) throw new Error('collection queries are required')
  for (const query of request.queries) {
    if (!query.source_id) throw new Error('each collection query needs source_id')
    if (query.start_date && !isCalendarDate(query.start_date)) throw new Error(`query ${query.source_id} start_date is invalid`)
    if (query.end_date && !isCalendarDate(query.end_date)) throw new Error(`query ${query.source_id} end_date is invalid`)
    if (query.end_date && query.end_date > request.as_of_date) throw new Error(`query ${query.source_id} end_date exceeds as_of_date`)
    if (query.start_date && query.end_date && query.start_date > query.end_date) throw new Error(`query ${query.source_id} date range is inverted`)
  }
}

function deduplicateEvidence(items) {
  const byKey = new Map()
  for (const item of items) {
    const key = `${canonicalUrl(item.source_url)}|${String(item.content_sha256 || '').toLowerCase()}`
    const existing = byKey.get(key)
    if (!existing) {
      byKey.set(key, item)
      continue
    }
    const preferred = item.published_at < existing.published_at ? item : existing
    const duplicate = preferred === item ? existing : item
    byKey.set(key, {
      ...preferred,
      duplicate_source_urls: [...new Set([...(preferred.duplicate_source_urls || []), duplicate.source_url])]
    })
  }
  return [...byKey.values()].sort((left, right) => right.published_at.localeCompare(left.published_at) || left.id.localeCompare(right.id))
}

function canonicalUrl(value) {
  try {
    const url = new URL(value)
    url.hash = ''
    url.hostname = url.hostname.toLowerCase()
    return url.href
  } catch {
    return String(value || '').trim()
  }
}

module.exports = { PublicSourceCollector, canonicalUrl, deduplicateEvidence, requiredQueryFailures, validateCollectionRequest }
const crypto = require('node:crypto')
