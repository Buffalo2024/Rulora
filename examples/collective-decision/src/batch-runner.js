const fs = require('node:fs/promises')
const path = require('node:path')
const { buildCompanyCase, findCompanyRecord } = require('./case-builder')
const { applyIndustryPlanToCollectionRequest, createIndustryPlan, runCase } = require('./orchestrator')
const { PublicSourceCollector } = require('./source-collector')
const { buildSubmissionWithAdjudications, validateAdjudicationRecord, verifyAdjudicatedReport } = require('./submission')
const { readJson, sha256, writeJsonAtomic } = require('./utils')
const { withFileLock } = require('./file-lock')
const { LOCAL_RULORA_PATH } = require('./rulora-loader')
const { PopulationStore } = require('./population-store')

const COMPANY_STATE_TRANSITIONS = Object.freeze({
  pending: new Set(['industry_planning', 'prepared', 'adjudicated_ready']),
  industry_planning: new Set(['collecting', 'collection_failed', 'adjudicated_ready']),
  collecting: new Set(['prepared', 'evidence_incomplete', 'collection_failed', 'adjudicated_ready']),
  evidence_incomplete: new Set(['collecting', 'adjudicated_ready']),
  collection_failed: new Set(['industry_planning', 'collecting', 'adjudicated_ready']),
  prepared: new Set(['analysis_running', 'adjudicated_ready']),
  analysis_running: new Set(['prepared', 'production_ready', 'analysis_degraded', 'analysis_failed', 'paused_upstream', 'paused_seat_failure', 'schema_failure', 'program_failure', 'review', 'adjudicated_ready']),
  analysis_degraded: new Set(['prepared', 'industry_planning', 'analysis_running', 'adjudicated_ready']),
  analysis_failed: new Set(['prepared', 'industry_planning', 'analysis_running', 'adjudicated_ready']),
  paused_upstream: new Set(['analysis_running', 'review']),
  paused_seat_failure: new Set(['analysis_running', 'review']),
  schema_failure: new Set(),
  program_failure: new Set(),
  review: new Set(),
  production_ready: new Set(['prepared', 'analysis_running', 'adjudicated_ready']),
  adjudicated_ready: new Set()
})

async function runFormalBatch({ configPath, onlyPaused = false, allowArchivedLegacy = false }) {
  if (!allowArchivedLegacy) throw Object.assign(new Error('旧批处理入口已存档，历史重放需显式allowArchivedLegacy'), { code: 'LEGACY_EXECUTION_DISABLED' })
  const root = path.resolve(__dirname, '..')
  const config = normalizeBatchConfig(await readJson(path.resolve(configPath)))
  validateBatchConfig(config)
  const runtime = resolveUnderRoot(root, config.runtime_directory)
  await fs.mkdir(runtime, { recursive: true })
  const companies = await readJson(resolveUnderRoot(root, config.companies_file))
  const records = config.company_ids.map(id => findCompanyRecord(companies, id))
  await initializePopulation(root)
  const frozen = await freezeControlPlane(root, runtime)
  const statePath = path.join(runtime, 'batch-state.json')
  await initializeState(statePath, config, records, frozen)
  const adjudications = await loadAdjudications(runtime)
  await applyAdjudicatedState(statePath, adjudications)

  if (onlyPaused) await workerPool(records, config.collection_concurrency, record => verifyPausedOne({ root, runtime, record, statePath }))
  else await workerPool(records, config.collection_concurrency, record => prepareOne({ root, runtime, record, config, statePath, frozen }))
  const prepared = await eligiblePreparedRecords(records, statePath, { onlyPaused })
  await workerPool(prepared, config.case_concurrency, record => analyzeOne({ root, runtime, record, config, statePath, frozen }))
  await assertControlPlaneUnchanged(root, frozen)
  return finalizeBatch({ root, runtime, config, statePath, frozen, adjudications })
}

