const { sha256 } = require('../utils')

function createEvidence({
  id,
  sourceType,
  publisher,
  sourceUrl,
  title,
  summary,
  publishedAt,
  evidenceGrade,
  content,
  metadata = {}
}) {
  const cleanTitle = cleanText(title)
  const cleanSummary = cleanText(summary)
  const contentValue = content instanceof Uint8Array ? Buffer.from(content) : String(content || cleanSummary)
  return {
    id: String(id),
    source_type: sourceType,
    publisher,
    source_url: new URL(sourceUrl).href,
    title: cleanTitle,
    summary: cleanSummary,
    published_at: normalizeDate(publishedAt),
    retrieved_at: new Date().toISOString(),
    evidence_grade: evidenceGrade,
    content_sha256: sha256(contentValue),
    _snapshot_base64: Buffer.from(contentValue).toString('base64'),
    public: true,
    ...metadata
  }
}

function cleanText(value) {
  return String(value || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/_x000D_/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function normalizeDate(value) {
  const normalized = String(value || '').replace(/[./]/g, '-').slice(0, 10)
  const match = normalized.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  const parsed = match ? new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))) : null
  if (!match || parsed.getUTCFullYear() !== Number(match[1]) || parsed.getUTCMonth() !== Number(match[2]) - 1 || parsed.getUTCDate() !== Number(match[3])) {
    throw new Error(`invalid public source date: ${value}`)
  }
  return normalized
}

function chinaDateFromEpoch(milliseconds) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date(Number(milliseconds)))
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]))
  return `${values.year}-${values.month}-${values.day}`
}

module.exports = { chinaDateFromEpoch, cleanText, createEvidence, normalizeDate }
