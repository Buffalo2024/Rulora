const { PublicHttpClient } = require('./http-client')
const { cleanText, createEvidence, normalizeDate } = require('./evidence')

class UserJsonApiAdapter {
  constructor({ source, httpClient = new PublicHttpClient() } = {}) {
    if (!source?.id || source.adapter !== 'user_json_api' || !source.api?.endpoint) throw new Error('configured JSON API source is required')
    this.id = source.id
    this.source = structuredClone(source)
    this.http = httpClient
  }

  async collect({ query, start_date: startDate, end_date: endDate, max_records: maxRecords = 6 }) {
    const endpoint = new URL(this.source.api.endpoint)
    for (const [key, value] of Object.entries(this.source.api.static_parameters || {})) endpoint.searchParams.set(key, String(value))
    endpoint.searchParams.set(this.source.api.query_parameter, String(query || '').trim())
    const payload = await this.http.json(endpoint, {
      allowedHosts: this.source.allowed_hosts,
      maximumRedirects: 3,
      minimumIntervalMs: 500,
      maxRetries: 2
    })
    const records = readPath(payload, this.source.api.mapping.items_path)
    if (!Array.isArray(records)) throw apiError('CONFIGURED_API_ITEMS_INVALID', `API items_path没有返回数组：${this.source.api.mapping.items_path}`)
    const start = normalizeDate(startDate)
    const end = normalizeDate(endDate)
    const evidence = []
    const failures = []
    for (const [index, record] of records.slice(0, Math.max(Number(maxRecords) * 3, Number(maxRecords))).entries()) {
      if (evidence.length >= Number(maxRecords)) break
      try {
        const mapped = mapRecord(record, this.source, endpoint, index)
        if (mapped.published_at < start || mapped.published_at > end) continue
        evidence.push(createEvidence({
          id: `${this.id}:${mapped.source_url}:${index}`,
          sourceType: this.source.source_type,
          publisher: this.source.label,
          sourceUrl: mapped.source_url,
          title: mapped.title,
          summary: mapped.summary.slice(0, 6000),
          publishedAt: mapped.published_at,
          evidenceGrade: 'C',
          content: JSON.stringify(record),
          metadata: {
            source_id: this.id,
            data_category: this.source.data_category,
            discovery_method: 'user_configured_json_api',
            configured_by_user: true,
            requires_independent_confirmation: true,
            content_hash_scope: 'mapped_api_record_json'
          }
        }))
      } catch (error) {
        failures.push({ record_index: index, code: error.code || 'CONFIGURED_API_RECORD_INVALID', message: error.message })
      }
    }
    return { source_id: this.id, evidence, failures, total_available: records.length }
  }
}

function createUserJsonApiAdapters(config, options = {}) {
  return Object.fromEntries((config?.websites || [])
    .filter(source => source.enabled !== false && source.adapter === 'user_json_api')
    .map(source => [source.id, new UserJsonApiAdapter({ source, ...options })]))
}

function mapRecord(record, source, endpoint, index) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw apiError('CONFIGURED_API_RECORD_INVALID', `第${index + 1}条API记录不是对象`)
  const mapping = source.api.mapping
  const title = cleanText(readPath(record, mapping.title_field))
  const summaryValue = readPath(record, mapping.summary_field)
  const summary = cleanText(typeof summaryValue === 'string' ? summaryValue : JSON.stringify(summaryValue ?? ''))
  const publishedAt = normalizeDate(String(readPath(record, mapping.published_at_field) || '').slice(0, 10))
  const rawUrl = readPath(record, mapping.url_field)
  const sourceUrl = rawUrl ? new URL(String(rawUrl), endpoint).href : endpoint.href
  const parsed = new URL(sourceUrl)
  if (parsed.protocol !== 'https:' || !source.allowed_hosts.some(host => parsed.hostname === host || parsed.hostname.endsWith(`.${host}`))) {
    throw apiError('CONFIGURED_API_RECORD_URL_INVALID', 'API记录链接不属于配置来源域名')
  }
  if (!title || !summary) throw apiError('CONFIGURED_API_RECORD_INCOMPLETE', 'API记录缺少标题或正文摘要')
  return { title, summary, published_at: publishedAt, source_url: parsed.href }
}

function readPath(value, pathExpression) {
  const keys = String(pathExpression || '').replace(/^\$\.?/, '').replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean)
  let current = value
  for (const key of keys) current = current == null ? undefined : current[key]
  return current
}

function apiError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

module.exports = { UserJsonApiAdapter, createUserJsonApiAdapters, mapRecord, readPath }