async function prepareOne({ root, runtime, record, config, statePath, frozen }) {
  const id = String(record.company_id).padStart(3, '0')
  const current = await getCompanyState(statePath, id)
  if (config.resume && ['prepared', 'production_ready', 'adjudicated_ready'].includes(current.status)) return
  if (config.resume && ['schema_failure', 'program_failure', 'review'].includes(current.status)) return
  if (config.resume && ['paused_upstream', 'paused_seat_failure'].includes(current.status)) {
    await verifyPausedOne({ root, runtime, record, statePath })
    return
  }
  const companyRoot = path.join(runtime, 'companies', id)
  const evidencePath = path.join(companyRoot, 'evidence-packet.json')
  const casePath = path.join(companyRoot, 'case.json')
  const requestPath = path.join(companyRoot, 'collection-request.json')
  const planPath = path.join(companyRoot, 'industry-plan.json')
  const snapshotRoot = path.join(companyRoot, 'evidence-snapshots')
  const baseRequest = buildCollectionRequest(record, config.as_of_date)
  const planningCase = buildPlanningCase(record, config.as_of_date)
  await fs.mkdir(companyRoot, { recursive: true })
  try {
    if (config.reuse_frozen_evidence === true && await fileExists(casePath)) {
      const frozenCase = await readJson(casePath)
      if (frozenCase.as_of_date !== config.as_of_date || !Array.isArray(frozenCase.evidence) || frozenCase.evidence.length < 2) throw new Error(`reusable frozen case ${id} does not satisfy the current cutoff or evidence contract`)
      const evidenceSha256 = sha256(frozenCase.evidence)
      await updateCompanyState(statePath, id, {
        status: 'prepared', reused_frozen_evidence: true, case_path: casePath,
        evidence_count: frozenCase.evidence.length, evidence_sha256: evidenceSha256,
        evidence_changed: current.evidence_sha256 ? current.evidence_sha256 !== evidenceSha256 : false,
        evidence_status: current.evidence_sha256 && current.evidence_sha256 !== evidenceSha256 ? 'EVIDENCE_CHANGED' : 'EVIDENCE_REUSED'
      })
      return
    }
    if (config.resume && ['analysis_running', 'analysis_degraded', 'analysis_failed'].includes(current.status) && await fileExists(casePath)) {
      await updateCompanyState(statePath, id, { status: 'prepared', resumed_from_frozen_case: true, case_path: casePath })
      return
    }
    await assertControlPlaneUnchanged(root, frozen)
    let planning
    let request
    if (['evidence_incomplete', 'collection_failed'].includes(current.status) && await fileExists(planPath) && await fileExists(requestPath)) {
      planning = await readJson(planPath)
      request = await readJson(requestPath)
      await updateCompanyState(statePath, id, { status: 'collecting', resumed_same_collection: true })
    } else {
      await updateCompanyState(statePath, id, { status: 'industry_planning', request_path: requestPath, plan_path: planPath })
      planning = await createIndustryPlan({ caseData: planningCase })
      await writeJsonAtomic(planPath, planning)
      request = applyIndustryPlanToCollectionRequest({ request: baseRequest, industryPlan: planning.industry_plan, company: planningCase.company })
      await writeJsonAtomic(requestPath, request)
      await updateCompanyState(statePath, id, { status: 'collecting', industry_plan_sha256: sha256(planning.industry_plan) })
    }
    const packet = await new PublicSourceCollector({ snapshotDirectory: snapshotRoot }).collect(request)
    await writeJsonAtomic(evidencePath, packet)
    if (packet.status !== 'complete') {
      await updateCompanyState(statePath, id, { status: 'evidence_incomplete', evidence_path: evidencePath, required_failures: packet.required_failures, manual_assistance_requests: packet.manual_assistance_requests })
      return
    }
    const caseData = buildCompanyCase({ companyRecord: record, evidencePacket: packet, monitoringMode: 'active' })
    caseData.industry_plan = structuredClone(planning.industry_plan)
    caseData.industry_plan_degraded = planning.diagnostics.degraded === true || planning.provider_production_ready !== true
    const priorEvidenceSha256 = current.evidence_sha256 || null
    const evidenceSha256 = sha256(caseData.evidence)
    await writeJsonAtomic(casePath, caseData)
    await updateCompanyState(statePath, id, {
      status: 'prepared', evidence_path: evidencePath, case_path: casePath, evidence_count: packet.evidence.length,
      evidence_sha256: evidenceSha256,
      evidence_changed: Boolean(priorEvidenceSha256 && priorEvidenceSha256 !== evidenceSha256),
      evidence_status: priorEvidenceSha256 && priorEvidenceSha256 !== evidenceSha256 ? 'EVIDENCE_CHANGED' : 'EVIDENCE_COLLECTED',
      failure: null
    })
  } catch (error) {
    await updateCompanyState(statePath, id, { status: 'collection_failed', failure: failureRecord(error, 'collection') })
  }
}

