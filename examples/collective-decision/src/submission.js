const fs = require('node:fs/promises')
const path = require('node:path')
const { renderSubmissionCsv } = require('./report')
const { probabilityVectorValid } = require('./report')
const { readJson, sha256 } = require('./utils')

async function buildSubmission({ reportPaths, outputPath, expectedCompanyIds = [] }) {
  if (!Array.isArray(reportPaths) || reportPaths.length === 0) throw new Error('at least one report JSON is required')
  const verified = await Promise.all(reportPaths.map(verifyCommittedReport))
  const rows = verified.map(({ report }) => {
    if (report?.qa?.production_ready !== true) {
      throw new Error(`report ${report?.run_id || 'unknown'} is not production-ready`)
    }
    return validateSubmissionRow(report.submission_row)
  })
  assertUnique(rows.map(row => row.company_id), 'company_id')
  if (expectedCompanyIds.length) {
    const expected = expectedCompanyIds.map(id => strictCompanyId(id)).sort()
    const actual = rows.map(row => row.company_id).sort()
    if (JSON.stringify(expected) !== JSON.stringify(actual)) {
      throw new Error(`submission company IDs mismatch: expected ${expected.join(',')} but received ${actual.join(',')}`)
    }
  }
  rows.sort((left, right) => left.company_id.localeCompare(right.company_id))
  const csv = renderRows(rows)
  const resolved = path.resolve(outputPath)
  await fs.mkdir(path.dirname(resolved), { recursive: true })
  const temporary = `${resolved}.${process.pid}.tmp`
  await fs.writeFile(temporary, csv, 'utf8')
  await fs.rename(temporary, resolved)
  return { output: resolved, row_count: rows.length, company_ids: rows.map(row => row.company_id) }
}

async function buildSubmissionWithAdjudications({ reportPaths, outputPath, expectedCompanyIds = [], adjudications = [] }) {
  if (!Array.isArray(reportPaths) || reportPaths.length === 0) throw new Error('at least one report JSON is required')
  const adjudicationByCompany = new Map(adjudications.map(record => [strictCompanyId(record.company_id), record]))
  const rows = await Promise.all(reportPaths.map(async reportPath => {
    const resolved = path.resolve(reportPath)
    const report = JSON.parse(await fs.readFile(resolved, 'utf8'))
    const companyId = strictCompanyId(report?.submission_row?.company_id)
    const adjudication = adjudicationByCompany.get(companyId)
    if (!adjudication) return validateSubmissionRow((await verifyCommittedReport(resolved)).report.submission_row)
    await verifyAdjudicatedReport(resolved, report, adjudication)
    return validateSubmissionRow({ company_id: companyId, ...adjudication.adjudicated_output })
  }))
  assertUnique(rows.map(row => row.company_id), 'company_id')
  if (expectedCompanyIds.length) {
    const expected = expectedCompanyIds.map(id => strictCompanyId(id)).sort()
    const actual = rows.map(row => row.company_id).sort()
    if (JSON.stringify(expected) !== JSON.stringify(actual)) throw new Error(`submission company IDs mismatch: expected ${expected.join(',')} but received ${actual.join(',')}`)
  }
  rows.sort((left, right) => left.company_id.localeCompare(right.company_id))
  const resolved = path.resolve(outputPath)
  await fs.mkdir(path.dirname(resolved), { recursive: true })
  const temporary = `${resolved}.${process.pid}.tmp`
  await fs.writeFile(temporary, renderRows(rows), 'utf8')
  await fs.rename(temporary, resolved)
  return { output: resolved, row_count: rows.length, company_ids: rows.map(row => row.company_id), adjudicated_company_ids: [...adjudicationByCompany.keys()].sort() }
}

async function verifyAdjudicatedReport(reportPath, report, adjudication) {
  validateAdjudicationRecord(adjudication)
  if (adjudication.status !== 'adjudicated') throw new Error(`adjudication for ${adjudication.company_id} is not final`)
  if (adjudication.source_run_id !== report.run_id) throw new Error(`adjudication source run mismatch for ${adjudication.company_id}`)
  const manifestPath = reportPath.replace(/\.report\.json$/, '.manifest.json')
  const [reportBytes, manifest] = await Promise.all([fs.readFile(reportPath), readJson(manifestPath)])
  if (manifest.status !== 'committed' || manifest.run_id !== report.run_id) throw new Error(`adjudicated report ${report.run_id} has no committed manifest`)
  if (manifest.files?.report_json?.sha256 !== sha256(reportBytes)) throw new Error(`adjudicated report hash mismatch for ${report.run_id}`)
  if (adjudication.source_report_sha256 !== sha256(reportBytes)) throw new Error(`adjudication source report binding mismatch for ${report.run_id}`)
  const sourceIds = new Set((report.decision_sources || []).map(source => source.evidence_id))
  const sourceGrades = new Map((report.decision_sources || []).map(source => [source.evidence_id, source.evidence_grade]))
  for (const evidenceId of adjudication.evidence_refs || []) {
    if (!sourceIds.has(evidenceId)) throw new Error(`adjudication ${adjudication.company_id} cites evidence absent from its frozen report: ${evidenceId}`)
  }
  if (!(adjudication.evidence_refs || []).some(id => ['A', 'B'].includes(sourceGrades.get(id)))) {
    throw new Error(`adjudication ${adjudication.company_id} requires at least one A/B decision source`)
  }
}

