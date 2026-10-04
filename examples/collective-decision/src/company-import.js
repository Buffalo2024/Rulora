const crypto = require('node:crypto')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')

const MAXIMUM_IMPORT_BYTES = 12 * 1024 * 1024
const MAXIMUM_IMPORT_RECORDS = 200
const COMPANY_COLUMNS = Object.freeze([
  'company_id', 'company_name', 'operating_status', 'legal_representative', 'registered_capital',
  'paid_in_capital', 'established_at', 'approved_at', 'operating_term', 'province', 'city',
  'district', 'unified_social_credit_code', 'taxpayer_id', 'registration_number',
  'organization_code', 'insured_employees', 'enterprise_type', 'industry', 'former_names',
  'registered_address', 'latest_annual_report_address', 'website', 'business_scope'
])
const COMPANY_TEMPLATE_HEADERS = Object.freeze([
  '企业编号（company_id)', '企业名称', '经营状态', '法定代表人', '注册资本', '实缴资本', '成立日期', '核准日期',
  '营业期限', '所属省份', '所属城市', '所属区县', '统一社会信用代码', '纳税人识别号', '工商注册号',
  '组织机构代码', '参保人数', '企业类型', '所属行业', '曾用名', '注册地址', '最新年报地址', '网址', '经营范围'
])
const COMPANY_HEADER_MAP = Object.freeze({
  '企业编号（company_id)': 'company_id',
  '企业编号(company_id)': 'company_id',
  '企业编号': 'company_id',
  '企业名称': 'company_name',
  '经营状态': 'operating_status',
  '法定代表人': 'legal_representative',
  '注册资本': 'registered_capital',
  '实缴资本': 'paid_in_capital',
  '成立日期': 'established_at',
  '核准日期': 'approved_at',
  '营业期限': 'operating_term',
  '所属省份': 'province',
  '所属城市': 'city',
  '所属区县': 'district',
  '统一社会信用代码': 'unified_social_credit_code',
  '纳税人识别号': 'taxpayer_id',
  '工商注册号': 'registration_number',
  '组织机构代码': 'organization_code',
  '参保人数': 'insured_employees',
  '企业类型': 'enterprise_type',
  '所属行业': 'industry',
  '曾用名': 'former_names',
  '注册地址': 'registered_address',
  '最新年报地址': 'latest_annual_report_address',
  '网址': 'website',
  '经营范围': 'business_scope'
})

async function parseCompanyImport({ filename, contentBase64, allowMissingCompanyId = false }) {
  const safeFilename = path.basename(String(filename || ''))
  const extension = path.extname(safeFilename).toLowerCase()
  if (!['.json', '.csv', '.xls', '.xlsx'].includes(extension)) throw inputError('仅支持 JSON、CSV、XLS、XLSX 企业文件。')
  let bytes
  try { bytes = Buffer.from(String(contentBase64 || ''), 'base64') } catch { throw inputError('企业文件不是有效的Base64内容。') }
  if (!bytes.length) throw inputError('企业文件为空。')
  if (bytes.length > MAXIMUM_IMPORT_BYTES) throw inputError(`企业文件不能超过${MAXIMUM_IMPORT_BYTES / 1024 / 1024}MB。`)
  let rawRecords
  if (extension === '.json') {
    let payload
    try { payload = JSON.parse(bytes.toString('utf8')) } catch { throw inputError('企业JSON文件格式无效。') }
    rawRecords = Array.isArray(payload) ? payload : payload.records
  } else if (extension === '.csv') {
    rawRecords = rowsToRecords(parseCsv(bytes.toString('utf8').replace(/^\uFEFF/, '')))
  } else {
    rawRecords = await spreadsheetRecords({ filename: safeFilename, bytes })
  }
  const records = normalizeImportedRecords(rawRecords, { allowMissingCompanyId })
  return {
    filename: safeFilename,
    content_sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    record_count: records.length,
    records
  }
}

async function spreadsheetRecords({ filename, bytes }) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'rulora-company-import-'))
  try {
    const source = path.join(temporary, filename)
    const output = path.join(temporary, 'converted')
    const profile = path.join(temporary, 'profile')
    await Promise.all([fs.mkdir(output), fs.mkdir(profile), fs.writeFile(source, bytes)])
    const soffice = await resolveSoffice()
    await spawnChecked(soffice, [
      `-env:UserInstallation=${pathToFileUrl(profile)}`,
      '--headless', '--convert-to', 'csv', '--outdir', output, source
    ], 90_000)
    const candidates = (await fs.readdir(output)).filter(name => name.toLowerCase().endsWith('.csv'))
    if (candidates.length !== 1) throw inputError('表格转换后没有得到唯一CSV工作表；请只保留一个企业数据Sheet。')
    return rowsToRecords(parseCsv(await fs.readFile(path.join(output, candidates[0]), 'utf8')))
  } finally {
    await fs.rm(temporary, { recursive: true, force: true })
  }
}

async function resolveSoffice() {
  const candidates = [
    process.env.SOFFICE_BIN,
    '/Applications/LibreOffice.app/Contents/MacOS/soffice',
    '/opt/homebrew/bin/soffice',
    '/usr/local/bin/soffice',
    '/usr/bin/soffice'
  ].filter(Boolean)
  for (const candidate of candidates) {
    try { await fs.access(candidate); return candidate } catch { /* continue */ }
  }
  throw inputError('未找到LibreOffice/soffice，XLS/XLSX暂时无法读取；可改用CSV或设置SOFFICE_BIN。')
}

function pathToFileUrl(value) {
  const normalized = path.resolve(value).split(path.sep).map(encodeURIComponent).join('/')
  return `file://${normalized}`
}

