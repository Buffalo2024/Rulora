const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { normalizeImportedRecords, parseCsv, rowsToRecords } = require('../src/company-import')
const { createWebServer } = require('../src/web-server')
const { RISK_CONTROL_ADVICE_CATALOG, describeRiskControlAdvice } = require('../src/risk-control-advice')
const { STANDARD_TASK, WebJobManager, resolveCompany } = require('../src/web-job-manager')

const companies = [
  { company_id: '001', company_name: '虚构晨光制造有限公司', industry: '制造业' },
  { company_id: '002', company_name: '虚构远航家居有限公司', industry: '家具制造业' }
]

test('risk-control advice details are a deterministic display-only lookup', () => {
  assert.equal(Object.keys(RISK_CONTROL_ADVICE_CATALOG).length, 9)
  assert.deepEqual(describeRiskControlAdvice(['2', '6']), [
    { code: '2', title: '调低信用评级', description: '根据风险信号及时下调客户信用等级，触发相应风险应对机制' },
    { code: '6', title: '增加保证担保', description: '追加实控人、股东自然人连带担保或引入第三方保证人，强化还款保障' }
  ])
  assert.throws(() => describeRiskControlAdvice(['2', '2']), /duplicate/)
  assert.throws(() => describeRiskControlAdvice(['10']), /unknown/)
})

test('resolveCompany accepts explicit ID, ID in task, and unique company name', () => {
  assert.equal(resolveCompany(companies, { task: '', companyId: '1' }).company_id, '001')
  assert.equal(resolveCompany(companies, { task: '分析002的产业链风险', companyId: '' }).company_id, '002')
  assert.equal(resolveCompany(companies, { task: '请分析虚构远航家居', companyId: '' }).company_id, '002')
  assert.throws(() => resolveCompany(companies, { task: '分析一家企业', companyId: '' }), /无法唯一识别/)
})

test('company import accepts the target CSV field format and rejects duplicate IDs', () => {
  const csv = '企业编号（company_id),企业名称,所属行业,统一社会信用代码\n3,测试企业股份有限公司,软件和信息技术服务业,91440000123456789X\n'
  const records = normalizeImportedRecords(rowsToRecords(parseCsv(csv)))
  assert.equal(records[0].company_id, '003')
  assert.equal(records[0].company_name, '测试企业股份有限公司')
  assert.throws(() => normalizeImportedRecords([...records, ...records]), /重复company_id/)
})

