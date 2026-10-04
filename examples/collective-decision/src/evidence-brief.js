const { sha256, canonicalJson } = require('./utils')
const THEMES = {
  performance: /营业收入|净利润|毛利率|营收|销售收入|revenue|profit/i,
  cash: /现金流|货币资金|回款|应收|负债|融资|募集|cash|debt/i,
  capacity: /产能|产销|库存|订单|利用率|capacity|inventory/i,
  supply: /原材料|供应商|采购|集中度|成本|supplier|cost/i,
  market: /需求|竞争|市场|客户|门店|渠道|market|demand/i,
  risk: /风险|下降|下滑|亏损|不确定|未达|不及|不足|暂停|risk|declin/i
}
function passages(text, width = 600) {
  // Preserve contiguous source text, including table headings, units and adjacent rows.
  const out = []
  for (let start = 0; start < text.length; start += Math.max(1, Math.floor(width * 0.6))) {
    const end = Math.min(text.length, start + width)
    const quote = text.slice(start, end)
    out.push({ start, end, quote, themes: Object.entries(THEMES).filter(([, re]) => re.test(quote)).map(([k]) => k) })
  }
  return out
}
function queryTerms(queries) {
  const terms = new Set()
  for (const query of queries) {
    for (const term of String(query).match(/[A-Za-z]{3,}/g) || []) terms.add(term)
    for (const [name, pattern] of Object.entries(THEMES)) if (pattern.test(query)) {
      for (const term of pattern.source.split('|')) if (/^[\u4e00-\u9fff]+$/.test(term)) terms.add(term)
    }
  }
  return [...terms].slice(0, 80)
}

function buildEvidenceBrief(evidence, { queries = [], maxChars = 24000, perDocumentChars = 2400 } = {}) {
  if (!evidence.length) return { version: sha256('empty'), documents: [], total_chars: 0, omitted_ids: [] }
  // Total text budget is shared across the evidence set; never silently hide a document.
  const allocation = Math.min(perDocumentChars, Math.floor(maxChars / evidence.length))
  if (allocation < 120) throw Object.assign(new Error('相关证据数量超出核心摘要预算，请分批筛选后继续。'), { code: 'EVIDENCE_BRIEF_BUDGET_EXCEEDED' })
  const terms = queryTerms(queries)
  const documents = evidence.map(item => {
    const text = String(item.summary || '')
    const chunks = passages(text, Math.min(600, allocation))
    const selected = []; const covered = new Set(); let length = 0
    while (chunks.length) {
      chunks.sort((a, b) => score(b) - score(a) || a.start - b.start)
      const chunk = chunks.shift()
      if (selected.some(p => Math.min(p.end, chunk.end) - Math.max(p.start, chunk.start) > Math.min(240, allocation * 0.4))) continue
      if (length + chunk.quote.length > allocation) continue
      selected.push(chunk); length += chunk.quote.length; chunk.themes.forEach(t => covered.add(t))
    }
    function score(p) { return p.themes.filter(t => !covered.has(t)).length * 6 + terms.filter(t => p.quote.includes(t)).length * 4 + (/[\d][\d,.]*\s*(%|％|万元|亿元|元|吨)/.test(p.quote) ? 5 : 0) + (p.themes.includes('risk') ? 2 : 0) }
    selected.sort((a,b) => a.start-b.start)
    return { id: item.id, title: item.title, publisher: item.publisher, published_at: item.published_at, source_url: item.source_url, source_type: item.source_type, evidence_grade: item.evidence_grade,
      summary: selected.map(p => p.quote).join('\n'), core_facts: selected.map(p => ({ evidence_id: item.id, ...p, location_basis: item.brief_location_basis || 'collected_summary_char_offset' })),
      snapshot_sha256: item.content_sha256, recall_status: item.recall_status || 'not_requested', recall_limitation: item.recall_limitation || null, source_text_sha256: sha256(text), source_text_length: text.length, coverage: 'selected_excerpts', limitations: '仅为原始采集文本的核心摘录。未覆盖不等于原文未披露；不得将项目测算当作已实现业绩。需区分期间、单位、实际值与预测值。' }
  })
  return { version: sha256(canonicalJson(documents)), documents, total_chars: documents.reduce((n,d) => n+d.core_facts.reduce((m,p)=>m+p.quote.length,0),0), omitted_ids: [] }
}
module.exports = { buildEvidenceBrief }

async function recallSnapshotText(evidence, snapshotRoot, cache = new Map()) {
  const fs = require('node:fs/promises')
  const path = require('node:path')
  const { extractPdfText } = require('./sources/cninfo-adapter')
  const cheerio = require('cheerio')
  const root = await fs.realpath(snapshotRoot)
  const result = []
  for (const item of evidence) {
    try {
      if (!cache.has(item.content_sha256)) {
        const file = await fs.realpath(path.resolve(root, item.snapshot_ref || ''))
        if (!file.startsWith(root + path.sep)) throw new Error('snapshot outside root')
        const stat = await fs.stat(file)
        if (stat.size > 32 * 1024 * 1024) throw new Error('snapshot exceeds recall byte budget')
        const bytes = await fs.readFile(file)
        if (sha256(bytes) !== item.content_sha256) throw new Error('snapshot hash changed')
        let text; let location
        if (bytes.subarray(0, 5).toString() === '%PDF-') {
          text = await extractPdfText(new Uint8Array(bytes), 80)
          location = 'snapshot_pdf_extracted_text_first_80_pages_char_offset'
        } else {
          text = bytes.toString('utf8')
          if (/<(?:html|body|div|p)[\s>]/i.test(text)) {
            const $ = cheerio.load(text); $('script,style,nav,footer,header').remove()
            text = $('body').text().replace(/\s+/g, ' ').trim()
          }
          location = 'snapshot_extracted_text_char_offset'
        }
        // Do not replace usable collected text with an unreadable extraction.
        cache.set(item.content_sha256, { text, location })
      }
      const extracted = cache.get(item.content_sha256)
      result.push(extracted.text.length > String(item.summary || '').length ? { ...item, summary: extracted.text, brief_location_basis: extracted.location, recall_status: 'snapshot_retrieved' } : { ...item, recall_status: 'collected_text_retained' })
    } catch {
      result.push({ ...item, recall_status: 'snapshot_recall_unavailable', recall_limitation: '原文回查未成功，现有摘录不足不能等同于原文未披露。' })
    }
  }
  return result
}
module.exports.recallSnapshotText = recallSnapshotText
