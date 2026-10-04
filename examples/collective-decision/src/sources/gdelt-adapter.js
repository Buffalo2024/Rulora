const { PublicHttpClient } = require('./http-client')
const { cleanText, createEvidence, normalizeDate } = require('./evidence')

class GdeltAdapter {
  constructor({ httpClient = new PublicHttpClient({ minimumIntervalMs: 6000 }) } = {}) {
    this.id = 'gdelt'
    this.http = httpClient
  }

  async collect({ query, start_date: startDate, end_date: endDate, max_records: maxRecords = 10 }) {
    if (!String(query || '').trim()) throw new Error('GDELT query is required and should use English names/terms')
    const start = normalizeDate(startDate)
    const end = normalizeDate(endDate)
    const url = new URL('https://api.gdeltproject.org/api/v2/doc/doc')
    url.searchParams.set('query', String(query).trim())
    url.searchParams.set('mode', 'artlist')
    url.searchParams.set('maxrecords', String(Math.min(Math.max(Number(maxRecords), 1), 75)))
    url.searchParams.set('format', 'json')
    url.searchParams.set('startdatetime', `${start.replace(/-/g, '')}000000`)
    url.searchParams.set('enddatetime', `${end.replace(/-/g, '')}235959`)
    url.searchParams.set('sort', 'datedesc')
    const data = await this.http.json(url, { minimumIntervalMs: 6000, maxRetries: 2, allowedHosts: ['gdeltproject.org'] })
    const evidence = (data.articles || []).map((article, index) => {
      const publishedAt = gdeltDate(article.seendate || article.socialimage || end)
      const sourceUrl = normalizeGdeltArticleUrl(article.url_mobile || article.url)
      const content = JSON.stringify(article)
      return createEvidence({
        id: `gdelt:${sourceUrl}:${index}`,
        sourceType: 'reputable_media',
        publisher: cleanText(article.domain) || 'GDELT indexed publisher',
        sourceUrl,
        title: cleanText(article.title),
        summary: cleanText(`${article.title || ''} ${article.sourcecountry || ''} ${article.language || ''}`),
        publishedAt,
        evidenceGrade: 'C',
        content,
        metadata: {
          source_id: this.id,
          immutable_publication: false,
          data_category: 'supply_chain_event',
          source_country: article.sourcecountry || null,
          language: article.language || null,
          requires_independent_confirmation: true
        }
      })
    })
    return { source_id: this.id, evidence, failures: [], total_available: evidence.length }
  }
}

function normalizeGdeltArticleUrl(value) {
  const url = new URL(String(value || ''))
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error(`GDELT article URL must use HTTP(S): ${value}`)
  url.protocol = 'https:'
  return url.href
}

function gdeltDate(value) {
  const match = String(value || '').match(/^(\d{4})(\d{2})(\d{2})/)
  return match ? `${match[1]}-${match[2]}-${match[3]}` : normalizeDate(value)
}

module.exports = { GdeltAdapter, gdeltDate, normalizeGdeltArticleUrl }