async function initializePopulation(root) {
  const agents = await readJson(path.join(root, 'config', 'agents.json'))
  const store = new PopulationStore({ filePath: path.join(root, '.runtime', 'population.json'), roles: agents.roles })
  await store.load()
}

async function fileExists(filePath) {
  try { await fs.access(filePath); return true } catch (error) { if (error.code === 'ENOENT') return false; throw error }
}

function buildPlanningCase(record, asOfDate) {
  const id = String(record.company_id).padStart(3, '0')
  return {
    contract_version: '1.0.0',
    case_id: `contest-${id}-${asOfDate}`,
    as_of_date: asOfDate,
    competition_cutoff: asOfDate,
    company: {
      id,
      name: record.company_name,
      industry: record.industry,
      province: record.province,
      city: record.city,
      enterprise_type: record.enterprise_type,
      unified_social_credit_code: record.unified_social_credit_code,
      website: record.website,
      business_scope: record.business_scope
    },
    evidence: []
  }
}

async function analyzeOne({ root, runtime, record, config, statePath, frozen }) {
  const id = String(record.company_id).padStart(3, '0')
  const current = await getCompanyState(statePath, id)
  if (config.resume && current.status === 'production_ready') return
  const outputDirectory = path.join(runtime, 'companies', id, 'output')
  await updateCompanyState(statePath, id, {
    status: 'analysis_running', output_directory: outputDirectory, failure: null,
    run_id: null, report_path: null, manifest_path: null, production_ready: null
  })
  try {
    await assertControlPlaneUnchanged(root, frozen)
    const champion = config.champion_rows?.find(row => String(row.company_id).padStart(3, '0') === id) || null
    const run = await runCase({
      allowArchivedLegacy: true,
      inputPath: current.case_path,
      outputDirectory,
      mode: config.decision_mode,
      champion,
      reuseFrozenEvidence: current.reused_frozen_evidence === true,
      evidenceChanged: current.evidence_changed === true
    })
    await assertControlPlaneUnchanged(root, frozen)
    const productionReady = run.report?.qa?.production_ready === true
    await updateCompanyState(statePath, id, {
      status: productionReady ? 'production_ready' : 'analysis_degraded',
      run_id: run.run_id,
      report_path: run.artifacts.report_json,
      manifest_path: run.artifacts.manifest_json,
      production_ready: productionReady,
      failure: null
    })
  } catch (error) {
    const status = ({ PAUSED_UPSTREAM: 'paused_upstream', PAUSED_SEAT_FAILURE: 'paused_seat_failure', SCHEMA_FAILURE: 'schema_failure', PROGRAM_FAILURE: 'program_failure', REVIEW: 'review' })[error.code] || 'analysis_failed'
    await updateCompanyState(statePath, id, {
      status,
      failure: failureRecord(error, 'analysis'),
      case_checkpoint_path: error.case_checkpoint_path || null,
      decision_finalized: false
    })
  }
}

async function verifyPausedOne({ root, runtime, record, statePath }) {
  const id = String(record.company_id).padStart(3, '0')
  const current = await getCompanyState(statePath, id)
  if (!['paused_upstream', 'paused_seat_failure'].includes(current.status)) return
  const caseData = await readJson(current.case_path)
  const checkpointPath = current.case_checkpoint_path || path.join(root, '.runtime', 'case-resume-checkpoints', `${caseData.case_id}.json`)
  const checkpoint = await readJson(checkpointPath)
  const evidenceHash = sha256(caseData.evidence || [])
  if (checkpoint.evidence_hash !== evidenceHash || current.evidence_sha256 && current.evidence_sha256 !== evidenceHash) {
    const error = new Error(`paused case ${id} evidence hash changed`)
    error.code = 'EVIDENCE_HASH_MISMATCH'
    await updateCompanyState(statePath, id, { status: 'review', failure: failureRecord(error, 'resume_gate'), evidence_changed: true })
    return
  }
  await updateCompanyState(statePath, id, {
    evidence_sha256: evidenceHash,
    evidence_changed: false,
    resume_verified_at: new Date().toISOString(),
    case_checkpoint_path: checkpointPath
  })
}