function spawnChecked(command, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const stderr = []
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      const error = inputError('企业表格转换超时。')
      error.code = 'COMPANY_IMPORT_TIMEOUT'
      reject(error)
    }, timeoutMs)
    child.stderr.on('data', chunk => stderr.push(chunk))
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('close', code => {
      clearTimeout(timer)
      if (code === 0) return resolve()
      reject(inputError(`企业表格转换失败：${Buffer.concat(stderr).toString('utf8').slice(-500)}`))
    })
  })
}

function parseCsv(text) {
  const rows = []
  let row = []
  let field = ''
  let quoted = false
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') { field += '"'; index += 1 }
      else if (character === '"') quoted = false
      else field += character
      continue
    }
    if (character === '"') quoted = true
    else if (character === ',') { row.push(field); field = '' }
    else if (character === '\n') { row.push(field.replace(/\r$/, '')); rows.push(row); row = []; field = '' }
    else field += character
  }
  if (field || row.length) { row.push(field.replace(/\r$/, '')); rows.push(row) }
  return rows.filter(values => values.some(value => String(value).trim()))
}

function rowsToRecords(rows) {
  if (!rows.length) return []
  const headers = rows[0].map(normalizeHeader)
  return rows.slice(1).map(values => Object.fromEntries(headers.map((header, index) => [header, values[index] || ''])))
}

function normalizeHeader(value) {
  const clean = String(value || '').replace(/^\uFEFF/, '').trim()
  return COMPANY_HEADER_MAP[clean] || clean
}

function normalizeImportedRecords(rawRecords, { allowMissingCompanyId = false } = {}) {
  if (!Array.isArray(rawRecords) || rawRecords.length === 0) throw inputError('企业文件没有records或有效数据行。')
  if (rawRecords.length > MAXIMUM_IMPORT_RECORDS) throw inputError(`单个企业文件最多包含${MAXIMUM_IMPORT_RECORDS}家企业。`)
  const seen = new Set()
  return rawRecords.map((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw inputError(`第${index + 1}条企业记录不是对象。`)
    const normalized = {}
    for (const [rawKey, rawValue] of Object.entries(raw)) {
      const key = normalizeHeader(rawKey)
      if (!COMPANY_COLUMNS.includes(key)) continue
      normalized[key] = cleanCell(rawValue, key === 'business_scope' ? 20_000 : 2_000)
    }
    const numericId = String(normalized.company_id || '').trim()
    const requireBusinessFields = allowMissingCompanyId && !numericId
    if (numericId && !/^\d{1,3}$/.test(numericId)) throw inputError(`第${index + 1}条企业编号必须是1至3位数字。`)
    if (!numericId && !allowMissingCompanyId) throw inputError(`第${index + 1}条记录缺少企业编号。`)
    normalized.company_id = numericId ? numericId.padStart(3, '0') : ''
    const label = normalized.company_id || `第${index + 1}条企业`
    if (!normalized.company_name) throw inputError(`${label}缺少企业名称。`)
    if (!normalized.taxpayer_id && normalized.unified_social_credit_code) normalized.taxpayer_id = normalized.unified_social_credit_code
    if (!normalized.unified_social_credit_code && normalized.taxpayer_id) normalized.unified_social_credit_code = normalized.taxpayer_id
    if (requireBusinessFields && !normalized.taxpayer_id) throw inputError(`${label}缺少纳税人识别号。`)
    if (!normalized.industry) throw inputError(`${label}缺少所属行业。`)
    if (requireBusinessFields && !normalized.business_scope) throw inputError(`${label}缺少经营范围。`)
    if (normalized.company_id && seen.has(normalized.company_id)) throw inputError(`企业文件包含重复company_id：${normalized.company_id}`)
    if (normalized.company_id) seen.add(normalized.company_id)
    return Object.fromEntries(COMPANY_COLUMNS.filter(key => normalized[key] !== undefined).map(key => [key, normalized[key]]))
  })
}

function assignCompanyIds(records, existingCompanyIds = []) {
  const used = new Set(existingCompanyIds.map(value => String(value).padStart(3, '0')))
  for (const record of records) if (record.company_id) used.add(record.company_id)
  return records.map(record => { if (record.company_id) return record; for (let value=1; value<=999; value+=1) { const candidate=String(value).padStart(3,'0'); if (!used.has(candidate)) { used.add(candidate); return {...record,company_id:candidate} } } throw inputError('企业编号已用完，无法自动分配新编号。') })
}

function cleanCell(value, maximum) {
  const text = String(value ?? '').replace(/_x000D_/g, '').replace(/\r/g, '').trim()
  if (text.length > maximum) throw inputError(`企业字段内容超过${maximum}字符。`)
  return text
}

function companyTemplateCsv() {
  const example = COMPANY_COLUMNS.map(column => ({
    company_id: '001', company_name: '示例企业股份有限公司', industry: '计算机、通信和其他电子设备制造业',
    province: '广东省', city: '广州市', unified_social_credit_code: '91440000XXXXXXXXXX',
    enterprise_type: '股份有限公司', website: 'https://example.com', business_scope: '示例经营范围'
  })[column] || '')
  return `${COMPANY_TEMPLATE_HEADERS.join(',')}\n${example.map(csvCell).join(',')}\n`
}

function csvCell(value) {
  const text = String(value || '')
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

function inputError(message) {
  const error = new Error(message)
  error.code = 'COMPANY_IMPORT_INVALID'
  error.statusCode = 400
  return error
}

module.exports = {
  COMPANY_COLUMNS,
  MAXIMUM_IMPORT_BYTES,
  assignCompanyIds,
  companyTemplateCsv,
  normalizeImportedRecords,
  parseCompanyImport,
  parseCsv,
  rowsToRecords
}