test('WebJobManager persists real progress semantics, logs, agents, and result artifacts', async () => {
  const root = await createFixtureRoot()
  let receivedTask = null
  const fakeRunCase = async ({ outputDirectory, task, onProgress }) => {
    receivedTask = task
    await fs.mkdir(outputDirectory, { recursive: true })
    const artifacts = {
      run_json: path.join(outputDirectory, 'run.json'),
      report_json: path.join(outputDirectory, 'report.json'),
      report_markdown: path.join(outputDirectory, 'report.md'),
      submission_csv: path.join(outputDirectory, 'submission.csv'),
      manifest_json: path.join(outputDirectory, 'manifest.json')
    }
    await onProgress({ type: 'run_created', run_id: 'run-test', stage: 'session_initialization', evidence_count: 8 })
    await onProgress({ type: 'agent_started', run_id: 'run-test', stage: 'group_debate', phase: 'decision_direction_initial', agent_id: 'industry_chain_analyst' })
    await onProgress({ type: 'agent_completed', run_id: 'run-test', stage: 'group_debate', phase: 'decision_direction_initial', agent_id: 'industry_chain_analyst', validation_status: 'PASS', validation_attempt: 1, validation_max_attempts: 3, recovery_mode: 'decision_block', recovery_applied: true, warnings: ['SCHEMA_NORMALIZED'] })
    await onProgress({ type: 'phase_completed', run_id: 'run-test', stage: 'group_debate', phase: 'decision_direction', result: 'risk_flat', unanimous: true })
    await onProgress({ type: 'action_calibration_completed', run_id: 'run-test', stage: 'group_debate', phase: 'decision_direction', action: 0, threshold_passed: true })
    await onProgress({ type: 'risk_calibration_completed', run_id: 'run-test', stage: 'group_debate', phase: 'risk_control_advice', candidate_count: 1, preferred_candidate_set_id: 'risk:2,6' })
    await onProgress({ type: 'reviewer_candidate_pool_created', run_id: 'run-test', stage: 'competition_calibration', phase: 'reviewer_selection', candidate_pool: { action_candidates: [{ id: 'action:0', value: 0 }], risk_candidates: [{ id: 'risk:2,6', value: ['2', '6'] }] } })
    await onProgress({ type: 'reviewer_selection_completed', run_id: 'run-test', stage: 'competition_calibration', phase: 'reviewer_selection', selected_action_candidate_id: 'action:0', selected_risk_candidate_id: 'risk:2,6', challenge_level: 'LOW' })
    await onProgress({ type: 'champion_gate_completed', run_id: 'run-test', stage: 'competition_calibration', phase: 'champion_gate', gate: 'REVIEW', decision_finalized: true, finalization_status: 'FINALIZED_WITH_WARNING' })
    await Promise.all(Object.values(artifacts).map(file => fs.writeFile(file, '{}\n', 'utf8')))
    return {
      run_id: 'run-test',
      consensus: {
        action: 0,
        risk_label: 'risk_flat',
        risk_control_advice: ['2', '6'],
        decision_mode: 'unanimous',
        conclusion_grade: 'A',
        evidence_coverage: { cited: 8, total: 8 }
      },
      report: {
        qa: { production_ready: true },
        debate_summary: { clean_gate_satisfied: true },
        submission_row: { company_id: '001', action: '0', risk_control_advice: '2,6' }
      },
      competition_finalization: {
        finalization_status: 'FINALIZED_WITH_WARNING',
        warnings: ['SCHEMA_NORMALIZED'],
        reviewer_candidate_pool: { action_candidates: [{ id: 'action:0', value: 0 }], risk_candidates: [{ id: 'risk:2,6', value: ['2', '6'] }] },
        calibration_reviewer: { selected_action_candidate_id: 'action:0', selected_risk_candidate_id: 'risk:2,6', challenge_level: 'LOW' },
        champion_gate: { recommended_status: 'REVIEW' }
      },
      artifacts
    }
  }
  const manager = new WebJobManager({ root, runCaseImpl: fakeRunCase, concurrency: 1, allowArchivedLegacy: true })
  await manager.initialize()
  assert.equal(manager.listAgents().length, 6)
  assert.equal(manager.listAgents().filter(agent => agent.stage === 'industry_chain_planning').length, 1)
  assert.equal(manager.listAgents().filter(agent => agent.stage === 'group_debate').length, 3)
  const created = await manager.createJob({ company_id: '001', user_consent: true, consent_action: 'start_analysis', decision_mode: 'competition_calibrated_v2' })
  const finished = await waitForJob(manager, created.job_id)
  const summaries = manager.listJobs()
  assert.equal(summaries[0].job_id, created.job_id)
  assert.equal(summaries[0].status, 'succeeded')
  assert.equal(Object.hasOwn(summaries[0], 'events'), false)
  assert.equal(Object.hasOwn(summaries[0], 'agent_states'), false)
  assert.equal(Object.hasOwn(summaries[0], 'result'), false)
  assert.ok(JSON.stringify(summaries).length < 2000)
  assert.equal(finished.status, 'succeeded')
  assert.equal(receivedTask, STANDARD_TASK)
  assert.equal(finished.progress_percent, 100)
  assert.equal(finished.result.action, '0')
  assert.deepEqual(finished.result.risk_control_advice, ['2', '6'])
  assert.equal(finished.result.risk_control_advice_details.display_only, true)
  assert.deepEqual(finished.result.risk_control_advice_details.items.map(item => item.code), ['2', '6'])
  assert.equal(finished.agent_states.industry_chain_analyst.status, 'completed')
  assert.equal(finished.agent_states.industry_chain_analyst.validation_attempt, 1)
  assert.equal(finished.v2_state.constraint.revision_completed_count, 1)
  assert.equal(finished.v2_state.recovery.count, 1)
  assert.equal(finished.v2_state.reviewer_selection.selected_risk_candidate_id, 'risk:2,6')
  assert.equal(finished.v2_state.decision_finalized, true)
  assert.equal(finished.agent_states.improvement_supervisor.status, 'not_in_case')
  const logs = await manager.getLogs(created.job_id)
  assert.match(logs.text, /agent:start/)
  assert.match(logs.text, /action=0/)
  assert.equal(await manager.getArtifact(created.job_id, 'report'), finished.result.artifacts.report_json)
  const persisted = JSON.parse(await fs.readFile(path.join(root, '.runtime', 'web-ui', 'jobs', `${created.job_id}.json`), 'utf8'))
  assert.equal(persisted.status, 'succeeded')
})