function buildCollectionRequest(record, asOfDate) {
  const id = String(record.company_id).padStart(3, '0')
  return {
    contract_version: '1.0.0',
    request_id: `formal-${id}-${asOfDate}`,
    company: { id, name: record.company_name },
    as_of_date: asOfDate,
    public_information_only: true,
    queries: [
      { source_id: 'cninfo', query: record.company_name, start_date: '2023-01-01', end_date: asOfDate, max_records: 8, fetch_documents: true, required: /上市/.test(String(record.enterprise_type || '')), min_evidence: /上市/.test(String(record.enterprise_type || '')) ? 2 : 0, data_category: 'enterprise_disclosure' },
      { source_id: 'government_policy', query: policyKeyword(record.industry), start_date: '2023-01-01', end_date: asOfDate, max_records: 5, fetch_documents: true, required: true, min_evidence: 1, data_category: 'policy' }
    ]
  }
}

function policyKeyword(industry) {
  const value = String(industry || '')
  const mappings = [
    ['医药', '医药工业'], ['医疗', '医疗器械'], ['电子', '电子信息制造业'], ['软件', '软件和信息技术服务业'],
    ['家具', '家居消费'], ['餐饮', '餐饮业'], ['化学', '化工行业'], ['橡胶', '新材料产业'],
    ['运输', '现代物流'], ['专业技术', '专业技术服务业'], ['科技推广', '城市服务'], ['研究和试验', '科技创新'],
    ['通用设备', '装备制造业'], ['专用设备', '装备制造业']
  ]
  return mappings.find(([needle]) => value.includes(needle))?.[1] || value || '产业政策'
}

async function finalizeBatch({ root, runtime, config, statePath, frozen, adjudications }) {
  const state = await readJson(statePath)
  const ready = Object.values(state.companies).filter(item => ['production_ready', 'adjudicated_ready'].includes(item.status))
  const sourceCatalog = []
  for (const item of ready) {
    const report = await readJson(item.report_path)
    for (const source of report.decision_sources || []) sourceCatalog.push({ company_id: item.company_id, company_name: item.company_name, ...source })
  }
  const sourcePath = resolveUnderRoot(root, config.source_catalog_json)
  await writeJsonAtomic(sourcePath, { contract_version: '1.0.0', as_of_date: config.as_of_date, generated_at: new Date().toISOString(), sources: sourceCatalog })
  let submission = null
  if (ready.length === config.company_ids.length && config.generate_submission !== false) {
    submission = await buildSubmissionWithAdjudications({
      reportPaths: ready.map(item => item.report_path),
      outputPath: resolveUnderRoot(root, config.submission_csv),
      expectedCompanyIds: config.company_ids,
      adjudications
    })
  }
  const final = { ...state, status: submission ? 'complete' : 'incomplete', production_ready_count: ready.length, submission, source_catalog_path: sourcePath, control_plane_sha256: frozen.combined_sha256, updated_at: new Date().toISOString() }
  await writeJsonAtomic(statePath, final)
  return final
}