function validateAdjudicationRecord(record) {
  if (!record || record.contract_version !== '1.0.0') throw new Error('adjudication contract_version must be 1.0.0')
  for (const key of ['adjudication_id', 'company_id', 'source_run_id', 'adjudicator_id', 'rationale', 'source_report_sha256']) {
    if (!String(record[key] || '').trim()) throw new Error(`adjudication ${key} is required`)
  }
  if (record.status !== 'adjudicated') throw new Error('adjudication status must be adjudicated')
  if (!/^\d{4}-\d{2}-\d{2}T/.test(record.adjudicated_at || '') || Number.isNaN(Date.parse(record.adjudicated_at))) throw new Error('adjudication adjudicated_at must be an ISO timestamp')
  if (Date.parse(record.adjudicated_at) > Date.now()) throw new Error('adjudication time cannot be in the future')
  if (!/^[a-f0-9]{64}$/i.test(record.source_report_sha256)) throw new Error('adjudication source_report_sha256 is invalid')
  if (!Array.isArray(record.evidence_refs) || record.evidence_refs.length === 0) throw new Error('adjudication evidence_refs must be non-empty')
  if (new Set(record.evidence_refs).size !== record.evidence_refs.length) throw new Error('adjudication evidence_refs must be unique')
  const row = validateSubmissionRow({ company_id: record.company_id, ...record.adjudicated_output })
  if (row.risk_control_advice && row.risk_control_advice.split(',').length > 4) throw new Error('adjudication can select at most four advice codes')
  return record
}

function validateSubmissionRow(row) {
  if (!row || row.company_id === undefined) throw new Error('submission row lacks company_id')
  const companyId = strictCompanyId(row.company_id)
  const action = String(row.action)
  if (!['-1', '0', '1'].includes(action)) throw new Error(`invalid action for ${companyId}: ${action}`)
  if (!Object.hasOwn(row, 'risk_control_advice')) throw new Error(`submission row lacks risk_control_advice for ${companyId}`)
  const advice = String(row.risk_control_advice ?? '').split(',').filter(Boolean)
  if (advice.length > 4 || advice.some(code => !/^[1-9]$/.test(code))) {
    throw new Error(`invalid risk_control_advice for ${companyId}`)
  }
  if (new Set(advice).size !== advice.length) throw new Error(`duplicate risk_control_advice for ${companyId}`)
  return { company_id: companyId, action, risk_control_advice: advice.join(',') }
}

async function verifyCommittedReport(reportPath) {
  const resolved = path.resolve(reportPath)
  if (!resolved.endsWith('.report.json')) throw new Error(`report path must end with .report.json: ${resolved}`)
  const manifestPath = resolved.replace(/\.report\.json$/, '.manifest.json')
  const [reportBytes, manifest] = await Promise.all([fs.readFile(resolved), readJson(manifestPath)])
  const report = JSON.parse(reportBytes.toString('utf8'))
  if (manifest.status !== 'committed' || manifest.run_id !== report.run_id) throw new Error(`report ${report.run_id || 'unknown'} has no matching committed manifest`)
  if (manifest.production_ready !== true) throw new Error(`manifest ${manifest.run_id} is not production-ready`)
  if (manifest.files?.report_json?.name !== path.basename(resolved)) throw new Error(`manifest report filename mismatch for ${report.run_id}`)
  if (manifest.files?.report_json?.sha256 !== sha256(reportBytes)) throw new Error(`report hash mismatch for ${report.run_id}`)
  if (manifest.analysis_snapshot_sha256 !== report.provenance?.analysis_snapshot_sha256) throw new Error(`analysis snapshot hash mismatch for ${report.run_id}`)
  if (!probabilityVectorValid(report.probabilities)) throw new Error(`report probabilities invalid for ${report.run_id}`)
  const expectedAction = { risk_up: '-1', risk_flat: '0', risk_down: '1' }[report.risk_label]
  if (String(report.submission_row?.action) !== expectedAction) throw new Error(`report action/risk label mismatch for ${report.run_id}`)
  for (const flag of ['schema_valid', 'probabilities_valid', 'cutoff_verified', 'source_registry_verified', 'evidence_snapshots_verified', 'evidence_refs_valid', 'evidence_coverage_sufficient', 'production_ready']) {
    if (report.qa?.[flag] !== true) throw new Error(`report ${report.run_id} failed QA flag ${flag}`)
  }
  if (report.qa.degraded !== false || report.qa.fixture_provider !== false) throw new Error(`report ${report.run_id} is degraded or fixture-generated`)
  return { report, manifest, manifestPath }
}

function strictCompanyId(value) {
  const text = String(value ?? '')
  if (!/^\d{1,3}$/.test(text)) throw new Error(`company_id must be a decimal ID from 001 to 320: ${text}`)
  const numeric = Number(text)
  if (numeric < 1 || numeric > 320) throw new Error(`company_id must be in the competition range 001..320: ${text}`)
  return String(numeric).padStart(3, '0')
}

function renderRows(rows) {
  const header = renderSubmissionCsv({ company_id: '', action: '', risk_control_advice: '' }).split('\n')[0]
  const lines = rows.map(row => renderSubmissionCsv(row).trimEnd().split('\n')[1])
  return `${header}\n${lines.join('\n')}\n`
}

function assertUnique(values, label) {
  const unique = new Set(values)
  if (unique.size !== values.length) throw new Error(`duplicate ${label} in submission`)
}

module.exports = { buildSubmission, buildSubmissionWithAdjudications, renderRows, strictCompanyId, validateAdjudicationRecord, validateSubmissionRow, verifyAdjudicatedReport, verifyCommittedReport }