test('WebJobManager creates a bounded multi-company batch and queues every selected company once', async () => {
  const root = await createFixtureRoot()
  const fakeRunCase = async ({ outputDirectory }) => {
    await fs.mkdir(outputDirectory, { recursive: true })
    const artifacts = Object.fromEntries(['run_json', 'report_json', 'report_markdown', 'submission_csv', 'manifest_json'].map(key => [key, path.join(outputDirectory, `${key}.json`)]))
    await Promise.all(Object.values(artifacts).map(file => fs.writeFile(file, '{}\n')))
    return {
      run_id: path.basename(outputDirectory),
      consensus: { action: 0, risk_label: 'risk_flat', risk_control_advice: ['2'], decision_mode: 'majority', conclusion_grade: 'B', evidence_coverage: 1 },
      report: { qa: { production_ready: true }, debate_summary: {}, submission_row: {} },
      artifacts
    }
  }
  const manager = new WebJobManager({ root, runCaseImpl: fakeRunCase, concurrency: 1, batchLimit: 2, allowArchivedLegacy: true })
  await manager.initialize()
  const batch = await manager.createBatch({ company_ids: ['001', '002'], user_consent: true, consent_action: 'start_analysis', decision_mode: 'competition_calibrated_v2' })
  assert.equal(batch.accepted_count, 2)
  assert.ok(batch.jobs.every(job => job.user_consent === true && job.consent_action === 'start_analysis' && job.consent_time))
  assert.equal(new Set(batch.jobs.map(job => job.company_id)).size, 2)
  await Promise.all(batch.jobs.map(job => waitForJob(manager, job.job_id)))
  await assert.rejects(() => manager.createBatch({ company_ids: ['001', '002', '003'], user_consent: true, consent_action: 'start_analysis', decision_mode: 'competition_calibrated_v2' }), /单次最多进件2家/)
  await assert.rejects(() => manager.createBatch({ company_ids: ['001'], decision_mode: 'competition_calibrated_v2' }), /开始进件分析/)
})

test('failed job resumes in place with the same model-call checkpoint root', async () => {
  const root = await createFixtureRoot()
  const calls = []
  const fakeRunCase = async ({ outputDirectory, modelCallCheckpointRoot }) => {
    calls.push({ outputDirectory, modelCallCheckpointRoot })
    if (calls.length === 1) {
      const error = new Error('temporary upstream failure')
      error.code = 'PAUSED_UPSTREAM'
      throw error
    }
    await fs.mkdir(outputDirectory, { recursive: true })
    const artifacts = Object.fromEntries(['run_json', 'report_json', 'report_markdown', 'submission_csv', 'manifest_json'].map(key => [key, path.join(outputDirectory, `${key}.json`)]))
    await Promise.all(Object.values(artifacts).map(file => fs.writeFile(file, '{}\n')))
    return {
      run_id: 'resumed-run',
      consensus: { action: 0, risk_label: 'risk_flat', risk_control_advice: ['2'], decision_mode: 'majority', conclusion_grade: 'B', evidence_coverage: 1 },
      report: { qa: { production_ready: true }, debate_summary: {}, submission_row: {} },
      artifacts
    }
  }
  const manager = new WebJobManager({ root, runCaseImpl: fakeRunCase, concurrency: 1, allowArchivedLegacy: true })
  await manager.initialize()
  const created = await manager.createJob({ company_id: '001', user_consent: true, consent_action: 'start_analysis', decision_mode: 'competition_calibrated_v2' })
  const failed = await waitForJob(manager, created.job_id)
  assert.equal(failed.status, 'paused')
  const resumed = await manager.resumeJob(created.job_id)
  assert.equal(resumed.job_id, created.job_id)
  assert.equal(resumed.resume_count, 1)
  const finished = await waitForJob(manager, created.job_id)
  assert.equal(finished.status, 'succeeded')
  assert.equal(calls.length, 2)
  assert.equal(calls[0].outputDirectory, calls[1].outputDirectory)
  assert.equal(calls[0].modelCallCheckpointRoot, calls[1].modelCallCheckpointRoot)
  assert.equal(calls[0].modelCallCheckpointRoot, path.join(calls[0].outputDirectory, 'model-call-checkpoints'))
})