async function loadAdjudications(runtime) {
  try {
    const payload = await readJson(path.join(runtime, 'manual-adjudications.json'))
    const records = Array.isArray(payload.records) ? payload.records.filter(record => record.status === 'adjudicated') : []
    for (const record of records) validateAdjudicationRecord(record)
    return records
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
}

async function applyAdjudicatedState(statePath, adjudications) {
  const runtime = path.dirname(statePath)
  for (const record of adjudications) {
    const id = String(record.company_id).padStart(3, '0')
    const reportPath = path.join(runtime, 'companies', id, 'output', `${record.source_run_id}.report.json`)
    const manifestPath = path.join(runtime, 'companies', id, 'output', `${record.source_run_id}.manifest.json`)
    const report = await readJson(reportPath)
    if (report.run_id !== record.source_run_id) throw new Error(`adjudication ${id} is not bound to the current frozen report`)
    await verifyAdjudicatedReport(reportPath, report, record)
    await updateCompanyState(statePath, id, {
      status: 'adjudicated_ready',
      run_id: record.source_run_id,
      report_path: reportPath,
      manifest_path: manifestPath,
      production_ready: true,
      adjudication_status: 'adjudicated',
      adjudicated_output: structuredClone(record.adjudicated_output)
    })
  }
}

async function freezeControlPlane(root, runtime) {
  const sourceFiles = await listFiles(path.join(root, 'src'), file => file.endsWith('.js'))
  const schemaFiles = await listFiles(path.join(root, 'schemas'), file => file.endsWith('.json'))
  const relative = [
    ...sourceFiles.map(file => path.relative(root, file)),
    ...schemaFiles.map(file => path.relative(root, file)),
    'package.json', 'package-lock.json',
    'config/agents.json', 'config/batch.json', 'config/competition-mode.json', 'config/debate.json', 'config/decision.json', 'config/evolution.json', 'config/execution.json',
    'config/manual-source-assistance.json', 'config/model-profiles.local.json', 'config/monitoring.json', 'config/public-sources.json',
    '.runtime/population.json'
  ]
  for (const optional of ['config/nanshu-roles.local.env', 'config/runtime.json']) {
    try { await fs.access(path.join(root, optional)); relative.push(optional) } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  relative.sort()
  const files = {}
  for (const item of relative) {
    const filePath = path.join(root, item)
    const bytes = await fs.readFile(filePath)
    files[item] = sha256(bytes)
  }
  const externalFiles = {}
  const ruloraSourceRoot = path.join(LOCAL_RULORA_PATH, 'src')
  for (const filePath of await listFiles(ruloraSourceRoot, file => file.endsWith('.js'))) externalFiles[filePath] = sha256(await fs.readFile(filePath))
  for (const filePath of [path.join(LOCAL_RULORA_PATH, 'package.json')]) externalFiles[filePath] = sha256(await fs.readFile(filePath))
  const frozen = { created_at: new Date().toISOString(), files, external_files: externalFiles, combined_sha256: sha256({ files, external_files: externalFiles }) }
  await writeJsonAtomic(path.join(runtime, 'control-plane-freeze.json'), frozen)
  return frozen
}

async function listFiles(directory, accept) {
  const output = []
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name)
    if (entry.isDirectory()) output.push(...await listFiles(target, accept))
    else if (accept(target)) output.push(target)
  }
  return output
}

async function assertControlPlaneUnchanged(root, frozen) {
  for (const [item, expected] of Object.entries(frozen.files)) {
    const actual = sha256(await fs.readFile(path.join(root, item)))
    if (actual !== expected) throw new Error(`control plane changed during formal batch: ${item}`)
  }
  for (const [filePath, expected] of Object.entries(frozen.external_files || {})) {
    const actual = sha256(await fs.readFile(filePath))
    if (actual !== expected) throw new Error(`external control plane changed during formal batch: ${filePath}`)
  }
}

async function initializeState(statePath, config, records, frozen) {
  try {
    const state = await readJson(statePath)
    const prior = state.control_plane_sha256
    state.control_plane_sha256 = frozen.combined_sha256
    state.collection_concurrency = config.collection_concurrency
    state.case_concurrency = config.case_concurrency
    state.control_plane_revisions = [...(state.control_plane_revisions || []), {
      resumed_at: new Date().toISOString(),
      prior_sha256: prior,
      active_sha256: frozen.combined_sha256
    }]
    state.updated_at = new Date().toISOString()
    await writeJsonAtomic(statePath, state)
    return
  } catch (error) { if (error.code !== 'ENOENT') throw error }
  await writeJsonAtomic(statePath, {
    contract_version: '1.0.0', batch_id: `formal-${config.company_ids.length}-${config.as_of_date}`, status: 'running', as_of_date: config.as_of_date,
    formal_mode: true, collection_concurrency: config.collection_concurrency, case_concurrency: config.case_concurrency,
    decision_mode: config.decision_mode, reuse_frozen_evidence: config.reuse_frozen_evidence === true,
    control_plane_sha256: frozen.combined_sha256, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    companies: Object.fromEntries(records.map(record => { const id = String(record.company_id).padStart(3, '0'); return [id, { company_id: id, company_name: record.company_name, status: 'pending' }] }))
  })
}

