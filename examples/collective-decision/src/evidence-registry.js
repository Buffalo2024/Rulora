const { validatePublicUrl } = require('./sources/http-client')
const fs = require('node:fs/promises')
const path = require('node:path')
const { sha256 } = require('./utils')

const GRADE_RANK = Object.freeze({ A: 0, B: 1, C: 2, D: 3 })
const EMPTY_SHA256 = sha256(Buffer.alloc(0))

function buildSourceRegistry(config) {
  const sources = Array.isArray(config?.sources) ? config.sources : []
  return new Map(sources.map(source => [source.id, source]))
}

function validateEvidenceRegistry(evidence, { asOfDate, sourceConfig, productionMode = false } = {}) {
  const errors = []
  const registry = buildSourceRegistry(sourceConfig)
  const identities = new Set()
  const origins = new Set()
  for (const item of evidence || []) {
    const label = item?.id || '?'
    const sourceId = String(item?.source_id || '').trim()
    const source = registry.get(sourceId)
    if (productionMode && !source) {
      errors.push(`evidence ${label} source_id is not registered: ${sourceId || '(missing)'}`)
      continue
    }
    if (!source) continue
    const validatedManualImport = item.ingestion_mode === 'validated_manual_import' && source.manual_import_enabled === true
    if (productionMode && source.production_ingest_enabled !== true && !validatedManualImport) errors.push(`evidence ${label} source ${sourceId} is not enabled for production ingestion`)
    identities.add(sourceId)
    if (item.source_type !== source.source_type) errors.push(`evidence ${label} source_type does not match registry`)
    if (GRADE_RANK[item.evidence_grade] < GRADE_RANK[source.default_grade]) {
      errors.push(`evidence ${label} grade cannot be stronger than registry default ${source.default_grade}`)
    }
    const hostname = safeHostname(item.source_url, source.http_allowed_hosts || [])
    if (productionMode && !hostname) errors.push(`evidence ${label} must use a valid public HTTPS URL or explicitly allowed HTTP URL`)
    const allowed = allowedHosts(source)
    if (productionMode && !source.allow_external_article_hosts && allowed.size && hostname && !hostMatches(hostname, allowed)) {
      errors.push(`evidence ${label} URL host is outside source registry`)
    }
    origins.add(`${sourceId}|${normalizePublisher(item.publisher)}|${hostname || 'unknown'}`)
    if (productionMode && !validTimestamp(item.retrieved_at)) errors.push(`evidence ${label} retrieved_at must be an ISO timestamp`)
    if (productionMode && !String(item.snapshot_ref || '').trim()) errors.push(`evidence ${label} lacks snapshot_ref`)
    if (productionMode && (!String(item.content_sha256 || '').match(/^[a-f0-9]{64}$/i) || item.content_sha256 === EMPTY_SHA256)) errors.push(`evidence ${label} lacks a non-empty snapshot hash`)
    if (productionMode && item.metadata_only === true && ['A', 'B'].includes(item.evidence_grade)) {
      errors.push(`metadata-only evidence ${label} cannot be grade ${item.evidence_grade}`)
    }
  }
  const minimum = Number(sourceConfig?.policy?.minimum_independent_registered_sources || sourceConfig?.policy?.minimum_distinct_source_types || 2)
  if (productionMode && identities.size < minimum) errors.push(`at least ${minimum} independent registered sources are required`)
  if (productionMode && origins.size < minimum) errors.push(`at least ${minimum} independent publisher/origin combinations are required`)
  return errors
}

async function verifyEvidenceSnapshots(evidence, { snapshotRoot, productionMode = false } = {}) {
  const errors = []
  for (const item of evidence || []) {
    if (!item.snapshot_ref) continue
    const expectedName = `${item.content_sha256}.bin`
    const reference = String(item.snapshot_ref)
    if (path.basename(reference) !== expectedName) {
      errors.push(`evidence ${item.id} snapshot_ref is not content-addressed`)
      continue
    }
    const resolved = path.resolve(snapshotRoot || '.', reference)
    const root = path.resolve(snapshotRoot || '.')
    if (resolved !== path.join(root, expectedName)) {
      errors.push(`evidence ${item.id} snapshot_ref escapes snapshot root`)
      continue
    }
    try {
      const content = await fs.readFile(resolved)
      if (content.length === 0 || item.content_sha256 === EMPTY_SHA256) errors.push(`evidence ${item.id} snapshot is empty`)
      if (sha256(content) !== item.content_sha256) errors.push(`evidence ${item.id} snapshot hash mismatch`)
    } catch (error) {
      errors.push(`evidence ${item.id} snapshot unavailable: ${error.code || error.message}`)
    }
  }
  if (productionMode) {
    for (const item of evidence || []) if (!item.snapshot_ref) errors.push(`evidence ${item.id} has no verifiable snapshot`)
  }
  return [...new Set(errors)]
}

function allowedHosts(source) {
  const hosts = new Set(source.allowed_hosts || [])
  for (const value of [source.base_url, ...(source.related_urls || [])]) {
    const hostname = safeHostname(value)
    if (hostname) hosts.add(hostname)
  }
  return hosts
}

function safeHostname(value, httpAllowedHosts = []) {
  try { return validatePublicUrl(value, false, null, httpAllowedHosts).hostname.toLowerCase() } catch { return null }
}

function hostMatches(hostname, allowed) {
  return [...allowed].some(host => hostname === host || hostname.endsWith(`.${host}`))
}

function normalizePublisher(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, '')
}

function validTimestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(value)) return false
  return !Number.isNaN(Date.parse(value))
}

module.exports = { GRADE_RANK, buildSourceRegistry, validateEvidenceRegistry, verifyEvidenceSnapshots }
