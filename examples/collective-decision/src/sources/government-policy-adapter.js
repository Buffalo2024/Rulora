const cheerio = require('cheerio')
const { PublicHttpClient } = require('./http-client')
const { cleanText, createEvidence, normalizeDate } = require('./evidence')

class GovernmentPolicyAdapter {
  constructor({ httpClient = new PublicHttpClient() } = {}) {
    this.id = 'government_policy'
    this.http = httpClient
  }

  async collect({
    query,
    start_date: startDate,
    end_date: endDate,
    max_records: maxRecords = 8,
    fetch_documents: fetchDocuments = true,
    required_terms: requiredTerms = []
  }) {
    if (!String(query || '').trim()) throw new Error('government policy query is required')
    const start = normalizeDate(startDate)
    const end = normalizeDate(endDate)
    const url = new URL('https://sousuo.www.gov.cn/search-gov/data')
    const params = {
      t: 'zhengcelibrary',
      q: String(query).trim(),
      timetype: 'timezd',
      mintime: start,
      maxtime: end,
      sort: 'pubtime',
      sortType: '1',
      searchfield: 'title:content:summary',
      p: '1',
      n: String(Math.min(Math.max(Number(maxRecords) * 4, 5), 20)),
      dup: '',
      orpro: ''
    }
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)
    const data = await this.http.json(url, {
      headers: { referer: 'https://sousuo.www.gov.cn/zcwjk/policyDocumentLibrary' },
      allowedHosts: ['gov.cn'],
      minimumIntervalMs: 800
    })
    if (Number(data.code) !== 200) throw new Error(`government policy API returned code ${data.code}`)
    const records = flattenPolicyRecords(data.searchVO)
    const evidence = []
    const failures = []
    for (const record of records) {
      if (evidence.length >= Number(maxRecords)) break
      let content = cleanText(record.summary)
      let contentStatus = 'search_excerpt'
      let snapshotContent = JSON.stringify(record)
      let retrievedUrl = null
      if (fetchDocuments) {
        try {
          const page = await this.http.text(record.url, { minimumIntervalMs: 800, allowedHosts: ['gov.cn'], httpAllowedHosts: ['gov.cn'] })
          retrievedUrl = page.response?.url || record.url
          snapshotContent = page.text
          content = extractGovernmentPageText(page.text) || content
          contentStatus = content ? 'full_text_extracted' : 'search_excerpt'
        } catch (error) {
          failures.push({ source_record_id: record.id, code: error.code || 'GOV_DOCUMENT_FAILED', message: error.message })
        }
      }
      const relevanceText = `${cleanText(record.title)} ${cleanText(record.summary)} ${content}`
      if ((requiredTerms || []).some(term => !relevanceText.includes(String(term)))) continue
      evidence.push(createEvidence({
        id: `gov-policy:${record.id}`,
        sourceType: 'government_policy',
        publisher: cleanText(record.puborg) || '中国政府网',
        sourceUrl: record.url,
        title: cleanText(record.title),
        summary: content.slice(0, 6000),
        publishedAt: normalizeDate(record.pubtimeStr),
        evidenceGrade: contentStatus === 'full_text_extracted' ? 'A' : 'C',
        content: snapshotContent,
        metadata: {
          source_id: this.id,
          retrieved_url: retrievedUrl,
          immutable_publication: true,
          publication_time_basis: 'official_policy_publication_date',
          immutable_proof_url: record.url,
          data_category: 'policy',
          metadata_only: contentStatus !== 'full_text_extracted',
          content_hash_scope: contentStatus === 'full_text_extracted' ? 'source_html_bytes' : 'official_search_record_metadata',
          policy_number: cleanText(record.pcode),
          policy_category: cleanText(record.childtype),
          document_fetch_status: contentStatus
        }
      }))
    }
    return { source_id: this.id, evidence, failures, total_available: records.length }
  }
}

function flattenPolicyRecords(searchVO) {
  const records = []
  for (const category of Object.values(searchVO?.catMap || {})) {
    for (const record of category?.listVO || []) {
      if (record?.url && record?.pubtimeStr) records.push(record)
    }
  }
  return records.sort((left, right) => String(right.pubtimeStr).localeCompare(String(left.pubtimeStr)))
}

function extractGovernmentPageText(html) {
  const $ = cheerio.load(html)
  $('script,style,noscript,nav,header,footer').remove()
  const candidates = [
    '.pages_content',
    '.article',
    '.content',
    '#UCAP-CONTENT',
    '#zoom',
    'main'
  ]
  for (const selector of candidates) {
    const text = cleanText($(selector).text())
    if (text.length >= 100) return text
  }
  return cleanText($('body').text())
}

module.exports = { GovernmentPolicyAdapter, extractGovernmentPageText, flattenPolicyRecords }
