const cheerio = require('cheerio')
const { PublicHttpClient } = require('./http-client')
const { cleanText, createEvidence, normalizeDate } = require('./evidence')
const { rankSearchCandidatesWithJev } = require('./jev-prefilter')

class SearxngSiteAdapter {
  constructor({ source, searchBackend, httpClient = new PublicHttpClient() } = {}) {
    if (!source?.id || !source?.allowed_hosts?.length) throw new Error('configured source id and allowed_hosts are required')
    if (!searchBackend?.enabled || !searchBackend.endpoint) throw new Error('enabled SearXNG endpoint is required')
    this.id = source.id
    this.source = structuredClone(source)
    this.searchBackend = structuredClone(searchBackend)
    this.http = httpClient
  }

  async collect({ query, start_date: startDate, end_date: endDate, max_records: maxRecords = 6 }) {
    if (!String(query || '').trim()) throw new Error('configured website search query is required')
    const start = startDate ? normalizeDate(startDate) : null
    const end = normalizeDate(endDate)
    const endpoint = new URL(this.searchBackend.endpoint)
    if (!endpoint.pathname.replace(/\/$/, '').endsWith('/search')) endpoint.pathname = `${endpoint.pathname.replace(/\/$/, '')}/search`.replace(/\/\//g, '/')
    endpoint.searchParams.set('q', `site:${this.source.allowed_hosts[0]} ${String(query).trim()}`)
    endpoint.searchParams.set('format', 'json')
    endpoint.searchParams.set('language', 'zh-CN')
    const localSearch = ['127.0.0.1', 'localhost', '::1'].includes(endpoint.hostname.toLowerCase())
    const data = await this.http.json(endpoint, {
      allowLocalhost: localSearch,
      allowedHosts: localSearch ? null : [endpoint.hostname],
      minimumIntervalMs: 350,
      maxRetries: 2
    })
    const found = (data.results || [])
      .map(item => ({ ...item, url: safeResultUrl(item.url, this.source.allowed_hosts) }))
      .filter(item => item.url)
      .slice(0, Math.max(Number(maxRecords) * 3, Number(maxRecords)))
    const { candidates, preliminary } = await rankSearchCandidatesWithJev(query, found, { enabled: this.searchBackend.jev_prefilter_enabled === true })
    const evidence = []
    const failures = []
    for (const candidate of candidates) {
      if (evidence.length >= Number(maxRecords)) break
      try {
        const page = await this.http.text(candidate.url, {
          allowedHosts: this.source.allowed_hosts,
          minimumIntervalMs: 500,
          maxRetries: 1
        })
        const extracted = extractPublicPage(page.text, candidate)
        if (!extracted.published_at) {
          failures.push({ source_url: candidate.url, code: 'PUBLICATION_DATE_MISSING', message: '公开页面缺少可验证发布日期' })
          continue
        }
        if ((start && extracted.published_at < start) || extracted.published_at > end) continue
        if (extracted.summary.length < 80) {
          failures.push({ source_url: candidate.url, code: 'CONTENT_TOO_SHORT', message: '公开页面正文不足' })
          continue
        }
        evidence.push(createEvidence({
          id: `${this.id}:${candidate.url}`,
          sourceType: this.source.source_type,
          publisher: this.source.label,
          sourceUrl: candidate.url,
          title: extracted.title,
          summary: extracted.summary.slice(0, 6000),
          publishedAt: extracted.published_at,
          evidenceGrade: 'C',
          content: page.text,
          metadata: {
            source_id: this.id,
            data_category: this.source.data_category,
            discovery_method: 'searxng_site_search',
            configured_by_user: true,
            requires_independent_confirmation: true,
            content_hash_scope: 'source_html_bytes',
            jev_preliminary_relevance: candidate.jev_preliminary_relevance ?? null
          }
        }))
      } catch (error) {
        failures.push({ source_url: candidate.url, code: error.code || 'CONFIGURED_SITE_FETCH_FAILED', message: error.message })
      }
    }
    return { source_id: this.id, evidence, failures, total_available: candidates.length, preliminary_jev: preliminary }
  }
}

function createConfiguredSourceAdapters(config, options = {}) {
  if (!config?.search_backend?.enabled || !config.search_backend.endpoint) return {}
  return Object.fromEntries((config.websites || [])
    .filter(source => source.enabled !== false && source.adapter === 'searxng_site')
    .map(source => [source.id, new SearxngSiteAdapter({ source, searchBackend: config.search_backend, ...options })]))
}

function safeResultUrl(value, allowedHosts) {
  try {
    const url = new URL(String(value || ''))
    if (url.protocol !== 'https:') return null
    if (!allowedHosts.some(host => url.hostname === host || url.hostname.endsWith(`.${host}`))) return null
    url.hash = ''
    return url.href
  } catch { return null }
}

function extractPublicPage(html, fallback = {}) {
  const $ = cheerio.load(html)
  $('script,style,noscript,nav,header,footer,form').remove()
  const title = cleanText($('meta[property="og:title"]').attr('content') || $('h1').first().text() || $('title').text() || fallback.title)
  const published = firstDate([
    $('meta[property="article:published_time"]').attr('content'),
    $('meta[name="pubdate"]').attr('content'),
    $('meta[name="date"]').attr('content'),
    $('time[datetime]').first().attr('datetime'),
    jsonLdPublishedDate($),
    fallback.publishedDate,
    fallback.published_date
  ])
  const selectors = ['article', 'main', '.article', '.content', '.pages_content', '#UCAP-CONTENT', '#zoom', 'body']
  let summary = ''
  for (const selector of selectors) {
    const text = cleanText($(selector).first().text())
    if (text.length > summary.length) summary = text
    if (summary.length >= 500) break
  }
  return { title: title || cleanText(fallback.title) || '公开网页', published_at: published, summary }
}

function jsonLdPublishedDate($) {
  for (const node of $('script[type="application/ld+json"]').toArray()) {
    try {
      const value = JSON.parse($(node).text())
      const records = Array.isArray(value) ? value : [value]
      for (const record of records) if (record?.datePublished) return record.datePublished
    } catch {}
  }
  return null
}

function firstDate(values) {
  for (const value of values) {
    const match = String(value || '').match(/(20\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})/)
    if (!match) continue
    try { return normalizeDate(`${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`) } catch {}
  }
  return null
}

module.exports = { SearxngSiteAdapter, createConfiguredSourceAdapters, extractPublicPage, safeResultUrl }