async function updateCompanyState(statePath, id, patch) {
  return withFileLock(`${statePath}.lock`, async () => {
    const state = await readJson(statePath)
    const currentStatus = state.companies[id].status
    if (patch.status && patch.status !== currentStatus && !COMPANY_STATE_TRANSITIONS[currentStatus]?.has(patch.status)) {
      const error = new Error(`illegal batch company transition for ${id}: ${currentStatus} -> ${patch.status}`)
      error.code = 'ILLEGAL_BATCH_TRANSITION'
      throw error
    }
    state.companies[id] = { ...state.companies[id], ...patch, updated_at: new Date().toISOString() }
    state.updated_at = new Date().toISOString()
    await writeJsonAtomic(statePath, state)
    process.stdout.write(`${JSON.stringify({
      type: 'batch_company_state',
      at: state.companies[id].updated_at,
      company_id: id,
      company_name: state.companies[id].company_name,
      from: currentStatus,
      to: state.companies[id].status,
      evidence_count: state.companies[id].evidence_count ?? null,
      run_id: state.companies[id].run_id ?? null,
      failure: state.companies[id].failure ?? null
    })}\n`)
    return state.companies[id]
  })
}

async function getCompanyState(statePath, id) { return (await readJson(statePath)).companies[id] }
async function eligiblePreparedRecords(records, statePath, { onlyPaused = false } = {}) {
  const state = await readJson(statePath)
  const eligible = onlyPaused ? new Set(['paused_upstream', 'paused_seat_failure']) : new Set(['prepared', 'production_ready', 'paused_upstream', 'paused_seat_failure'])
  return records.filter(record => eligible.has(state.companies[String(record.company_id).padStart(3, '0')].status))
}

async function workerPool(items, concurrency, task) {
  let cursor = 0
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const index = cursor++
      if (index >= items.length) return
      await task(items[index])
    }
  })
  await Promise.all(workers)
}

function validateBatchConfig(config) {
  if (config.contract_version !== '1.0.0' || config.formal_mode !== true) throw new Error('formal batch config is invalid')
  const expected = config.expected_company_count === undefined ? 25 : Number(config.expected_company_count)
  if (!Number.isInteger(expected) || expected < 1 || expected > 25) throw new Error('expected_company_count must be an integer between 1 and 25')
  if (!Array.isArray(config.company_ids) || config.company_ids.length !== expected || new Set(config.company_ids).size !== expected) throw new Error(`formal batch needs ${expected} unique company IDs`)
  if (!['competition_legacy', 'competition_calibrated', 'competition_calibrated_v2', 'business'].includes(config.decision_mode || 'competition_legacy')) throw new Error('batch decision_mode is invalid')
  if (config.case_ids && JSON.stringify(config.case_ids) !== JSON.stringify(config.company_ids)) throw new Error('normalized case_ids/company_ids mismatch')
  if (!Number.isInteger(config.collection_concurrency) || config.collection_concurrency !== 1) throw new Error('collection_concurrency must be 1 for shared public source safety')
  if (!Number.isInteger(config.case_concurrency) || config.case_concurrency < 1 || config.case_concurrency > 5) throw new Error('case_concurrency must be between 1 and 5')
}

function normalizeBatchConfig(input) {
  const config = structuredClone(input)
  if (Array.isArray(config.case_ids)) {
    config.case_ids = config.case_ids.map(id => String(id).padStart(3, '0'))
    config.company_ids = [...config.case_ids]
    config.expected_company_count = config.company_ids.length
  }
  config.decision_mode ||= 'competition_legacy'
  config.reuse_frozen_evidence = config.reuse_frozen_evidence === true
  if (!Array.isArray(config.company_ids)) config.company_ids = []
  config.company_ids = config.company_ids.map(id => String(id).padStart(3, '0'))
  if (Array.isArray(config.champion_rows)) config.champion_rows = config.champion_rows.map(row => ({ ...row, company_id: String(row.company_id).padStart(3, '0') }))
  return config
}

function resolveUnderRoot(root, value) {
  const resolved = path.resolve(root, value)
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) throw new Error(`batch path escapes project root: ${value}`)
  return resolved
}

function failureRecord(error, stage) { return { stage, code: error.code || 'BATCH_ITEM_FAILED', message: error.message, message_sha256: sha256(error.message), occurred_at: new Date().toISOString() } }

module.exports = { COMPANY_STATE_TRANSITIONS, assertControlPlaneUnchanged, buildCollectionRequest, normalizeBatchConfig, policyKeyword, runFormalBatch, validateBatchConfig, workerPool }