test('imported enterprise is stored outside the frozen source dataset and becomes selectable for automatic intake', async () => {
  const root = await createFixtureRoot()
  const manager = new WebJobManager({ root, runCaseImpl: async () => { throw new Error('not called') } })
  await manager.initialize()
  const csv = Buffer.from('company_id,company_name,industry,unified_social_credit_code\n003,测试企业股份有限公司,软件和信息技术服务业,91440000123456789X\n').toString('base64')
  const result = await manager.importCompanies({ filename: 'companies.csv', content_base64: csv })
  assert.equal(result.imported_count, 1)
  const imported = manager.listCompanies().find(company => company.company_id === '003')
  assert.equal(imported.imported, true)
  assert.equal(imported.intake_required, true)
  assert.equal(imported.selectable, true)
  assert.equal(JSON.parse(await fs.readFile(path.join(root, 'examples', 'companies.json'))).records.length, 2)
})

test('production web manager archives legacy jobs and starts only confirmed two-layer decisions', async () => {
  const root = await createFixtureRoot()
  const manager = new WebJobManager({ root })
  await manager.initialize()
  manager.pump = () => {}
  manager.caseCatalog.delete('002')
  assert.equal(manager.listCompanies().find(company => company.company_id === '002').selectable, true)
  await assert.rejects(() => manager.createJob({ company_id: '001', user_consent: true, consent_action: 'start_analysis', decision_mode: 'competition_calibrated_v2' }), /旧版经营分析已存档/)
  await assert.rejects(() => manager.createBatch({ company_ids: ['001'], user_consent: true, consent_action: 'start_analysis', decision_mode: 'competition_calibrated_v2' }), /旧版经营分析已存档/)
  const batch = await manager.createBatch({ company_ids: ['001'], user_consent: true, consent_action: 'start_analysis', question: { question: '此内容不应覆盖固定任务' }, search_sites: ['gov.cn'] })
  assert.equal(batch.jobs[0].task, '企业产业链风险及决策分析')
  assert.equal(batch.jobs[0].question.subject, companies[0].company_name)
  assert.equal(batch.jobs[0].search_sites.length, 1)
  assert.equal(batch.jobs[0].decision_mode, 'enterprise_decision_v2')
  assert.equal(batch.jobs[0].status, 'queued')
  assert.equal(batch.jobs[0].case_path, null)
  assert.equal(batch.jobs[0].intake_required, true)
  assert.equal(manager.systemSnapshot().decision_mode, 'enterprise_decision_v2')
  const failed = manager.jobs.get(batch.jobs[0].job_id)
  failed.status = 'failed'
  failed.failure = { code: 'ENTERPRISE_EVIDENCE_INVALID', message: '旧快照不可用' }
  failed.case_path = '/old/case.json'
  const resumed = await manager.resumeJob(failed.job_id)
  assert.equal(resumed.status, 'queued')
  assert.equal(resumed.case_path, null)
  assert.equal(resumed.archived_case_path, '/old/case.json')
  assert.equal(resumed.intake_required, true)
})

