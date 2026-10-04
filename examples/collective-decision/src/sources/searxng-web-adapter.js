const { PublicHttpClient, validatePublicUrl } = require('./http-client')
const { createEvidence } = require('./evidence')
const { extractPublicPage } = require('./searxng-site-adapter')
const { sha256 } = require('../utils')
const { rankSearchCandidatesWithJev } = require('./jev-prefilter')

class SearxngWebAdapter {
  constructor({ searchBackend, httpClient = new PublicHttpClient() } = {}) {
    if (!searchBackend?.enabled || !searchBackend.endpoint) throw new Error('enabled SearXNG endpoint is required')
    this.id = 'web_search'
    this.searchBackend = structuredClone(searchBackend)
    this.http = httpClient
  }

  async collect({ query, start_date: startDate, end_date: endDate, max_records: maxRecords = 5 }) {
    if (!String(query || '').trim()) throw new Error('web search query is required')
    const endpoint = new URL(this.searchBackend.endpoint)
    if (!endpoint.pathname.replace(/\/$/, '').endsWith('/search')) endpoint.pathname = `${endpoint.pathname.replace(/\/$/, '')}/search`
    endpoint.searchParams.set('q', String(query).trim())
    endpoint.searchParams.set('format', 'json')
    endpoint.searchParams.set('language', 'zh-CN')
    const local = ['127.0.0.1', 'localhost', '::1'].includes(endpoint.hostname.toLowerCase())
    const data = await this.http.json(endpoint, { allowLocalhost: local, allowedHosts: local ? null : [endpoint.hostname], maxRetries: 2 })
    const limit = Math.min(Math.max(Number(maxRecords) || 5, 1), 8)
    const found = (data.results || []).slice(0, limit * 4)
    const { candidates, preliminary } = await rankSearchCandidatesWithJev(query, found, { enabled: this.searchBackend.jev_prefilter_enabled === true })
    const evidence = []
    const failures = []
    const seen = new Set()
    for (const candidate of candidates) {
      if (evidence.length >= limit) break
      let url
      try {
        url = validatePublicUrl(String(candidate.url || '')).href
        if (seen.has(url)) continue
        seen.add(url)
        const page = await this.http.text(url, { maxRetries: 1, timeoutMs: 20000 })
        if (page.text.length > 2_000_000) throw new Error('public page exceeds the web search text limit')
        const parsed = extractPublicPage(page.text, candidate)
        if (!parsed.published_at || parsed.published_at > endDate || (startDate && parsed.published_at < startDate)) {
          failures.push({ source_url: url, code: 'DATE_UNVERIFIED_OR_OUTSIDE_WINDOW' })
          continue
        }
        if (parsed.summary.length < 80) {
          failures.push({ source_url: url, code: 'CONTENT_TOO_SHORT' })
          continue
        }
        const publisher = new URL(url).hostname.toLowerCase()
        evidence.push(createEvidence({
          id: `web-search:${sha256(url).slice(0, 24)}`,
          sourceType: 'reputable_media', publisher, sourceUrl: url,
          title: parsed.title, summary: parsed.summary.slice(0, 6000),
          publishedAt: parsed.published_at, evidenceGrade: 'C', content: page.text,
          metadata: { source_id: this.id, original_publisher: publisher, original_url: url, discovery_method: 'searxng_public_web', data_category: 'open_web', content_hash_scope: 'source_html_bytes', jev_preliminary_relevance: candidate.jev_preliminary_relevance ?? null }
        }))
      } catch (error) {
        failures.push({ source_url: url || String(candidate.url || ''), code: error.code || 'PUBLIC_PAGE_FETCH_FAILED', message: error.message })
      }
    }
    return { source_id: this.id, evidence, failures, total_available: candidates.length, preliminary_jev: preliminary }
  }
}

module.exports = { SearxngWebAdapter }
