const fs = require('node:fs/promises')
const path = require('node:path')
const { validatePublicUrl } = require('./sources/http-client')
const { writeJsonAtomic } = require('./utils')

const SOURCE_TYPES = new Set([
  'company_disclosure', 'government_policy', 'government_statistics',
  'government_credit', 'enterprise_registry', 'official_market_data',
  'reputable_media'
])

class UserSourceConfigStore {
  constructor({ filePath, environment = process.env } = {}) {
    if (!filePath) throw new Error('user source config filePath is required')
    this.filePath = path.resolve(filePath)
    this.environment = environment
  }

  async load() {
    let value
    try { value = JSON.parse(await fs.readFile(this.filePath, 'utf8')) } catch (error) {
      if (error.code !== 'ENOENT') throw error
      value = defaultUserSourceConfig(this.environment)
    }
    return normalizeUserSourceConfig(value, this.environment)
  }

  async save(value) {
    const normalized = normalizeUserSourceConfig(value, this.environment)
    await writeJsonAtomic(this.filePath, normalized)
    return normalized
  }
}

function defaultUserSourceConfig(environment = process.env) {
  const endpoint = String(environment.SEARXNG_BASE_URL || '').trim()
  return {
    contract_version: '1.0.0',
    search_backend: { type: 'searxng', enabled: Boolean(endpoint), endpoint, jev_prefilter_enabled: false },
    websites: []
  }
}

function normalizeUserSourceConfig(value, environment = process.env) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid('来源配置必须是JSON对象。')
  const backend = value.search_backend || {}
  const endpoint = String(backend.endpoint || environment.SEARXNG_BASE_URL || '').trim().replace(/\/$/, '')
  if (endpoint) validateSearchEndpoint(endpoint)
  const websites = (value.websites || []).map((item, index) => normalizeWebsite(item, index))
  if (websites.length > 20) throw invalid('最多配置20个公开来源网站。')
  if (new Set(websites.map(item => item.id)).size !== websites.length) throw invalid('来源网站ID不能重复。')
  return {
    contract_version: '1.0.0',
    search_backend: { type: 'searxng', enabled: backend.enabled !== false && Boolean(endpoint), endpoint, jev_prefilter_enabled: backend.jev_prefilter_enabled === true },
    websites
  }
}

function normalizeWebsite(item, index) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) throw invalid(`第${index + 1}个来源网站无效。`)
  const label = String(item.label || '').trim().slice(0, 80)
  if (!label) throw invalid(`第${index + 1}个来源网站缺少名称。`)
  const sourceType = String(item.source_type || '')
  if (!SOURCE_TYPES.has(sourceType)) throw invalid(`来源网站“${label}”的source_type无效。`)
  const connectionType = item.connection_type === 'json_api' || item.adapter === 'user_json_api' ? 'json_api' : 'web_search'
  const url = validatePublicUrl(String(connectionType === 'json_api' ? item.api?.endpoint || item.base_url : item.base_url || '').trim(), false)
  const host = url.hostname.toLowerCase()
  const hostId = host.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  const pathId = url.pathname.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase().slice(0, 18)
  const generatedId = connectionType === 'json_api' ? `user-api-${hostId}${pathId ? `-${pathId}` : ''}` : `user-${hostId}`
  const id = String(item.id || generatedId).toLowerCase()
  if (!/^user-[a-z0-9-]{1,58}$/.test(id)) throw invalid(`来源网站“${label}”的ID无效。`)
  const common = {
    id,
    label,
    allowed_hosts: [host],
    source_type: sourceType,
    data_category: String(item.data_category || sourceType).trim().slice(0, 80),
    enabled: item.enabled !== false,
    connection_type: connectionType,
    default_grade: 'C'
  }
  if (connectionType === 'web_search') return {
    ...common,
    base_url: url.origin,
    adapter: 'searxng_site',
    access_mode: 'public_web_via_user_configured_search'
  }
  return {
    ...common,
    base_url: url.origin,
    adapter: 'user_json_api',
    access_mode: 'user_configured_public_json_api',
    api: normalizeApi(item.api || {}, url, label)
  }
}

function normalizeApi(value, endpoint, label) {
  const mapping = value.mapping || {}
  return {
    endpoint: endpoint.href,
    method: 'GET',
    authentication: 'none',
    query_parameter: safeField(value.query_parameter || 'q', `${label} query_parameter`),
    static_parameters: normalizeStaticParameters(value.static_parameters, label),
    mapping: {
      items_path: safePath(mapping.items_path || 'data', `${label} items_path`),
      title_field: safePath(mapping.title_field || 'title', `${label} title_field`),
      summary_field: safePath(mapping.summary_field || 'summary', `${label} summary_field`),
      published_at_field: safePath(mapping.published_at_field || 'published_at', `${label} published_at_field`),
      url_field: safePath(mapping.url_field || 'url', `${label} url_field`)
    }
  }
}

function normalizeStaticParameters(value, label) {
  if (value == null || value === '') return {}
  const object = typeof value === 'string' ? parseObject(value, label) : value
  if (!object || typeof object !== 'object' || Array.isArray(object)) throw invalid(`来源API“${label}”的固定参数必须是JSON对象。`)
  const entries = Object.entries(object)
  if (entries.length > 20) throw invalid(`来源API“${label}”的固定参数不能超过20项。`)
  return Object.fromEntries(entries.map(([key, raw]) => {
    const normalizedKey = safeField(key, `${label} static parameter`)
    if (!['string', 'number', 'boolean'].includes(typeof raw)) throw invalid(`来源API“${label}”的固定参数只能是字符串、数字或布尔值。`)
    return [normalizedKey, raw]
  }))
}

function parseObject(value, label) {
  try { return JSON.parse(value) } catch { throw invalid(`来源API“${label}”的固定参数不是合法JSON。`) }
}

function safeField(value, label) {
  const normalized = String(value || '').trim()
  if (!/^[A-Za-z_][A-Za-z0-9_.-]{0,79}$/.test(normalized)) throw invalid(`${label}无效。`)
  return normalized
}

function safePath(value, label) {
  const normalized = String(value || '').trim()
  if (!/^[A-Za-z0-9_$.\[\]-]{1,160}$/.test(normalized)) throw invalid(`${label}无效。`)
  return normalized
}

function validateSearchEndpoint(value) {
  const url = new URL(value)
  const local = ['127.0.0.1', 'localhost', '::1'].includes(url.hostname.toLowerCase())
  if (local && url.protocol === 'http:') return true
  validatePublicUrl(url, false)
  return true
}

function invalid(message) {
  const error = new Error(message)
  error.statusCode = 400
  error.code = 'INVALID_SOURCE_CONFIG'
  return error
}

module.exports = { SOURCE_TYPES, UserSourceConfigStore, defaultUserSourceConfig, normalizeUserSourceConfig }