test('web server exposes same-origin task APIs with security headers', async t => {
  const now = new Date().toISOString()
  const job = { job_id: 'web-001-test', company_id: '001', company_name: companies[0].company_name, status: 'queued', created_at: now }
  const manager = {
    initialize: async () => manager,
    listCompanies: () => companies.map(company => ({ ...company, case_available: true })),
    listAgents: () => [],
    sourceSettings: () => ({ built_in_sources: [], search_backend: { type: 'searxng', enabled: false, endpoint: '' }, websites: [] }),
    updateSourceSettings: async body => ({ built_in_sources: [], ...body }),
    listJobs: () => [job],
    createJob: async () => ({ ...job, task: STANDARD_TASK }),
    createBatch: async body => ({ accepted_count: body.company_ids.length, jobs: [job] }),
    resumeJob: async jobId => ({ ...job, job_id: jobId, status: 'queued', resume_count: 1 }),
    importCompanies: async () => ({ imported_count: 1, companies: [] }),
    getJob: async () => job,
    getLogs: async () => ({ text: 'ok\n', truncated: false }),
    systemSnapshot: () => ({ concurrency: 2, batch_limit: 5, running_jobs: 0, queued_jobs: 1, total_jobs: 1 })
  }
  const root = path.resolve(__dirname, '..')
  const { server } = await createWebServer({ root, manager, privacyPassword: 'test-only-password' })
  await listen(server)
  t.after(() => server.close())
  const address = server.address()
  const base = `http://127.0.0.1:${address.port}`
  const response = await fetch(`${base}/api/companies`)
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-security-policy'), /default-src 'self'/)
  assert.equal((await response.json()).companies.length, 2)
  const privacyScript = await fetch(`${base}/presentation-privacy.js`)
  assert.equal(privacyScript.status, 200)
  assert.match(await privacyScript.text(), /RuloraPresentationPrivacy/)
  const authorQr = await fetch(`${base}/assets/author-wechat.jpg`)
  assert.equal(authorQr.status, 200)
  assert.equal(authorQr.headers.get('content-type'), 'image/jpeg')
  const rejectedPrivacyUnlock = await fetch(`${base}/api/privacy/unlock`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'wrong' }) })
  assert.equal(rejectedPrivacyUnlock.status, 401)
  const acceptedPrivacyUnlock = await fetch(`${base}/api/privacy/unlock`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'test-only-password' }) })
  assert.equal(acceptedPrivacyUnlock.status, 200)
  assert.equal((await acceptedPrivacyUnlock.json()).unlocked, true)
  const created = await fetch(`${base}/api/jobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ company_id: '001', user_consent: true, consent_action: 'start_analysis' })
  })
  assert.equal(created.status, 410)
  assert.match((await created.json()).error, /旧版单任务入口已存档/)
  const agentResponse = await fetch(`${base}/api/agents`)
  assert.equal(agentResponse.status, 200)
  const sourceResponse = await fetch(`${base}/api/sources`)
  assert.equal(sourceResponse.status, 200)
  const sourceUpdate = await fetch(`${base}/api/sources`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ search_backend: { type: 'searxng', enabled: false, endpoint: '' }, websites: [] })
  })
  assert.equal(sourceUpdate.status, 200)
  const batchResponse = await fetch(`${base}/api/jobs/batch`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ company_ids: ['001'], user_consent: true, consent_action: 'start_analysis' })
  })
  assert.equal(batchResponse.status, 202)
  const resumeResponse = await fetch(`${base}/api/jobs/${job.job_id}/resume`, { method: 'POST' })
  assert.equal(resumeResponse.status, 202)
  assert.equal((await resumeResponse.json()).job.job_id, job.job_id)
})

async function createFixtureRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'risk-web-manager-'))
  const paths = [
    path.join(root, 'examples'),
    path.join(root, 'config'),
    path.join(root, '.runtime', 'formal-batch-test', 'companies', '001'),
    path.join(root, '.runtime', 'formal-batch-test', 'companies', '002')
  ]
  await Promise.all(paths.map(directory => fs.mkdir(directory, { recursive: true })))
  await fs.writeFile(path.join(root, 'examples', 'companies.json'), JSON.stringify({ records: companies }), 'utf8')
  await fs.writeFile(path.join(root, 'config', 'agents.json'), JSON.stringify({ roles: [
    { id: 'industry_research_planner', label: '前置产业链研究规划员', stage: 'industry_chain_planning', model_profile: 'chain_reasoner' },
    { id: 'public_evidence_monitor', label: '公开信息采集与监控员', stage: 'information_collection_monitoring', model_profile: 'monitor_extractor' },
    { id: 'industry_chain_analyst', label: '产业链传导辩证分析师', stage: 'group_debate', model_profile: 'chain_reasoner', participates_in_debate: true },
    { id: 'risk_factor_analyst', label: '风险因子分析师', stage: 'group_debate', model_profile: 'factor_reasoner', participates_in_debate: true },
    { id: 'adversarial_reviewer', label: '辩论红队与证伪审计员', stage: 'group_debate', model_profile: 'red_team_reasoner', participates_in_debate: true },
    { id: 'improvement_supervisor', label: '专职改善席', stage: 'periodic_improvement', model_profile: 'decision_reasoner' }
  ] }), 'utf8')
  await fs.writeFile(path.join(root, 'config', 'enterprise-sources.json'), JSON.stringify({ contract_version: '1.0.0', policy: {}, sources: [
    { id: 'cninfo', label: '巨潮资讯网', source_type: 'company_disclosure', adapter: 'cninfo', production_ingest_enabled: true, access_mode: 'public_json_api' },
    { id: 'manual', label: '人工来源', source_type: 'government_credit', adapter: null, production_ingest_enabled: false, access_mode: 'manual' }
  ] }), 'utf8')
  await fs.writeFile(path.join(root, '.runtime', 'formal-batch-test', 'companies', '001', 'case.json'), '{}\n', 'utf8')
  await fs.writeFile(path.join(root, '.runtime', 'formal-batch-test', 'companies', '002', 'case.json'), '{}\n', 'utf8')
  return root
}

async function waitForJob(manager, jobId) {
  const deadline = Date.now() + 3000
  while (Date.now() < deadline) {
    const job = await manager.getJob(jobId)
    if (['succeeded', 'failed', 'interrupted', 'paused'].includes(job.status)) return job
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('job did not finish')
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
}

test('exception dialog keeps manual adjudication actions hidden outside unresolved Action cases', async () => {
  const html = await fs.readFile(path.join(__dirname, '..', 'web', 'index.html'), 'utf8')
  const css = await fs.readFile(path.join(__dirname, '..', 'web', 'styles.css'), 'utf8')
  const app = await fs.readFile(path.join(__dirname, '..', 'web', 'app.js'), 'utf8')
  assert.match(html, /id="exception-action-resolution" hidden/)
  assert.match(css, /\.exception-quick-actions\[hidden\]\s*\{\s*display:none!important\s*\}/)
  assert.match(app, /job\.failure\?\.code === 'PAUSED_ACTION_UNRESOLVED'/)
  assert.match(app, /exception-action-resolution'\)\.hidden = !unresolved/)
})

test('result status labels separate delivery readiness from completed review', async () => {
  const app = await fs.readFile(path.join(__dirname, '..', 'web', 'app.js'), 'utf8')
  assert.match(app, /未通过交付门禁/)
  assert.match(app, /复核已完成/)
  assert.match(app, /运行时模型生产就绪凭证未通过/)
  assert.doesNotMatch(app, /<span>流程状态<\/span>/)
  assert.doesNotMatch(app, /<strong>流程说明<\/strong>/)
  assert.match(app, /requires_human_review === true[^\n]+等待人工确认/)
  assert.doesNotMatch(app, /result\.production_ready \? '可正式交付' : '需要复核'/)
})

test('public author contact remains accessible', async () => {
  const html = await fs.readFile(path.join(__dirname, '..', 'web', 'index.html'), 'utf8')
  assert.match(html, /作者联系方式/)
  assert.match(html, /alt="作者微信二维码"/)
})

test('privacy toggle requires password only when turning masking off', async () => {
  const html = await fs.readFile(path.join(__dirname, '..', 'web', 'index.html'), 'utf8')
  const app = await fs.readFile(path.join(__dirname, '..', 'web', 'app.js'), 'utf8')
  assert.match(html, /id="privacy-unlock-password" type="password"/)
  assert.match(app, /\/api\/privacy\/unlock/)
  assert.match(app, /if \(event\.target\.checked\)/)
})

test('runtime commands persist roles and cannot publish or change the fixed task', async () => {
  const root = await createFixtureRoot()
  const manager = new WebJobManager({ root })
  await manager.initialize()
  manager.pump = () => {}
  const batch = await manager.createBatch({ company_ids: ['001'], user_consent: true, consent_action: 'start_analysis' })
  const jobId = batch.jobs[0].job_id
  const count = manager.jobs.size
  await manager.runtimeCommand(jobId, { message: '替另一家企业发布新任务' })
  assert.equal(manager.jobs.size, count)
  const response = await manager.runtimeCommand(jobId, { message: '当前状态' })
  assert.equal(response.job.runtime_messages.length, 4)
  assert.equal(response.job.runtime_messages[0].role, 'user')
  assert.equal(response.job.runtime_messages[1].role, 'agent')
  assert.equal(response.job.task, '企业产业链风险及决策分析')
  manager.jobs.get(jobId).status = 'awaiting_assistance'
  await assert.rejects(() => manager.supplementEnterpriseJob(jobId, { question: { question: '改为经营决策审批' } }), /固定任务/)
  const supplemented = await manager.runtimeCommand(jobId, { message: '补充规则：不得新增长期负债' })
  assert.equal(supplemented.job.rules[0], '不得新增长期负债')
  assert.equal(supplemented.job.status, 'queued')
})

test('HTTP fixed-task intake and runtime chat work together without reception', async t => {
  const root = await createFixtureRoot()
  const manager = new WebJobManager({ root })
  await manager.initialize()
  manager.pump = () => {}
  const { server } = await createWebServer({ root, manager, privacyPassword: 'test-only-password' })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => { server.closeAllConnections(); server.close() })
  const base = `http://127.0.0.1:${server.address().port}`
  const post = (route, body) => fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  assert.equal((await post('/api/reception/prepare', { raw_task: '旧任务' })).status, 410)
  const created = await post('/api/jobs/batch', { company_ids: ['001'], user_consent: true, consent_action: 'start_analysis', search_sites: ['gov.cn'] })
  assert.equal(created.status, 202)
  const { batch } = await created.json()
  assert.equal(batch.jobs[0].task, '企业产业链风险及决策分析')
  const chat = await post(`/api/jobs/${batch.jobs[0].job_id}/command`, { message: '当前状态' })
  assert.equal(chat.status, 200)
  const reply = await chat.json()
  assert.equal(reply.job.runtime_messages.length, 2)
  assert.equal(manager.jobs.size, 1)
  assert.ok(!Object.values(reply.job.agent_states).some(a => a.stage === 'task_reception'))
})
test('storage registration failure leaves no phantom queued task and allows a clean retry',async()=>{
 const root=await createFixtureRoot(),manager=new WebJobManager({root,allowArchivedLegacy:true})
 await manager.initialize();const original=manager.persistJob.bind(manager)
 manager.persistJob=async()=>{throw Object.assign(new Error('write failed'),{code:'ENOSPC'})}
 const args={company_id:'001',user_consent:true,consent_action:'start_analysis',decision_mode:'competition_calibrated_v2',deferPump:true}
 await assert.rejects(manager.createJob(args),{code:'ENOSPC'})
 assert.equal(manager.listJobs().length,0)
 manager.persistJob=original;const created=await manager.createJob(args)
 assert.equal(created.status,'queued');assert.equal(manager.listJobs().length,1)
})
test('failed atomic write cleans its partial temporary file and preserves the previous document',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'rulora-full-write-')),file=path.join(root,'job.json')
 await fs.writeFile(file,'{"saved":true}\n');const original=fs.writeFile
 t.mock.method(fs,'writeFile',async(p,...args)=>{
  if(String(p).startsWith(file+'.')){await original(p,'partial');throw Object.assign(new Error('full'),{code:'ENOSPC'})}
  return original(p,...args)
 })
 await assert.rejects(require('../src/utils').writeJsonAtomic(file,{saved:false}),{code:'ENOSPC'})
 assert.deepEqual(await fs.readdir(root),['job.json']);assert.deepEqual(JSON.parse(await fs.readFile(file,'utf8')),{saved:true})
})
test('storage full HTTP errors expose a specific retryable diagnosis without private details',async t=>{
 const manager={initialize:async()=>{},createBatch:async()=>{throw Object.assign(new Error('/private/path'),{code:'ENOSPC'})}}
 const {server}=await createWebServer({root:path.resolve(__dirname,'..'),manager});await listen(server);t.after(()=>server.close())
 t.mock.method(console,'error',()=>{})
 const r=await fetch(`http://127.0.0.1:${server.address().port}/api/jobs/batch`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({})})
 assert.equal(r.status,507);const body=await r.json();assert.equal(body.code,'ENOSPC');assert.match(body.error,/存储空间不足/);assert(!body.error.includes('/private/path'))
})
