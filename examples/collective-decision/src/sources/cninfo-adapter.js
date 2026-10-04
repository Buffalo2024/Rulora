const { PublicHttpClient } = require('./http-client')
const { chinaDateFromEpoch, cleanText, createEvidence, normalizeDate } = require('./evidence')

class CninfoAdapter {
  constructor({ httpClient = new PublicHttpClient(), extractPdf = true, maxPdfPages = 40, pdfTextExtractor = extractPdfText } = {}) {
    this.id = 'cninfo'
    this.http = httpClient
    this.extractPdf = extractPdf
    this.maxPdfPages = maxPdfPages
    this.pdfTextExtractor = pdfTextExtractor
  }

  async collect({ query, start_date: startDate, end_date: endDate, max_records: maxRecords = 8, fetch_documents: fetchDocuments = true }) {
    if (!String(query || '').trim()) throw new Error('cninfo query is required')
    const start = normalizeDate(startDate)
    const end = normalizeDate(endDate)
    const form = new URLSearchParams({
      pageNum: '1',
      pageSize: String(Math.min(Math.max(Number(maxRecords), 1), 30)),
      column: 'szse',
      tabName: 'fulltext',
      searchkey: String(query).trim(),
      seDate: `${start}~${end}`,
      isHLtitle: 'true'
    })
    const data = await this.http.json('https://www.cninfo.com.cn/new/hisAnnouncement/query', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
        referer: 'https://www.cninfo.com.cn/'
      },
      body: form.toString(),
      allowedHosts: ['cninfo.com.cn'],
      minimumIntervalMs: 500
    })
    const announcements = (data.announcements || []).slice(0, Number(maxRecords))
    const evidence = []
    const failures = []
    for (const announcement of announcements) {
      try {
        evidence.push(await this.toEvidence(announcement, { fetchDocument: fetchDocuments }))
      } catch (error) {
        failures.push({
          source_record_id: announcement.announcementId,
          code: error.code || 'CNINFO_DOCUMENT_FAILED',
          message: error.message
        })
        evidence.push(this.metadataEvidence(announcement, { documentStatus: 'metadata_only_after_document_failure' }))
      }
    }
    return { source_id: this.id, evidence, failures, total_available: Number(data.totalAnnouncement || evidence.length) }
  }

  async toEvidence(announcement, { fetchDocument }) {
    if (!fetchDocument) return this.metadataEvidence(announcement, { documentStatus: 'not_requested' })
    const sourceUrl = `https://static.cninfo.com.cn/${String(announcement.adjunctUrl || '').replace(/^\//, '')}`
    const { bytes, response } = await this.http.bytes(sourceUrl, {
      headers: { referer: 'https://www.cninfo.com.cn/' },
      minimumIntervalMs: 500,
      maxBytes: 30 * 1024 * 1024,
      allowedHosts: ['cninfo.com.cn']
    })
    // PDF.js may transfer and detach the Uint8Array buffer while parsing.
    // Preserve an immutable byte copy before extraction so the evidence hash
    // always covers the downloaded public document rather than an empty buffer.
    const documentBytes = Buffer.from(bytes)
    const contentType = response.headers.get('content-type') || ''
    let text = ''
    if (this.extractPdf && (/pdf/i.test(contentType) || sourceUrl.toLowerCase().endsWith('.pdf'))) {
      text = await this.pdfTextExtractor(bytes, this.maxPdfPages)
    }
    const title = cleanText(announcement.announcementTitle || announcement.shortTitle)
    const summary = text ? text.slice(0, 6000) : `${cleanText(announcement.secName)}：${title}`
    return createEvidence({
      id: `cninfo:${announcement.announcementId}`,
      sourceType: 'company_disclosure',
      publisher: '巨潮资讯网',
      sourceUrl,
      title,
      summary,
      publishedAt: chinaDateFromEpoch(announcement.announcementTime),
      evidenceGrade: 'A',
      content: documentBytes,
      metadata: {
        source_id: this.id,
        immutable_publication: true,
        publication_time_basis: 'official_announcement_publication_date',
        immutable_proof_url: sourceUrl,
        data_category: 'enterprise_disclosure',
        security_code: announcement.secCode,
        security_name: cleanText(announcement.secName),
        document_type: announcement.adjunctType || 'PDF',
        document_fetch_status: text ? 'full_text_extracted' : 'content_hashed_text_unavailable',
        content_hash_scope: 'source_document_bytes'
      }
    })
  }

  metadataEvidence(announcement, { documentStatus }) {
    const sourceUrl = `https://static.cninfo.com.cn/${String(announcement.adjunctUrl || '').replace(/^\//, '')}`
    const title = cleanText(announcement.announcementTitle || announcement.shortTitle)
    const metadataContent = JSON.stringify({
      announcementId: announcement.announcementId,
      title,
      announcementTime: announcement.announcementTime,
      sourceUrl
    })
    return createEvidence({
      id: `cninfo:${announcement.announcementId}`,
      sourceType: 'company_disclosure',
      publisher: '巨潮资讯网',
      sourceUrl,
      title,
      summary: `${cleanText(announcement.secName)}：${title}`,
      publishedAt: chinaDateFromEpoch(announcement.announcementTime),
      evidenceGrade: 'C',
      content: metadataContent,
      metadata: {
        source_id: this.id,
        immutable_publication: true,
        publication_time_basis: 'official_announcement_publication_date',
        immutable_proof_url: sourceUrl,
        metadata_only: true,
        data_category: 'enterprise_disclosure',
        security_code: announcement.secCode,
        security_name: cleanText(announcement.secName),
        document_type: announcement.adjunctType || 'PDF',
        document_fetch_status: documentStatus,
        content_hash_scope: 'announcement_metadata'
      }
    })
  }
}

async function extractPdfText(bytes, maxPages) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const task = pdfjs.getDocument({ data: bytes, disableWorker: true, isEvalSupported: false, useSystemFonts: true })
  const document = await task.promise
  const pages = []
  for (let number = 1; number <= Math.min(document.numPages, maxPages); number += 1) {
    const page = await document.getPage(number)
    const content = await page.getTextContent()
    pages.push(content.items.map(item => item.str || '').join(' '))
  }
  await document.destroy()
  return cleanText(pages.join('\n'))
}

module.exports = { CninfoAdapter, extractPdfText }
