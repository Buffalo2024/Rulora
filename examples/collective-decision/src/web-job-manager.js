const { formatAssistance } = require('./decision-copy')
const crypto = require('node:crypto')
const fs = require('node:fs/promises')
const path = require('node:path')
const { buildCollectionRequest } = require('./batch-runner')
const { buildCompanyCase } = require('./case-builder')
const { assignCompanyIds, parseCompanyImport } = require('./company-import')
const { applyIndustryPlanToCollectionRequest, createIndustryPlan, runCase } = require('./orchestrator')
const { projectRoot } = require('./rulora-loader')
const { RISK_CONTROL_ADVICE_DEFINITION_VERSION, describeRiskControlAdvice } = require('./risk-control-advice')
const { PublicSourceCollector } = require('./source-collector')
const { verifyEvidenceSnapshots } = require('./evidence-registry')
const { ManualAssistanceService } = require('./manual-assistance')
const { UserSourceConfigStore } = require('./user-source-config')
const { readJson, writeJsonAtomic, canonicalJson, sha256 } = require('./utils')
const { assertSchema, loadSchemaValidators } = require('./schema-validator')
const { validateIndustryPlan } = require('./contracts')
const { MODE: ENTERPRISE_MODE, SEATS: ENTERPRISE_SEATS, clarifyQuestion, runEnterpriseDecision } = require('./enterprise-decision')
const { failureMessage, failureDetails } = require('./runtime-failure')
const { FIXED_TASK, fixedQuestion } = require('./enterprise-action-contract')
const { typeSafeApiKey } = require('./sources/jev-key')

const TERMINAL_JOB_STATUSES = new Set(['succeeded', 'failed', 'interrupted', 'paused', 'closed', 'pending_approval', 'awaiting_assistance', 'awaiting_question', 'approved'])
const ARTIFACT_KEYS = Object.freeze({
  run: 'run_json',
  report: 'report_json',
  markdown: 'report_markdown',
  submission: 'submission_csv',
  manifest: 'manifest_json'
})
const PHASE_PROGRESS = Object.freeze({
  queued: 0,
  session_initialization: 4,
  industry_chain_planning: 10,
  evidence_intake: 20,
  public_information_monitoring: 30,
  joint_independent_decision: 43,
  competition_joint_decision_initial: 43,
  competition_joint_decision_self_review: 62,
  competition_joint_decision: 68,
  single_pass_calibration: 82,
  competition_calibration: 82,
  direction_initial: 43,
  direction_self_review: 54,
  direction: 58,
  condition_initial: 68,
  condition_self_review: 76,
  condition: 82,
  supplemental_search: 85,
  report: 92,
  decision_direction_initial: 43,
  decision_direction_self_review: 55,
  decision_direction: 58,
  action_calibration: 61,
  risk_control_advice_initial: 68,
  risk_control_advice_self_review: 78,
  risk_control_advice: 82,
  risk_calibration: 84,
  reviewer_selection: 87,
  champion_gate: 89,
  shadow_validation: 85,
  aggregate_and_render: 90,
  persist_artifacts: 96,
  complete: 100
})
const STANDARD_TASK = '基于目标企业冻结的已发布公开信息，执行产业链风险传导分析，形成经营调整方向与风控建议。'

class WebJobManager {
  constructor({
    root = projectRoot(),
    runCaseImpl = runCase,
    createIndustryPlanImpl = createIndustryPlan,
    collectEvidenceImpl = null,
    concurrency = Number(process.env.RISK_AGENTS_WEB_CONCURRENCY || 2),
    batchLimit = Number(process.env.RISK_AGENTS_WEB_BATCH_LIMIT || 20),
    allowArchivedLegacy = false
  } = {}) {
    this.root = path.resolve(root)
    this.runCaseImpl = runCaseImpl
    this.createIndustryPlanImpl = createIndustryPlanImpl
    this.collectEvidenceImpl = collectEvidenceImpl
    this.allowArchivedLegacy = allowArchivedLegacy === true
    this.concurrency = Number.isInteger(concurrency) && concurrency > 0 ? Math.min(concurrency, 2) : 2
    this.batchLimit = Number.isInteger(batchLimit) && batchLimit > 0 ? Math.min(batchLimit, 20) : 20
    this.runtimeDirectory = path.join(this.root, '.runtime', 'web-ui')
    this.jobsDirectory = path.join(this.runtimeDirectory, 'jobs')
    this.logsDirectory = path.join(this.runtimeDirectory, 'logs')
    this.outputsDirectory = path.join(this.runtimeDirectory, 'outputs')
    this.intakeDirectory = path.join(this.runtimeDirectory, 'intake')
    this.importCatalogPath = path.join(this.runtimeDirectory, 'imported-companies.json')
    this.sourceConfigStore = new UserSourceConfigStore({ filePath: path.join(this.runtimeDirectory, 'user-public-sources.json') })
    this.jobs = new Map()
    this.active = new Set()
    this.writeChains = new Map()
    this.resumeInFlight = new Set()
    this.companies = []
    this.baseCompanies = []
    this.importedCompanyIds = new Set()
    this.agents = []
    this.caseCatalog = new Map()
    this.userSourceConfig = null
    this.builtInSources = []
    this.initialized = false
  }

  async initialize() {
    if (this.initialized) return this
    await Promise.all([
      fs.mkdir(this.jobsDirectory, { recursive: true }),
      fs.mkdir(this.logsDirectory, { recursive: true }),
      fs.mkdir(this.outputsDirectory, { recursive: true }),
      fs.mkdir(this.intakeDirectory, { recursive: true })
    ])
    const [companyData, agentConfig, sourceConfig, userSourceConfig] = await Promise.all([
      readJson(path.join(this.root, 'examples', 'companies.json')),
      readJson(path.join(this.root, 'config', 'agents.json')),
      readJson(path.join(this.root, 'config', 'enterprise-sources.json')),
      this.sourceConfigStore.load()
    ])
    this.builtInSources = (sourceConfig.sources || []).map(source => ({ id: source.id, label: source.label, source_type: source.source_type, access_mode: source.access_mode || 'manual', automatic: source.production_ingest_enabled === true && Boolean(source.adapter) && (source.id !== 'web_search' || userSourceConfig.search_backend.enabled === true), configured: Boolean(source.adapter || source.manual_import_enabled || source.base_url), claims: Array.isArray(source.claims) ? source.claims.slice(0, 3) : [] }))
    this.userSourceConfig = userSourceConfig
    this.baseCompanies = normalizeCompanyRecords(companyData)
    const imported = await this.loadImportedCompanies()
    this.importedCompanyIds = new Set(imported.map(item => item.company_id))
    this.companies = mergeCompanyRecords(this.baseCompanies, imported)
    this.agents = (agentConfig.roles || []).filter(agent => agent.stage !== 'task_reception' && (this.allowArchivedLegacy || ['industry_chain_planning','information_collection_monitoring','enterprise_direction','enterprise_condition','enterprise_review','periodic_improvement'].includes(agent.stage))).map(agent => ({
      agent_id: agent.id,
      label: agent.label,
      stage: agent.stage,
      model_profile: agent.model_profile,
      participates_in_debate: agent.participates_in_debate === true
    }))
    await this.refreshCaseCatalog()
    const entries = await fs.readdir(this.jobsDirectory, { withFileTypes: true })
    for (const entry of entries.filter(item => item.isFile() && item.name.endsWith('.json'))) {
      try {
        const job = await readJson(path.join(this.jobsDirectory, entry.name))
        job.v2_state ||= createV2State()
        if (job.status === 'running' || job.status === 'queued') {
          job.status = 'interrupted'
          job.stage = 'interrupted'
          job.phase = null
          job.active_agents = []
          job.updated_at = new Date().toISOString()
          job.failure = { code: 'WEB_SERVER_RESTARTED', message: '本地Web服务重启，任务已停在原断点。可确认后从断点继续。' }
          await writeJsonAtomic(path.join(this.jobsDirectory, entry.name), job)
        }
        this.jobs.set(job.job_id, job)
      } catch {
        // A malformed historical UI record is isolated instead of blocking startup.
      }
    }
    this.initialized = true
    return this
  }

  async refreshCaseCatalog() {
    this.caseCatalog = await discoverCases(this.root, this.companies.map(item => item.company_id))
    for (const company of this.companies) {
      const candidate = path.join(this.intakeDirectory, company.company_id, 'case.json')
      try {
        const stat = await fs.stat(candidate)
        const current = this.caseCatalog.get(company.company_id)
        if (!current || stat.mtimeMs > Date.parse(current.updated_at)) {
          this.caseCatalog.set(company.company_id, { case_path: candidate, updated_at: stat.mtime.toISOString(), mtime: stat.mtimeMs })
        }
      } catch (error) { if (error.code !== 'ENOENT') throw error }
    }
    return this.caseCatalog
  }

  async loadImportedCompanies() {
    try {
      const payload = await readJson(this.importCatalogPath)
      return normalizeCompanyRecords(payload)
    } catch (error) {
      if (error.code === 'ENOENT') return []
      throw error
    }
  }

  async importCompanies({ filename, content_base64: contentBase64 }) {
    await this.initialize()
    const parsed = await parseCompanyImport({ filename, contentBase64, allowMissingCompanyId: true })
    parsed.records = assignCompanyIds(parsed.records, this.companies.map(company => company.company_id))
    const existing = new Map(this.companies.map(company => [company.company_id, company]))
    for (const record of parsed.records) {
      const current = existing.get(record.company_id)
      if (current && normalizeCompanyName(current.company_name) !== normalizeCompanyName(record.company_name)) {
        throw badRequest(`company_id ${record.company_id} 已属于“${current.company_name}”，不能导入“${record.company_name}”。`)
      }
      if (current?.unified_social_credit_code && record.unified_social_credit_code && current.unified_social_credit_code !== record.unified_social_credit_code) {
        throw badRequest(`企业${record.company_id}的统一社会信用代码与现有记录不一致。`)
      }
    }
    const priorImported = await this.loadImportedCompanies()
    const mergedImported = mergeCompanyRecords(priorImported, parsed.records)
    await writeJsonAtomic(this.importCatalogPath, {
      contract_version: '1.0.0',
      dataset_id: 'web-imported-companies',
      source_file: parsed.filename,
      source_sha256: parsed.content_sha256,
      record_count: mergedImported.length,
      imported_at: new Date().toISOString(),
      records: mergedImported
    })
    this.importedCompanyIds = new Set(mergedImported.map(item => item.company_id))
    this.companies = mergeCompanyRecords(this.baseCompanies, mergedImported)
    await this.refreshCaseCatalog()
    const imported = parsed.records.map(record => this.listCompanies().find(item => item.company_id === record.company_id))
    return { filename: parsed.filename, imported_count: parsed.records.length, catalog_count: this.companies.length, companies: imported }
  }

  listCompanies() {
    return this.companies.map(company => {
      const available = this.caseCatalog.get(company.company_id)
      return {
        company_id: company.company_id,
        company_name: company.company_name,
        industry: company.industry,
        case_available: Boolean(available),
        case_updated_at: available?.updated_at || null,
        imported: this.importedCompanyIds.has(company.company_id),
        intake_required: true,
        selectable: true
      }
    })
  }

  listAgents() {
    return this.agents.map(agent => {
      const running = [...this.jobs.values()].filter(job => job.status === 'running' && job.agent_states?.[agent.agent_id]?.status === 'running')
      const queued = [...this.jobs.values()].filter(job => job.status === 'queued')
      return {
        ...agent,
        status: running.length ? 'running' : agent.stage === 'periodic_improvement' ? 'standby' : queued.length ? 'queued' : 'idle',
        current_companies: running.map(job => ({ company_id: job.company_id, company_name: job.company_name, phase: job.phase })),
        running_job_count: running.length
      }
    })
  }

  sourceSettings() {
    const searchBackend = structuredClone(this.userSourceConfig?.search_backend || { type: 'searxng', enabled: false, endpoint: '', jev_prefilter_enabled: false })
    return {
      built_in_sources: this.builtInSources.map(source => source.id === 'web_search' ? { ...source, automatic: this.userSourceConfig?.search_backend?.enabled === true } : structuredClone(source)),
      search_backend: { ...searchBackend, jev_prefilter_key_configured: Boolean(typeSafeApiKey()), jev_prefilter_active: searchBackend.enabled === true && searchBackend.jev_prefilter_enabled === true && Boolean(typeSafeApiKey()) },
      websites: structuredClone(this.userSourceConfig?.websites || []),
      notes: [
        '新模式默认来源只列当前核验可取数的巨潮资讯和国务院政策；联网检索需配置SearXNG。',
        '自定义网站通过用户自托管SearXNG发现公开页面；正文仍由本系统抓取、校验发布日期并固化快照。',
        '公开JSON API可配置查询参数和字段路径；当前仅允许无需密钥的HTTPS GET接口。',
        '不绕过登录、验证码、WAF或网站访问控制。'
      ]
    }
  }

  async updateSourceSettings(value) {
    await this.initialize()
    this.userSourceConfig = await this.sourceConfigStore.save(value)
    return this.sourceSettings()
  }

  listJobs() {
    return [...this.jobs.values()]
      .sort((left, right) => right.created_at.localeCompare(left.created_at))
      .map(job => publicJobSummary(job))
  }

  async getJob(jobId) {
    await this.waitForPendingWrite(jobId)
    const job = this.jobs.get(jobId)
    if (!job) throw notFound(`任务不存在：${jobId}`)
    return publicJob(job)
  }

  async getLogs(jobId) {
    const job = this.jobs.get(jobId)
    if (!job) throw notFound(`任务不存在：${jobId}`)
    let text = ''
    try {
      text = await fs.readFile(job.log_path, 'utf8')
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    const maximum = 200000
    return { text: text.length > maximum ? text.slice(-maximum) : text, truncated: text.length > maximum }
  }

  async createBatch(input) {
    const previous = this.batchAdmission || Promise.resolve()
    const pending = previous.catch(() => {}).then(() => this.createBatchInternal(input))
    this.batchAdmission = pending.catch(() => {})
    return pending
  }

  async createBatchInternal({ company_ids: companyIds, user_consent: userConsent, consent_action: consentAction, decision_mode: decisionMode = ENTERPRISE_MODE, question = null, rules = [], experience = [], search_sites: searchSites = [] }) {
    await this.initialize()
    if (decisionMode !== ENTERPRISE_MODE && !this.allowArchivedLegacy) throw badRequest('旧版经营分析已存档；请勾选企业并启动固定的产业链风险及决策分析。')
    assertStartAnalysisConsent(userConsent, consentAction)
    if (!Array.isArray(companyIds)) throw badRequest('company_ids必须是企业编号数组。')
    const ids = [...new Set(companyIds.map(value => String(value).trim().padStart(3, '0')))]
    if (!ids.length) throw badRequest('请至少勾选一家企业。')
    if (ids.length > this.batchLimit) throw badRequest(`单次最多进件${this.batchLimit}家企业。`)
    const occupied = [...this.jobs.values()].filter(job => ['queued', 'running'].includes(job.status)).length
    if (occupied + ids.length > this.batchLimit) throw badRequest(`进件容量上限${this.batchLimit}家，当前运行及排队${occupied}家，还可进件${Math.max(0, this.batchLimit - occupied)}家。`)
    for (const companyId of ids) {
      const company = this.companies.find(item => item.company_id === companyId)
      if (!company) throw badRequest(`未找到企业编号：${companyId}`)
      const duplicate = [...this.jobs.values()].find(job => job.company_id === companyId && ['queued', 'running'].includes(job.status))
      if (duplicate) throw badRequest(`企业${companyId}已有排队或运行中的任务。`)
      if (decisionMode !== ENTERPRISE_MODE && !this.caseCatalog.has(companyId) && !this.importedCompanyIds.has(companyId)) throw badRequest(`企业${companyId}没有可用案例，也不是本次导入企业。`)
    }
    if (!Array.isArray(rules) || !Array.isArray(experience) || [...rules,...experience].some(x => typeof x !== 'string')) throw badRequest('规则和经验必须为字符串数组。')
    const normalizedSites = normalizeSearchSites(searchSites)
    const jobs = []
    const consentTime = new Date().toISOString()
    for (const companyId of ids) jobs.push(await this.createJob({
      company_id: companyId,
      deferPump: true,
      user_consent: true,
      consent_action: 'start_analysis',
      consent_time: consentTime, decision_mode: decisionMode, question, rules, experience, search_sites: normalizedSites
    }))
    this.pump()
    return { batch_limit: this.batchLimit, accepted_count: jobs.length, jobs }
  }

  async createJob({ company_id: requestedCompanyId, deferPump = false, user_consent: userConsent, consent_action: consentAction, consent_time: consentTime = null, decision_mode: decisionMode = ENTERPRISE_MODE, question = null, rules = [], experience = [], search_sites: searchSites = [] }) {
    await this.initialize()
    if (decisionMode !== ENTERPRISE_MODE && !this.allowArchivedLegacy) throw badRequest('旧版经营分析已存档；请勾选企业并启动固定的产业链风险及决策分析。')
    assertStartAnalysisConsent(userConsent, consentAction)
    if (!['competition_calibrated_v2', ENTERPRISE_MODE].includes(decisionMode)) throw badRequest('不支持的决策模式。')
    await this.refreshCaseCatalog()
    const company = resolveCompany(this.companies, { task: '', companyId: requestedCompanyId })
    const caseRecord = this.caseCatalog.get(company.company_id)
    if (decisionMode !== ENTERPRISE_MODE && !caseRecord && !this.importedCompanyIds.has(company.company_id)) throw badRequest(`企业${company.company_id}尚无可运行case.json，请先导入企业并完成公开证据建案。`)
    if (decisionMode === ENTERPRISE_MODE) question = fixedQuestion(company.company_name)
    if (decisionMode === ENTERPRISE_MODE && (!Array.isArray(rules) || !Array.isArray(experience))) throw badRequest('经验和规则必须分别为数组。')
    const clarification = decisionMode === ENTERPRISE_MODE ? clarifyQuestion(question) : null
    const now = new Date().toISOString()
    const jobId = `web-${company.company_id}-${now.replace(/[:.]/g, '-')}-${crypto.randomUUID().slice(0, 8)}`
    const outputDirectory = path.join(this.outputsDirectory, jobId)
    const agentStates = Object.fromEntries(this.agents.map(agent => [agent.agent_id, {
      ...agent,
      status: agent.stage === 'periodic_improvement' ? 'not_in_case' : 'idle',
      phase: null,
      operation: null,
      started_at: null,
      completed_at: null,
      error_code: null
    }]))
    const job = {
      contract_version: '1.0.0',
      job_id: jobId,
      task: decisionMode === ENTERPRISE_MODE ? FIXED_TASK : STANDARD_TASK,
      decision_mode: decisionMode, question, rules, experience, search_sites: searchSites, clarification, runtime_messages: [], approval_history: [],
      user_consent: true,
      consent_time: consentTime || now,
      consent_action: 'start_analysis',
      company_id: company.company_id,
      company_name: company.company_name,
      // Enterprise decisions require current, locally verifiable snapshots. Historical
      // competition cases may refer to evidence files on another machine.
      case_path: decisionMode === ENTERPRISE_MODE ? null : caseRecord?.case_path || null,
      case_updated_at: decisionMode === ENTERPRISE_MODE ? null : caseRecord?.updated_at || null,
      intake_required: decisionMode === ENTERPRISE_MODE || !caseRecord,
      output_directory: outputDirectory,
      model_call_checkpoint_root: path.join(outputDirectory, 'model-call-checkpoints'),
      log_path: path.join(this.logsDirectory, `${jobId}.log`),
      status: clarification && !clarification.valid ? 'awaiting_question' : 'queued',
      stage: clarification && !clarification.valid ? 'awaiting_question' : 'queued',
      phase: clarification && !clarification.valid ? 'awaiting_question' : 'queued',
      progress_percent: 0,
      run_id: null,
      evidence_count: null,
      active_agents: [],
      agent_states: agentStates,
      events: [],
      result: null,
      failure: null,
      v2_state: createV2State(),
      created_at: now,
      started_at: null,
      completed_at: null,
      updated_at: now
    }
    // Publish in memory only after the task is durably registered.
    await this.persistJob(job)
    this.jobs.set(jobId, job)
    await fs.appendFile(job.log_path, `${now} [queued] 已自动进件：${company.company_id} · ${company.company_name}\n`, 'utf8')
    if (!deferPump) this.pump()
    return publicJob(job)
  }

  async runtimeCommand(jobId, { message } = {}) {
    await this.initialize()
    const job = this.jobs.get(jobId)
    if (!job || job.decision_mode !== ENTERPRISE_MODE) throw badRequest('请选择当前版本的运行任务。')
    const text = String(message || '').trim()
    if (!text || text.length > 4000) throw badRequest('消息需为1至4000字。')
    let reply
    if (/^(?:当前)?(?:状态|进度|流程)[？?。！!]*$/.test(text)) {
      const statuses = { queued: '排队中', running: '运行中', approved: '已交付', awaiting_assistance: '待人工协助', failed: '失败', paused: '已暂停', interrupted: '已中断', closed: '已关闭' }
      const phases = { awaiting_assistance: '待人工协助', approved: '已交付', failed: '运行失败', queued: '等待调度', direction: '经营方向分析', condition: '行动建议分析', evidence_intake: '证据门禁', report: '报告校验' }
      reply = `任务：${FIXED_TASK}；状态：${statuses[job.status] || job.status}；阶段：${phases[job.phase] || job.phase || '等待调度'}；进度：${job.progress_percent || 0}%。`
    } else if (/^(?:失败原因|解释失败|为什么失败|为什么|缺少什么|缺口)[？?。！!]*$/.test(text)) {
      reply = (job.failure ? failureMessage(job.failure) : '') || (job.assistance_request ? formatAssistance(job.assistance_request.gaps) : '') || '当前没有阻断缺口。'
    } else if (/^(?:从断点继续|继续|恢复|重试)[。！!]*$/.test(text)) {
      if (job.status === 'awaiting_assistance') await this.supplementEnterpriseJob(jobId, {})
      else await this.resumeJob(jobId)
      reply = '已提交当前任务的恢复请求。'
    } else if (/^(?:关闭任务|无需继续)[。！!]*$/.test(text)) {
      await this.closeEnterpriseJob(jobId)
      reply = '当前待协助任务已关闭。'
    } else if (/^(?:补充规则|补充经验)[：:]/.test(text)) {
      const field = text.startsWith('补充规则') ? 'rules' : 'experience'
      const value = text.slice(text.search(/[：:]/) + 1).trim()
      if (!value) throw badRequest('补充内容不能为空。')
      await this.supplementEnterpriseJob(jobId, { [field]: [...(job[field] || []), value] })
      reply = '补充已记录，将重新校验受影响的证据和决策版本后继续。'
    } else {
      reply = '此处仅处理当前任务的运行交互。可发送“当前状态”“缺口”“从断点继续”“关闭任务”；待人工协助时可发送“补充规则：内容”或“补充经验：内容”。消息已记录，尚未改变分析依据。新分析请在企业选择区点击“开始分析”。'
    }
    await this.mutateJob(jobId, async current => {
      current.runtime_messages ||= []
      current.runtime_messages.push({ role: 'user', label: '你', message: text, at: new Date().toISOString() }, { role: 'agent', label: '运行协调Agent', message: reply, ...(job.assistance_request && /^(?:失败原因|解释失败|为什么失败|为什么|缺少什么|缺口)[？?。！!]*$/.test(text) ? { kind: 'assistance', gaps: job.assistance_request.gaps } : {}), at: new Date().toISOString() })
    })
    return { job: publicJob(this.jobs.get(jobId)), reply }
  }

  async supplementEnterpriseJob(jobId, { question, rules, experience, evidence = [] } = {}) {
    await this.initialize()
    const existing = this.jobs.get(jobId)
    if (!existing || existing.decision_mode !== ENTERPRISE_MODE) throw notFound('企业决策任务不存在。')
    if (!['awaiting_question', 'awaiting_assistance', 'pending_approval'].includes(existing.status)) throw badRequest('当前任务不能补充。')
    if (!Array.isArray(evidence)) throw badRequest('补充证据必须是数组。')
    await this.mutateJob(jobId, async job => {
      if (question && question.question !== FIXED_TASK) throw badRequest('固定任务不能通过运行对话修改。')
      if (rules !== undefined) { if (!Array.isArray(rules)) throw badRequest('规则必须是数组。'); job.rules = rules }
      if (experience !== undefined) { if (!Array.isArray(experience)) throw badRequest('经验必须是数组。'); job.experience = experience }
      job.clarification = clarifyQuestion(job.question)
      if (evidence.length) {
        const assistance = new ManualAssistanceService({ root: this.root })
        const validated = []
        for (const requested of evidence) {
          if (!requested?.manual_assistance_id) throw badRequest('补充证据必须先经人工协助存证。')
          const { request } = await assistance.get(requested.manual_assistance_id)
          if (request.status !== 'evidence_validated' || request.evidence?.id !== requested.id) throw badRequest('补充证据未经验证。')
          const errors = await verifyEvidenceSnapshots([request.evidence], { snapshotRoot: assistance.snapshotDirectory, productionMode: true })
          if (errors.length) throw badRequest(`证据快照未通过验证：${errors.join('; ')}`)
          validated.push(request.evidence)
        }
        evidence = validated
        const caseData = await readJson(job.case_path)
        const mergedSnapshotRoot = path.join(job.output_directory, `manual-evidence-snapshots-${Date.now()}`)
        await fs.mkdir(mergedSnapshotRoot, { recursive: true })
        if (caseData.evidence_snapshot_root) {
          for (const item of caseData.evidence) if (item.snapshot_ref) await fs.copyFile(path.join(caseData.evidence_snapshot_root, item.snapshot_ref), path.join(mergedSnapshotRoot, item.snapshot_ref))
        }
        for (const item of evidence) await fs.copyFile(path.join(assistance.snapshotDirectory, item.snapshot_ref), path.join(mergedSnapshotRoot, item.snapshot_ref))
        caseData.evidence_snapshot_root = mergedSnapshotRoot
        const existingIds = new Set(caseData.evidence.map(item => item.id))
        for (const item of evidence) {
          if (!item?.id || existingIds.has(item.id) || !item.source_url || !item.publisher || !item.summary) throw badRequest('补充证据缺少必要字段或ID重复。')
          existingIds.add(item.id); caseData.evidence.push(item)
        }
        const nextPath = path.join(job.output_directory, `case-evidence-${Date.now()}.json`)
        await fs.mkdir(job.output_directory, { recursive: true })
        await writeJsonAtomic(nextPath, caseData)
        job.case_path = nextPath
      }
      job.status = job.clarification.valid ? 'queued' : 'awaiting_question'
      job.stage = job.status; job.phase = job.status; job.result = null; job.failure = null
    })
    this.pump()
    return publicJob(this.jobs.get(jobId))
  }

  async recordEnterpriseFeedback(jobId, { experience = '', observed_outcome = '', recorded_by = 'Jeff' } = {}) {
    await this.initialize()
    const existing = this.jobs.get(jobId)
    if (!existing || existing.decision_mode !== ENTERPRISE_MODE) throw notFound('企业决策任务不存在。')
    if (!['approved', 'closed'].includes(existing.status)) throw badRequest('反馈只能记录于已批准或已关闭的任务。')
    if (!String(experience).trim() && !String(observed_outcome).trim()) throw badRequest('请填写经验或实际结果。')
    await this.mutateJob(jobId, async job => {
      job.offline_feedback ||= []
      job.offline_feedback.push({ report_version: job.result?.report_version || null, experience: String(experience).trim(), observed_outcome: String(observed_outcome).trim(), recorded_by: String(recorded_by).trim(), recorded_at: new Date().toISOString(), online_rule_update: false })
    })
    return publicJob(this.jobs.get(jobId))
  }

  async closeEnterpriseJob(jobId, { reason = '用户确认无需继续' } = {}) {
    await this.initialize()
    const existing = this.jobs.get(jobId)
    if (!existing || existing.decision_mode !== ENTERPRISE_MODE) throw notFound('企业决策任务不存在。')
    if (!['awaiting_question', 'awaiting_assistance'].includes(existing.status)) throw badRequest('只有待补充任务可以关闭。')
    await this.mutateJob(jobId, async job => {
      job.status = 'closed'; job.stage = 'closed'; job.phase = 'closed'
      job.closed_reason = String(reason).trim() || '用户确认无需继续'
      job.closed_at = new Date().toISOString()
    })
    return publicJob(this.jobs.get(jobId))
  }

  async decideEnterpriseApproval(jobId, { decision, reviewer = 'Jeff', reason = '', approval_token: approvalToken = '' } = {}) {
    await this.initialize()
    const existing = this.jobs.get(jobId)
    if (!existing || existing.decision_mode !== ENTERPRISE_MODE) throw notFound('企业决策任务不存在。')
    if (existing.status !== 'pending_approval') throw badRequest('只有待审批版本可以审批。')
    if (!['approve', 'return'].includes(decision) || reviewer !== 'Jeff') throw badRequest('仅Jeff可批准或退回报告。')
    const expectedToken = process.env.RULORA_JEFF_APPROVAL_TOKEN
    if (!expectedToken || !approvalToken || !crypto.timingSafeEqual(crypto.createHash('sha256').update(approvalToken).digest(), crypto.createHash('sha256').update(expectedToken).digest())) throw badRequest('审批凭证缺失或无效。')
    await this.mutateJob(jobId, async job => {
      job.approval_history.push({ report_version: job.result.report_version, decision, reviewer, reason, at: new Date().toISOString() })
      job.status = decision === 'approve' ? 'approved' : 'awaiting_assistance'
      job.stage = job.status; job.phase = job.status
    })
    return publicJob(this.jobs.get(jobId))
  }

  checkpointRootForJob(job) {
    // New UI jobs own an isolated checkpoint directory. Historical jobs used the
    // runtime-wide store, so retain that fallback to make their completed calls reusable.
    return job.model_call_checkpoint_root || path.join(this.root, '.runtime', 'model-call-checkpoints')
  }

  async resumeJob(jobId) {
    const pending = (this.batchAdmission || Promise.resolve()).catch(() => {}).then(() => this.resumeJobInternal(jobId))
    this.batchAdmission = pending.catch(() => {})
    return pending
  }

  async resumeJobInternal(jobId) {
    await this.initialize()
    if (this.resumeInFlight.has(jobId) || this.active.has(jobId)) throw badRequest('该任务正在恢复或运行，请勿重复提交。')
    this.resumeInFlight.add(jobId)
    try {
      const existing = this.jobs.get(jobId)
      if (!existing) throw notFound(`任务不存在：${jobId}`)
      if (existing.decision_mode !== ENTERPRISE_MODE && !this.allowArchivedLegacy) throw badRequest('旧版任务已存档，仅供查看，不能继续运行。请发起新决策任务。')
      if (!['failed', 'paused', 'interrupted'].includes(existing.status)) {
        throw badRequest('只有失败、暂停或中断的任务可以从断点继续。')
      }
      if (existing.user_consent !== true || existing.consent_action !== 'start_analysis') {
        throw badRequest('原任务缺少“开始进件分析”授权，不能恢复。')
      }
      if ([...this.jobs.values()].filter(job => ['queued', 'running'].includes(job.status)).length >= this.batchLimit) throw badRequest(`进件容量已达${this.batchLimit}家，请等待空位后恢复。`)
      await this.mutateJob(jobId, async job => {
        if (!['failed', 'paused', 'interrupted'].includes(job.status)) throw badRequest('任务状态已变化，请刷新后再操作。')
        if (job.decision_mode === ENTERPRISE_MODE && job.failure?.code === 'ENTERPRISE_EVIDENCE_INVALID') {
          job.force_evidence_recollection = true
          job.archived_case_path = job.case_path
          job.case_path = null
          job.case_updated_at = null
          job.intake_required = true
          await this.appendLog(job, '[resume] 原证据快照不可用；保留旧案例路径供审计，重新采集并固化公开证据。')
        }
        const now = new Date().toISOString()
        job.status = 'queued'
        job.stage = 'queued'
        job.phase = 'queued'
        job.active_agents = []
        job.failure = null
        job.completed_at = null
        job.resume_count = Number(job.resume_count || 0) + 1
        job.resumed_at = now
        job.model_call_checkpoint_root ||= this.checkpointRootForJob(job)
        for (const state of Object.values(job.agent_states || {})) {
          if (state.status === 'failed' || state.status === 'running') {
            state.status = 'idle'
            state.error_code = null
            state.started_at = null
            state.completed_at = null
          }
        }
        await this.appendLog(job, '[resume] 用户确认从断点继续；已完成节点保持不变，仅执行失败和未完成节点。')
      })
      this.pump()
      return publicJob(this.jobs.get(jobId))
    } finally {
      this.resumeInFlight.delete(jobId)
    }
  }

  async resolveActionDisagreement(jobId, { mode, direction = null } = {}) {
    await this.initialize()
    const existing = this.jobs.get(jobId)
    if (!existing) throw notFound(`任务不存在：${jobId}`)
    if (!this.allowArchivedLegacy) throw badRequest('旧版任务已存档，仅供查看，不能继续运行。')
    if (existing.failure?.code !== 'PAUSED_ACTION_UNRESOLVED') throw badRequest('当前任务不是需要人工处理的经营方向分歧。')
    if (mode === 'reanalyze') {
      await fs.rm(this.checkpointRootForJob(existing), { recursive: true, force: true })
      await this.mutateJob(jobId, async job => {
        job.manual_action_direction = null
        job.manual_action_resolution = { mode: 'reanalyze', recorded_at: new Date().toISOString() }
        job.events = []
        job.v2_state = createV2State()
        for (const state of Object.values(job.agent_states || {})) if (state.participates_in_debate) Object.assign(state, { status: 'idle', phase: null, operation: null, started_at: null, completed_at: null, error_code: null })
        await this.appendLog(job, '[human] 用户确认重新进行三席独立分析；旧日志保留，模型调用缓存已清除。')
      })
      return this.resumeJob(jobId)
    }
    const mapping = { tighten: 'risk_up', maintain: 'risk_flat', increase: 'risk_down', risk_up: 'risk_up', risk_flat: 'risk_flat', risk_down: 'risk_down' }
    const selected = mapping[String(direction || '')]
    if (mode !== 'adjudicate' || !selected) throw badRequest('请选择有效的人工经营方向。')
    await this.mutateJob(jobId, async job => {
      job.manual_action_direction = selected
      job.manual_action_resolution = { mode: 'adjudicate', direction: selected, recorded_at: new Date().toISOString() }
      await this.appendLog(job, `[human] 三席方向未收敛，用户人工裁决经营方向=${selected}；三席原意见保持不变。`)
    })
    return this.resumeJob(jobId)
  }

  async getArtifact(jobId, kind) {
    const job = this.jobs.get(jobId)
    if (!job) throw notFound(`任务不存在：${jobId}`)
    const artifactKey = ARTIFACT_KEYS[kind]
    if (!artifactKey) throw notFound(`未知产物类型：${kind}`)
    const filePath = job.result?.artifacts?.[artifactKey]
    if (!filePath) throw notFound('该产物尚未生成。')
    const resolved = path.resolve(filePath)
    if (!isPathInside(path.resolve(job.output_directory), resolved)) throw badRequest('产物路径超出任务输出目录。')
    await fs.access(resolved)
    return resolved
  }

  systemSnapshot() {
    return {
      initialized: this.initialized,
      decision_mode: ENTERPRISE_MODE,
      archived_legacy_jobs: [...this.jobs.values()].filter(job => job.decision_mode !== ENTERPRISE_MODE).length,
      concurrency: this.concurrency,
      batch_limit: this.batchLimit,
      running_jobs: this.active.size,
      queued_jobs: [...this.jobs.values()].filter(job => job.status === 'queued' && (job.decision_mode === ENTERPRISE_MODE || this.allowArchivedLegacy)).length,
      total_jobs: this.jobs.size
    }
  }

  pump() {
    while (this.active.size < this.concurrency) {
      const next = [...this.jobs.values()]
        .filter(job => job.status === 'queued' && !this.active.has(job.job_id) && (job.decision_mode === ENTERPRISE_MODE || this.allowArchivedLegacy))
        .sort((left, right) => left.created_at.localeCompare(right.created_at))[0]
      if (!next) return
      this.active.add(next.job_id)
      void this.execute(next.job_id)
    }
  }

  async execute(jobId) {
    const authorized = this.jobs.get(jobId)
    if (authorized?.decision_mode !== ENTERPRISE_MODE && !this.allowArchivedLegacy) throw badRequest('旧版任务已存档，仅供查看，不能继续运行。')
    if (authorized?.user_consent !== true || authorized?.consent_action !== 'start_analysis') {
      throw badRequest('任务缺少“开始进件分析”授权，不能运行。')
    }
    const startedAt = new Date().toISOString()
    await this.mutateJob(jobId, async job => {
      job.status = 'running'
      job.stage = 'session_initialization'
      job.phase = 'session_initialization'
      job.progress_percent = PHASE_PROGRESS.session_initialization
      job.started_at = startedAt
      await this.appendLog(job, `[running] 开始执行真实多Agent分析；${job.intake_required ? '先采集公开证据' : '复用冻结证据'}，本次重新调用LLM。`)
    })
    try {
      let job = this.jobs.get(jobId)
      const missingEnterprisePlan = job.decision_mode === ENTERPRISE_MODE && !(await fs.stat(path.join(job.output_directory, 'industry-plan.json')).catch(() => null))
      if (!job.case_path || missingEnterprisePlan) {
        await this.prepareImportedCase(jobId)
        job = this.jobs.get(jobId)
      }
      if (job.decision_mode === ENTERPRISE_MODE) {
        await this.executeEnterprise(jobId, job)
        return
      }
      const run = await this.runCaseImpl({
        allowArchivedLegacy: this.allowArchivedLegacy,
        inputPath: job.case_path,
        outputDirectory: job.output_directory,
        task: job.task,
        mode: 'competition_calibrated_v2',
        reuseFrozenEvidence: job.intake_required !== true,
        modelCallCheckpointRoot: this.checkpointRootForJob(job),
        onProgress: event => this.recordProgress(jobId, event),
        manualActionDirection: job.manual_action_direction || null
      })
      await this.mutateJob(jobId, async current => {
        current.status = 'succeeded'
        current.stage = 'committed'
        current.phase = 'complete'
        current.progress_percent = 100
        current.active_agents = []
        current.completed_at = new Date().toISOString()
        current.run_id = run.run_id
        current.result = summarizeRun(run)
        await this.appendLog(current, `[succeeded] 完成。action=${current.result.action}，风控建议=${current.result.risk_control_advice.join(',')}。`)
      })
    } catch (error) {
      await this.mutateJob(jobId, async job => {
        const evidenceClosed = ['EVIDENCE_INCOMPLETE', 'EVIDENCE_SOURCE_DIVERSITY_INSUFFICIENT'].includes(String(error.code || ''))
        job.status = evidenceClosed ? 'closed' : String(error.code || '').startsWith('PAUSED_') ? 'paused' : 'failed'
        if (evidenceClosed) {
          job.closed_at_progress_percent = job.progress_percent
          job.stage = 'closed'
          job.progress_percent = 100
        }
        job.active_agents = []
        job.completed_at = new Date().toISOString()
        job.failure = failureDetails(error)
        job.runtime_messages ||= []
        job.runtime_messages.push({ role: 'agent', label: '运行协调Agent', kind: 'error', at: new Date().toISOString(), message: `任务停止。${failureMessage(job.failure)} 已完成结果和证据已保留，可在修复服务后输入“从断点继续”。` })
        for (const state of Object.values(job.agent_states)) if (state.status === 'running') state.status = evidenceClosed ? 'closed' : 'failed'
        await this.appendLog(job, `[${evidenceClosed ? 'closed' : 'failed'}] ${job.failure.code}: ${job.failure.message}`)
      })
    } finally {
      this.active.delete(jobId)
      this.pump()
    }
  }

  async executeEnterprise(jobId, job) {
    const caseData = await readJson(job.case_path)
    const run = await runEnterpriseDecision({ caseData, question: job.question, rules: job.rules, experience: job.experience, outputDirectory: job.output_directory, checkpointRoot: this.checkpointRootForJob(job), onProgress: event => this.recordProgress(jobId, event), supplementalSearch: async ({ gaps, caseData: currentCase, question, scope, round }) => this.searchEnterpriseGaps(jobId, currentCase, question, gaps, scope, round) })
    await this.mutateJob(jobId, async current => {
      current.status = run.status
      current.stage = run.status; current.phase = run.status
      if (run.status === 'approved') {
        current.approval_history ||= []
        current.approval_history.push({ report_version: run.metadata.report_version, decision: 'approve', reviewer: 'system', reason: '证据来源、两层冻结结果与报告门禁均通过', at: new Date().toISOString() })
        current.progress_percent = 100
      }
      current.active_agents = []
      current.run_id = run.run_id || null
      current.completed_at = new Date().toISOString()
      current.result = run.report ? { decision_mode: ENTERPRISE_MODE, report: run.report, report_version: run.metadata.report_version, gaps: run.gaps, artifacts: run.artifacts, metadata: run.metadata } : null
      current.assistance_request = run.status === 'awaiting_assistance' ? { gaps: run.gaps, direction: run.metadata?.stages?.direction, condition: run.metadata?.stages?.condition } : null
      if (run.status === 'awaiting_assistance') {
        current.runtime_messages ||= []
        current.runtime_messages.push({ role: 'agent', label: '运行协调Agent', kind: 'assistance', message: formatAssistance(run.gaps), gaps: run.gaps, at: new Date().toISOString() })
      }
      await this.appendLog(current, `[enterprise] ${run.status}; report_version=${run.metadata?.report_version || 'none'}`)
    })
  }

  enterpriseCollectionRequest(jobId, company, asOfDate, question, gaps = [], scope = 'initial', round = 0) {
    const subject = String(question?.subject || company.name || company.company_name || '').trim()
    const matter = String(question?.matter || '').trim()
    const terms = [...new Set([subject, question?.question, matter, ...gaps].map(value => String(value || '').trim()).filter(Boolean))].slice(0, 6)
    const query = scope === 'expanded' ? [subject, ...gaps].filter(Boolean).join(' ') : terms.join(' ')
    // The government policy endpoint rejects long enterprise-specific sentences.
    // Search its policy corpus with a concise topic instead of the company question.
    const policyTopic = /经营决策|经营|贷款|融资/.test(`${question?.question || ''} ${matter}`)
      ? '经营决策'
      : String(matter || '产业政策').trim().replace(/[，,。；;：:\s].*$/, '').slice(0, 8) || '产业政策'
    const industryTopic = String(company.industry || '')
      .split(/[、，,和]/)
      .map(part => part.trim().replace(/^其他/, '').replace(/(?:制造业|服务业|工业|产业|业)$/, ''))
      .filter(Boolean)
      .sort((left, right) => right.length - left.length)[0]?.slice(0, 8) || '产业政策'
    const policyQuery = scope === 'initial' ? policyTopic : industryTopic
    const startDate = new Date(`${asOfDate}T00:00:00Z`)
    startDate.setUTCFullYear(startDate.getUTCFullYear() - 5)
    const startDateText = startDate.toISOString().slice(0, 10)
    const sources = this.builtInSources.filter(source => source.automatic && source.id !== 'web_search')
    if (this.userSourceConfig?.search_backend?.enabled) {
      sources.push({ id: 'web_search' })
      for (const site of this.jobs.get(jobId)?.search_sites || []) sources.push({ id: 'web_search', site })
    }
    for (const site of this.userSourceConfig?.websites || []) if (site.enabled !== false) sources.push({ id: site.id })
    const queries = sources.filter(source => source.id).map((source, index) => ({ query_id: `enterprise:${scope}:${round}:${index + 1}`, query_origin: scope, source_id: source.id, query: source.site ? `site:${source.site} ${query}` : source.id === 'cninfo' ? subject : source.id === 'government_policy' ? policyQuery : query, query_terms: source.id === 'cninfo' ? [subject] : source.id === 'government_policy' ? [policyQuery] : terms, start_date: startDateText, end_date: asOfDate, max_records: source.id === 'government_policy' ? 8 : 5, fetch_documents: true, required: false, min_evidence: 0 }))
    // Recent announcements alone can hide the latest financial statements.
    // CNINFO's full-text search accepts the complete company name followed by
    // the exact reporting period; retain both the report and its short summary.
    if (sources.some(source => source.id === 'cninfo')) {
      const year = Number(asOfDate.slice(0, 4))
      const reportPeriods = [
        ...(asOfDate.slice(5) >= '08-31' ? [`${year}年半年度报告`] : []),
        `${year - 1}年年度报告`
      ]
      for (const period of reportPeriods) queries.push({
        query_id: `enterprise:${scope}:${round}:cninfo-report:${period}`,
        query_origin: scope,
        source_id: 'cninfo',
        query: `${subject}${period}`,
        query_terms: [subject, period],
        start_date: startDateText,
        end_date: asOfDate,
        max_records: 5,
        fetch_documents: true,
        required: false,
        min_evidence: 0
      })
    }
    return { contract_version: '1.0.0', request_id: `${jobId}-${scope}-${round}-${Date.now()}`, company: { id: company.id || company.company_id, name: company.name || company.company_name }, as_of_date: asOfDate, public_information_only: true, queries }
  }

  async searchEnterpriseGaps(jobId, caseData, question, gaps, scope = 'targeted', round = 1) {
    const job = this.jobs.get(jobId)
    const request = this.enterpriseCollectionRequest(jobId, caseData.company, caseData.as_of_date, question, gaps, scope, round)
    const snapshotDirectory = path.join(job.output_directory, 'supplemental-evidence-snapshots')
    try {
      const packet = await new PublicSourceCollector({ snapshotDirectory, userSourceConfig: this.userSourceConfig }).collect(request)
      await writeJsonAtomic(path.join(job.output_directory, `supplemental-search-${round}.json`), { request, packet })
      const existing = new Set(caseData.evidence.map(item => `${item.source_url}|${item.content_sha256}`))
      const added = packet.evidence.filter(item => !existing.has(`${item.source_url}|${item.content_sha256}`) && item.public === true && item.published_at <= caseData.as_of_date)
      if (added.length) {
        if (caseData.evidence_snapshot_root) for (const item of caseData.evidence) {
          if (!item.snapshot_ref) continue
          await fs.copyFile(path.join(caseData.evidence_snapshot_root, item.snapshot_ref), path.join(snapshotDirectory, item.snapshot_ref))
        }
        const nextPath = path.join(job.output_directory, `case-evidence-${Date.now()}.json`)
        await writeJsonAtomic(nextPath, { ...caseData, evidence: [...caseData.evidence, ...added], evidence_snapshot_root: snapshotDirectory })
        await this.mutateJob(jobId, async current => { current.case_path = nextPath; current.supplemental_search = { status: packet.status, scope, round, added_count: added.length, source_runs: packet.source_runs } })
      }
      return { status: packet.status, evidence: added, snapshot_root: snapshotDirectory, source_runs: packet.source_runs }
    } catch (error) {
      await this.mutateJob(jobId, async current => { current.supplemental_search = { status: 'failed', scope, round, error: String(error.message || error) } })
      return { status: 'failed', evidence: [], error: String(error.message || error) }
    }
  }

  async prepareEnterpriseImportedCase(jobId) {
    const job = this.jobs.get(jobId)
    const company = this.companies.find(item => item.company_id === job.company_id)
    if (!company) throw badRequest('企业不存在。')
    const asOfDate = job.intake_as_of_date || shanghaiCalendarDate()
    if (!job.intake_as_of_date) await this.mutateJob(jobId, async current => { current.intake_as_of_date = asOfDate })
    const companyRoot = job.output_directory
    const snapshotRoot = path.join(companyRoot, 'evidence-snapshots')
    await fs.mkdir(companyRoot, { recursive: true })
    const planningEvent = { phase: 'industry_chain_planning', agent_id: 'industry_research_planner', agent_label: '前置产业链研究规划员' }
    await this.recordProgress(jobId, { ...planningEvent, type: 'agent_started' })
    const binding = { job_id: jobId, company_id: company.company_id, as_of_date: asOfDate, input_sha256: sha256(canonicalJson({ company, task: job.task, question: job.question })) }
    const planPath = path.join(companyRoot, 'industry-plan.json')
    const validators = await loadSchemaValidators(projectRoot())
    const validatePlan = value => {
      assertSchema(validators.industryPlan, value, 'industry plan checkpoint')
      const errors = validateIndustryPlan(value, { agent_id: 'industry_research_planner' })
      if (errors.length) throw new Error(errors.join('; '))
    }
    let planning
    try {
      const exists = await fs.stat(planPath).catch(error => { if (error.code !== 'ENOENT') throw error; return null })
      if (exists) {
        planning = await readJson(planPath)
        if (canonicalJson(planning.resume_binding) !== canonicalJson(binding) || planning.plan_sha256 !== sha256(canonicalJson(planning.industry_plan))) throw Object.assign(new Error('规划断点归属或内容校验失败，需核验存档后恢复。'), { code: 'INTAKE_CHECKPOINT_INVALID' })
        validatePlan(planning.industry_plan)
      } else {
        planning = await this.createIndustryPlanImpl({ caseData: { ...buildPlanningCase(company, asOfDate), decision_mode: ENTERPRISE_MODE, operator_task: job.task, question: job.question }, modelCallCheckpointRoot: this.checkpointRootForJob(job) })
        validatePlan(planning.industry_plan)
        planning.resume_binding = binding
        planning.plan_sha256 = sha256(canonicalJson(planning.industry_plan))
        await writeJsonAtomic(planPath, planning)
      }
      await this.recordProgress(jobId, { ...planningEvent, type: 'agent_completed' })
    } catch (error) {
      Object.assign(error, { agent_id: planningEvent.agent_id, agent_label: planningEvent.agent_label })
      await this.recordProgress(jobId, { ...planningEvent, type: 'agent_failed', error_code: error.code || 'INDUSTRY_PLANNING_FAILED' })
      throw error
    }
    const request = this.enterpriseCollectionRequest(jobId, company, asOfDate, job.question)
    // Route planning requirements through currently available adapters only.
    for (const requirement of planning.industry_plan?.['证据需求'] || []) {
      const terms = [...new Set((requirement.query_terms || []).map(String).filter(Boolean))].slice(0, 4)
      if (!terms.length) continue
      const templates = request.queries.filter(q => q.source_id === 'web_search' || (requirement.preferred_source_types || []).includes(this.builtInSources.find(x => x.id === q.source_id)?.source_type || this.userSourceConfig?.websites?.find(x => x.id === q.source_id)?.source_type))
      for (const template of templates.filter((q, i, rows) => rows.findIndex(x => x.source_id === q.source_id) === i)) {
        request.queries.push({ ...template, query_id: `plan:${requirement.requirement_id}:${template.source_id}`, query_origin: 'industry_plan', requirement_id: requirement.requirement_id, claim_scope: requirement.claim_scope, industry_plan_bound: true, query_terms: terms, query: template.source_id === 'government_policy' ? terms[0].slice(0, 8) : `${company.company_name} ${terms.slice(0, 2).join(' ')}`, required: false, min_evidence: 0 })
      }
    }
    await writeJsonAtomic(path.join(companyRoot, 'collection-request.json'), request)
    const collectionEvent = { phase: 'evidence_intake', agent_id: 'public_evidence_monitor', agent_label: '信息搜集与核验' }
    await this.recordProgress(jobId, { ...collectionEvent, type: 'agent_started' })
    let packet
    try {
      const packetPath = path.join(companyRoot, 'enterprise-evidence-packet.json')
      const packetBinding = { ...binding, plan_sha256: planning.plan_sha256, request_sha256: sha256(canonicalJson({ ...request, request_id: null })) }
      const savedPacket = await readJson(packetPath).catch(error => { if (error.code !== 'ENOENT') throw error; return null })
      if (!job.force_evidence_recollection && savedPacket?.resume_binding && canonicalJson(savedPacket.resume_binding) === canonicalJson(packetBinding)) {
        if (!Array.isArray(savedPacket.evidence) || savedPacket.evidence_sha256 !== sha256(canonicalJson(savedPacket.evidence))) throw Object.assign(new Error('证据断点内容校验失败'), { code: 'INTAKE_CHECKPOINT_INVALID' })
        const errors = await verifyEvidenceSnapshots(savedPacket.evidence, { snapshotRoot, productionMode: true })
        if (errors.length) throw Object.assign(new Error(errors.join('; ')), { code: 'INTAKE_CHECKPOINT_INVALID' })
        packet = savedPacket
      } else {
        packet = await (this.collectEvidenceImpl ? this.collectEvidenceImpl(request) : new PublicSourceCollector({ snapshotDirectory: snapshotRoot, userSourceConfig: this.userSourceConfig }).collect(request))
        packet.resume_binding = packetBinding
        packet.evidence_sha256 = sha256(canonicalJson(packet.evidence))
        await writeJsonAtomic(packetPath, packet)
      }
      await this.recordProgress(jobId, { ...collectionEvent, type: 'agent_completed', evidence_count: packet.evidence.length })
    } catch (error) {
      Object.assign(error, { agent_id: collectionEvent.agent_id, agent_label: collectionEvent.agent_label })
      await this.recordProgress(jobId, { ...collectionEvent, type: 'agent_failed', error_code: error.code || 'EVIDENCE_COLLECTION_FAILED' })
      throw error
    }
    await writeJsonAtomic(path.join(companyRoot, 'enterprise-evidence-packet.json'), packet)
    const caseData = { contract_version: '1.0.0', case_id: `enterprise-${company.company_id}-${asOfDate}`, as_of_date: asOfDate, company: { id: company.company_id, name: company.company_name, industry: company.industry, business_scope: company.business_scope }, evidence: packet.evidence, evidence_snapshot_root: snapshotRoot, question: job.question, rules: job.rules, experience: job.experience, collection_status: packet.status }
    const casePath = path.join(job.output_directory, 'enterprise-case.json')
    await fs.mkdir(job.output_directory, { recursive: true })
    await writeJsonAtomic(casePath, caseData)
    await this.mutateJob(jobId, async current => { current.case_path = casePath; current.force_evidence_recollection = false; current.intake_required = false; current.evidence_count = packet.evidence.length; current.manual_assistance_requests = packet.manual_assistance_requests || [] })
  }

  async prepareImportedCase(jobId) {
    if (this.jobs.get(jobId)?.decision_mode === ENTERPRISE_MODE) return this.prepareEnterpriseImportedCase(jobId)
    const current = this.jobs.get(jobId)
    const company = this.companies.find(item => item.company_id === current.company_id)
    if (!company || !this.importedCompanyIds.has(company.company_id)) throw badRequest('只有已导入企业可以自动完成公开证据建案。')
    const companyRoot = path.join(this.intakeDirectory, company.company_id)
    const snapshotRoot = path.join(companyRoot, 'evidence-snapshots')
    const asOfDate = shanghaiCalendarDate()
    const planningCase = buildPlanningCase(company, asOfDate)
    const planningAgent = this.agents.find(agent => agent.agent_id === 'industry_research_planner')
    const monitorAgent = this.agents.find(agent => agent.agent_id === 'public_evidence_monitor')
    if (!planningAgent || !monitorAgent) throw new Error('前置产业链规划员或公开信息采集监控员缺失。')
    await fs.mkdir(companyRoot, { recursive: true })
    await this.recordProgress(jobId, {
      type: 'agent_started', stage: 'company_intake', phase: 'industry_chain_planning', operation: 'plan_imported_company',
      agent_id: planningAgent.agent_id, agent_label: planningAgent.label, model_profile: planningAgent.model_profile
    })
    let planning
    try {
      planning = await createIndustryPlan({ caseData: planningCase, modelCallCheckpointRoot: this.checkpointRootForJob(current) })
      await writeJsonAtomic(path.join(companyRoot, 'industry-plan.json'), planning)
      await this.recordProgress(jobId, {
        type: 'agent_completed', stage: 'company_intake', phase: 'industry_chain_planning', operation: 'plan_imported_company',
        agent_id: planningAgent.agent_id, agent_label: planningAgent.label, model_profile: planningAgent.model_profile
      })
    } catch (error) {
      await this.recordProgress(jobId, {
        type: 'agent_failed', stage: 'company_intake', phase: 'industry_chain_planning', operation: 'plan_imported_company',
        agent_id: planningAgent.agent_id, agent_label: planningAgent.label, model_profile: planningAgent.model_profile,
        error_code: error.code || 'INDUSTRY_PLANNING_FAILED'
      })
      throw error
    }
    await this.recordProgress(jobId, {
      type: 'agent_started', stage: 'company_intake', phase: 'evidence_intake', operation: 'collect_public_evidence',
      agent_id: monitorAgent.agent_id, agent_label: monitorAgent.label, model_profile: monitorAgent.model_profile
    })
    try {
      const request = applyIndustryPlanToCollectionRequest({
        request: buildCollectionRequest(company, asOfDate),
        industryPlan: planning.industry_plan,
        company: planningCase.company,
        configuredSources: this.userSourceConfig?.websites || []
      })
      await writeJsonAtomic(path.join(companyRoot, 'collection-request.json'), request)
      const packet = await new PublicSourceCollector({ snapshotDirectory: snapshotRoot, userSourceConfig: this.userSourceConfig }).collect(request)
      await writeJsonAtomic(path.join(companyRoot, 'evidence-packet.json'), packet)
      if (packet.status !== 'complete') {
        const error = new Error(`公开证据建案未完成：${(packet.required_failures || []).map(item => item.code || item.source_id).join(', ') || '需要人工协助'}`)
        error.code = 'EVIDENCE_INCOMPLETE'
        error.manual_assistance_requests = packet.manual_assistance_requests || []
        await this.mutateJob(jobId, async job => { job.manual_assistance_requests = error.manual_assistance_requests })
        throw error
      }
      const caseData = buildCompanyCase({ companyRecord: company, evidencePacket: packet, monitoringMode: 'active' })
      caseData.industry_plan = structuredClone(planning.industry_plan)
      caseData.industry_plan_degraded = planning.diagnostics?.degraded === true || planning.provider_production_ready !== true
      const casePath = path.join(companyRoot, 'case.json')
      await writeJsonAtomic(casePath, caseData)
      const stat = await fs.stat(casePath)
      this.caseCatalog.set(company.company_id, { case_path: casePath, updated_at: stat.mtime.toISOString(), mtime: stat.mtimeMs })
      await this.mutateJob(jobId, async job => {
        job.case_path = casePath
        job.case_updated_at = stat.mtime.toISOString()
        job.intake_required = false
        job.evidence_count = packet.evidence.length
      })
      await this.recordProgress(jobId, {
        type: 'agent_completed', stage: 'company_intake', phase: 'evidence_intake', operation: 'collect_public_evidence',
        agent_id: monitorAgent.agent_id, agent_label: monitorAgent.label, model_profile: monitorAgent.model_profile,
        evidence_count: packet.evidence.length
      })
    } catch (error) {
      await this.recordProgress(jobId, {
        type: 'agent_failed', stage: 'company_intake', phase: 'evidence_intake', operation: 'collect_public_evidence',
        agent_id: monitorAgent.agent_id, agent_label: monitorAgent.label, model_profile: monitorAgent.model_profile,
        error_code: error.code || 'EVIDENCE_COLLECTION_FAILED'
      })
      throw error
    }
  }

  async recordProgress(jobId, event) {
    await this.mutateJob(jobId, async job => {
      job.run_id = event.run_id || job.run_id
      if (event.stage) job.stage = event.stage
      if (event.phase) job.phase = event.phase
      if (Number.isInteger(event.evidence_count)) job.evidence_count = event.evidence_count
      job.progress_percent = Math.max(job.progress_percent, progressFor(event))
      if (event.type === 'source_gate') job.evidence_gate = { satisfied: event.satisfied, independent_source_count: event.independent_source_count, gaps: event.gaps }
      if (event.type === 'stage_frozen') { job.enterprise_stages ||= {}; job.enterprise_stages[event.phase] = { version: event.version, code: event.code } }
      if (event.type === 'model_fallback') {
        job.runtime_messages ||= []
        const label = job.agent_states[event.agent_id]?.label || event.agent_id
        job.runtime_messages.push({ role: 'agent', label: '运行协调Agent', kind: 'warning', at: new Date().toISOString(), message: `${label}：${failureMessage({ code: event.reason })} 已切换备用模型配置 ${event.to_profile}，正在继续。` })
      }
      if(event.type==='model_revision_requested' && event.revision_mode==='business_reassessment') {
        job.runtime_messages ||= []
        job.runtime_messages.push({role:'agent',label:'运行协调Agent',kind:'warning',at:new Date().toISOString(),message:'复核输出存在业务判定矛盾，正在重新复核；这不是格式修正，前后判断将分别留存。'})
      }
      updateAgentStates(job, event)
      updateV2State(job, event)
      job.events.push(safeProgressEvent(event))
      if (job.events.length > 240) job.events = job.events.slice(-240)
      await this.appendLog(job, formatProgressLog(event))
    })
  }

  async mutateJob(jobId, mutator) {
    const previous = this.writeChains.get(jobId) || Promise.resolve()
    const next = previous.then(async () => {
      const job = this.jobs.get(jobId)
      if (!job) throw notFound(`任务不存在：${jobId}`)
      await mutator(job)
      job.updated_at = new Date().toISOString()
      await this.persistJob(job)
      return job
    })
    this.writeChains.set(jobId, next.catch(() => {}))
    return next
  }

  async waitForPendingWrite(jobId) {
    const pending = this.writeChains.get(jobId)
    if (pending) await pending
  }

  async persistJob(job) {
    await writeJsonAtomic(path.join(this.jobsDirectory, `${job.job_id}.json`), job)
  }

  async appendLog(job, message) {
    await fs.appendFile(job.log_path, `${new Date().toISOString()} ${message}\n`, 'utf8')
  }
}

async function discoverCases(root, companyIds) {
  const catalog = new Map()
  const runtimeRoot = path.join(root, '.runtime')
  let entries = []
  try {
    entries = await fs.readdir(runtimeRoot, { withFileTypes: true })
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  const batchDirectories = entries
    .filter(entry => entry.isDirectory() && entry.name.startsWith('formal-batch-'))
    .map(entry => path.join(runtimeRoot, entry.name))
  for (const companyId of companyIds) {
    const candidates = []
    for (const batchDirectory of batchDirectories) {
      const candidate = path.join(batchDirectory, 'companies', companyId, 'case.json')
      try {
        const stat = await fs.stat(candidate)
        candidates.push({ case_path: candidate, updated_at: stat.mtime.toISOString(), mtime: stat.mtimeMs })
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
      }
    }
    candidates.sort((left, right) => right.mtime - left.mtime)
    if (candidates[0]) catalog.set(companyId, candidates[0])
  }
  return catalog
}

function normalizeCompanyRecords(data) {
  const records = Array.isArray(data) ? data : data.records
  if (!Array.isArray(records)) throw new Error('companies.json does not contain records')
  return records.map(record => ({
    ...structuredClone(record),
    company_id: String(record.company_id || '').padStart(3, '0'),
    company_name: String(record.company_name || '').trim(),
    industry: String(record.industry || '').trim()
  })).filter(record => /^\d{3}$/.test(record.company_id) && record.company_name)
}

function mergeCompanyRecords(baseRecords, overlayRecords) {
  const records = new Map(normalizeCompanyRecords(baseRecords).map(record => [record.company_id, record]))
  for (const overlay of normalizeCompanyRecords(overlayRecords)) {
    const current = records.get(overlay.company_id) || {}
    records.set(overlay.company_id, Object.fromEntries(Object.entries({ ...current, ...overlay }).filter(([, value]) => value !== '')))
  }
  return [...records.values()].sort((left, right) => left.company_id.localeCompare(right.company_id))
}

function normalizeCompanyName(value) {
  return String(value || '').replace(/\s+/g, '').replace(/[（）()]/g, '').toLowerCase()
}

function buildPlanningCase(record, asOfDate) {
  const id = String(record.company_id).padStart(3, '0')
  return {
    contract_version: '1.0.0',
    case_id: `web-import-${id}-${asOfDate}`,
    as_of_date: asOfDate,
    competition_cutoff: asOfDate,
    company: {
      id,
      name: record.company_name,
      industry: record.industry,
      province: record.province || '',
      city: record.city || '',
      enterprise_type: record.enterprise_type || '',
      unified_social_credit_code: record.unified_social_credit_code || '',
      website: record.website || '',
      business_scope: record.business_scope || ''
    },
    evidence: []
  }
}

function shanghaiCalendarDate(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now)
  const values = Object.fromEntries(parts.filter(item => item.type !== 'literal').map(item => [item.type, item.value]))
  return `${values.year}-${values.month}-${values.day}`
}

function resolveCompany(companies, { task, companyId }) {
  const requested = String(companyId || '').trim()
  if (requested) {
    const normalized = requested.padStart(3, '0')
    const match = companies.find(company => company.company_id === normalized)
    if (!match) throw badRequest(`未找到企业编号：${requested}`)
    return match
  }
  const text = String(task || '').trim()
  const idMatches = [...text.matchAll(/(?:^|\D)(\d{1,3})(?=\D|$)/g)]
    .map(match => match[1].padStart(3, '0'))
    .filter(id => companies.some(company => company.company_id === id))
  if (new Set(idMatches).size === 1) return companies.find(company => company.company_id === idMatches[0])
  const nameMatches = companies.filter(company => text.includes(company.company_name) || text.includes(shortCompanyName(company.company_name)))
  if (nameMatches.length === 1) return nameMatches[0]
  throw badRequest('无法唯一识别目标企业，请从企业列表选择一家。')
}

function shortCompanyName(name) {
  return String(name).replace(/股份有限公司|集团有限公司|有限公司/g, '')
}

function summarizeRun(run) {
  const adviceCodes = [...run.consensus.risk_control_advice].map(String)
  const qa = run.report.qa || {}
  const deliveryBlockers = []
  if (qa.schema_valid !== true) deliveryBlockers.push('报告结构校验未通过')
  if (qa.core_decision_valid === false) deliveryBlockers.push('核心结论不符合交付规则')
  if (qa.probabilities_valid !== true) deliveryBlockers.push('概率结果校验未通过')
  if (qa.cutoff_verified !== true) deliveryBlockers.push('时间截点校验未通过')
  if (qa.source_registry_verified !== true || qa.evidence_snapshots_verified !== true) deliveryBlockers.push('证据登记或快照校验未通过')
  if (qa.fixture_provider !== false || qa.degraded !== false) deliveryBlockers.push('本次运行使用了非正式或降级能力')
  if (qa.provider_production_ready !== true) deliveryBlockers.push('运行时模型生产就绪凭证未通过')
  if (run.report.debate_summary?.production_eligible !== true) deliveryBlockers.push('协作过程尚未达到正式交付条件')
  return {
    run_id: run.run_id,
    action: String(run.consensus.action),
    risk_label: run.consensus.risk_label,
    risk_control_advice: adviceCodes,
    risk_control_advice_details: {
      definition_version: RISK_CONTROL_ADVICE_DEFINITION_VERSION,
      source_field: 'risk_control_advice',
      display_only: true,
      items: describeRiskControlAdvice(adviceCodes)
    },
    decision_mode: run.consensus.decision_mode,
    conclusion_grade: run.consensus.conclusion_grade,
    finalization_status: run.competition_finalization?.finalization_status || null,
    warnings: structuredClone(run.competition_finalization?.warnings || []),
    reviewer_candidate_pool: structuredClone(run.competition_finalization?.reviewer_candidate_pool || null),
    reviewer_selection: structuredClone(run.competition_finalization?.calibration_reviewer ? {
      selected_action_candidate_id: run.competition_finalization.calibration_reviewer.selected_action_candidate_id || null,
      selected_risk_candidate_id: run.competition_finalization.calibration_reviewer.selected_risk_candidate_id || null,
      challenge_level: run.competition_finalization.calibration_reviewer.challenge_level || run.competition_finalization.calibration_reviewer.challenge_strength || null
    } : null),
    champion_gate: structuredClone(run.competition_finalization?.champion_gate || null),
    execution_diagnostics: {
      logical_model_calls: run.execution_diagnostics?.logical_model_calls ?? null,
      transport_attempts: run.execution_diagnostics?.transport_attempts ?? null,
      transport_retries: run.execution_diagnostics?.transport_retries ?? null,
      normalization_applied: structuredClone(run.execution_diagnostics?.normalization_applied || [])
    },
    production_ready: qa.production_ready === true,
    delivery_blockers: [...new Set(deliveryBlockers)],
    evidence_coverage: run.consensus.evidence_coverage,
    debate_summary: run.report.debate_summary,
    submission_row: run.report.submission_row,
    artifacts: structuredClone(run.artifacts)
  }
}

function updateAgentStates(job, event) {
  const mark = (agentId, status, details = {}) => {
    const state = job.agent_states[agentId]
    if (!state) return
    state.status = status
    state.phase = event.phase || state.phase
    state.operation = event.operation || state.operation
    if (status === 'running') state.started_at = event.at || new Date().toISOString()
    if (status === 'completed' || status === 'failed') state.completed_at = event.at || new Date().toISOString()
    if (Number.isInteger(event.round)) state.exchange_round = event.round
    if (Number.isInteger(event.max_rounds)) state.max_exchange_rounds = event.max_rounds
    if (event.broadcast_version) state.reviewed_broadcast_version = event.broadcast_version
    if (event.model_profile || details.model_profile) state.model_profile=event.model_profile || details.model_profile
    if (details.error_code) state.error_code = details.error_code
    if (event.validation_status) state.validation_status = event.validation_status
    if (Number.isInteger(event.validation_attempt)) state.validation_attempt = event.validation_attempt
    if (Number.isInteger(event.validation_max_attempts)) state.validation_max_attempts = event.validation_max_attempts
    if (event.recovery_mode) state.recovery_mode = event.recovery_mode
    if (event.recovery_applied === true) state.recovery_applied = true
    if (Array.isArray(event.warnings)) state.warnings = [...new Set([...(state.warnings || []), ...event.warnings])]
  }
  if (event.type === 'agent_started') mark(event.agent_id, 'running')
  if (event.type === 'agent_completed') mark(event.agent_id, 'completed')
  if (event.type === 'agent_failed') mark(event.agent_id, 'failed', event)
  if (event.type === 'model_fallback') mark(event.agent_id,'running',{model_profile:event.to_profile})
  if (event.type === 'seat_frozen') mark(event.agent_id, 'frozen')
  if (event.type === 'seat_reactivated') mark(event.agent_id, 'reactivated')
  if (event.type === 'agent_group_started') for (const agent of event.agents || []) mark(agent.agent_id, 'running')
  if (event.type === 'agent_group_completed') for (const agentId of event.agent_ids || []) mark(agentId, 'completed')
  if (event.type === 'agent_group_failed') for (const agentId of event.agent_ids || []) mark(agentId, 'failed', event)
  job.active_agents = Object.values(job.agent_states).filter(state => state.status === 'running').map(state => state.agent_id)
}

function createV2State() {
  return {
    contract_version: '1.0.0',
    stages: Object.fromEntries(['evidence_collection', 'action_decision', 'action_calibration', 'risk_decision', 'risk_calibration', 'reviewer_selection', 'champion_gate', 'finalization'].map(id => [id, { status: 'pending' }])),
    constraint: { status: 'pending', attempt: 0, max_attempts: 3, revise_required_count: 0, revision_completed_count: 0 },
    recovery: { count: 0, last_mode: null, events: [] },
    reviewer_candidate_pool: null,
    reviewer_selection: null,
    gate: null,
    decision_finalized: false,
    finalization_status: null
  }
}

function updateV2State(job, event) {
  job.v2_state ||= createV2State()
  const state = job.v2_state
  const stageId = displayStageForEvent(event)
  if (event.type === 'stage_started' || event.type === 'phase_started' || event.type === 'agent_started' || event.type === 'agent_group_started') {
    if (stageId) state.stages[stageId].status = 'running'
  }
  if (event.type === 'stage_completed' || event.type === 'phase_completed' || ['action_calibration_completed', 'risk_calibration_completed', 'reviewer_selection_completed', 'champion_gate_completed'].includes(event.type)) {
    if (stageId) state.stages[stageId].status = 'completed'
  }
  if (event.type === 'action_calibration_completed') state.stages.action_decision.status = 'completed'
  if (event.type === 'risk_calibration_completed') state.stages.risk_decision.status = 'completed'
  if (event.type === 'agent_failed' || event.type === 'agent_group_failed') {
    if (stageId) state.stages[stageId].status = event.error_code === 'PAUSED_SEAT_FAILURE' ? 'paused' : 'failed'
  }
  if (event.validation_status) {
    state.constraint.status = event.validation_status
    state.constraint.attempt = Number(event.validation_attempt || 0)
    state.constraint.max_attempts = Number(event.validation_max_attempts || 3)
    if (event.validation_status === 'REVISE_REQUIRED') state.constraint.revise_required_count += 1
    if (event.validation_status === 'PASS' && Number(event.validation_attempt || 0) > 0) state.constraint.revision_completed_count += 1
  }
  if (event.recovery_applied === true) {
    state.recovery.count += 1
    state.recovery.last_mode = event.recovery_mode || 'normalized'
    state.recovery.events.push({ at: event.at || new Date().toISOString(), agent_id: event.agent_id || null, phase: event.phase || null, mode: event.recovery_mode || 'normalized' })
  }
  if (event.type === 'reviewer_candidate_pool_created') state.reviewer_candidate_pool = structuredClone(event.candidate_pool || null)
  if (event.type === 'reviewer_selection_completed') state.reviewer_selection = {
    selected_action_candidate_id: event.selected_action_candidate_id || null,
    selected_risk_candidate_id: event.selected_risk_candidate_id || null,
    challenge_level: event.challenge_level || null
  }
  if (event.type === 'champion_gate_completed') {
    state.gate = event.gate || null
    state.decision_finalized = event.decision_finalized === true
    state.finalization_status = event.finalization_status || null
  }
  if (event.type === 'run_completed') state.stages.finalization.status = 'completed'
  if (event.type === 'run_failed') state.stages.finalization.status = event.error_code === 'PAUSED_SEAT_FAILURE' ? 'paused' : 'failed'
}

function displayStageForEvent(event) {
  if (event.type === 'action_calibration_completed' || event.phase === 'decision_direction') return 'action_calibration'
  if (event.type === 'risk_calibration_completed' || event.phase === 'risk_control_advice') return 'risk_calibration'
  if (event.type === 'reviewer_candidate_pool_created' || event.type === 'reviewer_selection_completed' || ['reviewer_selection', 'single_pass_calibration', 'competition_joint_calibration'].includes(event.phase)) return 'reviewer_selection'
  if (event.type === 'champion_gate_completed' || event.phase === 'champion_gate') return 'champion_gate'
  if (['aggregate_and_render', 'persist_artifacts', 'complete'].includes(event.phase) || ['conclusion_output', 'artifact_commit'].includes(event.stage)) return 'finalization'
  if (String(event.phase || '').startsWith('decision_direction_')) return 'action_decision'
  if (String(event.phase || '').startsWith('risk_control_advice_')) return 'risk_decision'
  if (['evidence_intake', 'public_information_monitoring', 'industry_chain_planning'].includes(event.phase) || ['public_evidence_planning_and_intake', 'information_collection_monitoring'].includes(event.stage)) return 'evidence_collection'
  return null
}

function safeProgressEvent(event) {
  return {
    type: event.type,
    at: event.at,
    run_id: event.run_id || null,
    stage: event.stage || null,
    phase: event.phase || null,
    operation: event.operation || null,
    round: Number.isInteger(event.round) ? event.round : null,
    max_rounds: Number.isInteger(event.max_rounds) ? event.max_rounds : null,
    broadcast_version: event.broadcast_version || null,
    agent_id: event.agent_id || null,
    model_profile:event.model_profile || null,
    revision_mode:event.revision_mode || null,
    from_profile: event.from_profile || null,
    to_profile: event.to_profile || null,
    fallback_reason: event.type === 'model_fallback' ? event.reason || null : null,
    agent_ids: event.agent_ids || null,
    result: event.result ?? null,
    unanimous: event.unanimous ?? null,
    satisfied: event.satisfied ?? null, independent_source_count: event.independent_source_count ?? null, version: event.version || null, code: event.code ?? null, errors: event.errors || [],
    error_code: event.error_code || null
    ,validation_status: event.validation_status || null
    ,validation_attempt: Number.isInteger(event.validation_attempt) ? event.validation_attempt : null
    ,validation_max_attempts: Number.isInteger(event.validation_max_attempts) ? event.validation_max_attempts : null
    ,recovery_mode: event.recovery_mode || null
    ,recovery_applied: event.recovery_applied === true
    ,warnings: Array.isArray(event.warnings) ? structuredClone(event.warnings) : []
    ,candidate_pool: event.candidate_pool ? structuredClone(event.candidate_pool) : null
    ,selected_action_candidate_id: event.selected_action_candidate_id || null
    ,selected_risk_candidate_id: event.selected_risk_candidate_id || null
    ,challenge_level: event.challenge_level || null
    ,gate: event.gate || null
    ,decision_finalized: event.decision_finalized ?? null
    ,finalization_status: event.finalization_status || null
  }
}

function formatProgressLog(event) {
  const location = [event.stage, event.phase].filter(Boolean).join(' / ')
  if (event.type === 'seat_frozen') return `[seat:frozen] ${event.agent_id} · 第${event.round}轮 · 已确认当前广播版本`
  if (event.type === 'seat_reactivated') return `[seat:reactivated] ${event.agent_id} · 同行意见或依据更新，重新复审`
  if (event.type === 'difference_broadcast') return `[exchange] ${location} · 第${event.round}/${event.max_rounds}轮 · 收齐五席后广播`
  if (event.type === 'agent_started') return `[agent:start] ${event.agent_label || event.agent_id} · ${location}${event.model_profile ? ' · '+event.model_profile : ''}`
  if (event.type === 'agent_completed') {
    const loop = Number(event.validation_attempt || 0) > 0 ? ` · Program约束修订完成 ${event.validation_attempt}/${event.validation_max_attempts || 3}` : ''
    const recovery = event.recovery_applied ? ` · ${event.recovery_mode === 'decision_block' ? 'Decision block extracted' : 'Output normalized'}` : ''
    return `[agent:done] ${event.agent_label || event.agent_id} · ${location}${loop}${recovery}`
  }
  if (event.type === 'agent_failed') return `[agent:failed] ${event.agent_label || event.agent_id} · ${event.error_code || 'AGENT_FAILED'}`
  if (event.type === 'model_fallback') return `[model:fallback] ${event.agent_id} · ${event.from_profile} → ${event.to_profile} · ${event.reason}`
  if (event.type === 'phase_completed') return `[phase:done] ${location} · 结果=${JSON.stringify(event.result)} · 一致=${Boolean(event.unanimous)}`
  if (event.type === 'stage_started') return `[stage:start] ${location}`
  if (event.type === 'stage_completed') return `[stage:done] ${location}`
  if (event.type === 'action_calibration_completed') return `[program:action] Action门槛完成 · action=${event.action} · threshold=${Boolean(event.threshold_passed)}`
  if (event.type === 'risk_calibration_completed') return `[program:risk] Risk exact-set候选已冻结 · candidates=${event.candidate_count}`
  if (event.type === 'reviewer_candidate_pool_created') return `[reviewer:pool] 候选池已生成 · Action=${event.candidate_pool?.action_candidates?.length || 0} · Risk=${event.candidate_pool?.risk_candidates?.length || 0}`
  if (event.type === 'reviewer_selection_completed') return `[reviewer:selected] Action=${event.selected_action_candidate_id || '—'} · Risk=${event.selected_risk_candidate_id || '—'}`
  if (event.type === 'champion_gate_completed') return `[program:gate] Champion Gate=${event.gate || '—'} · finalized=${Boolean(event.decision_finalized)}`
  if (event.type === 'run_created') return `[run] ${event.run_id} · 证据=${event.evidence_count}`
  if (event.type === 'run_completed') return `[run:done] production_ready=${Boolean(event.production_ready)}`
  if (event.type === 'run_failed') return `[run:failed] ${event.error_code || 'RUN_FAILED'} · ${event.message || ''}`
  return `[${event.type || 'progress'}] ${location}`
}

function progressFor(event) {
  return PHASE_PROGRESS[event.phase] ?? PHASE_PROGRESS[event.stage] ?? 0
}

function publicJobSummary(job) {
  return structuredClone({
    job_id: job.job_id,
    company_id: job.company_id,
    company_name: job.company_name,
    status: job.status,
    stage: job.stage,
    phase: job.phase,
    decision_mode: job.decision_mode || 'competition_calibrated_v2',
    task: job.task,
    progress_percent: job.progress_percent,
    intake_required: job.intake_required === true,
    created_at: job.created_at,
    started_at: job.started_at,
    completed_at: job.completed_at,
    updated_at: job.updated_at
  })
}

function publicJob(job) {
  return structuredClone(job)
}

function assertStartAnalysisConsent(userConsent, consentAction) {
  if (userConsent !== true || consentAction !== 'start_analysis') {
    throw badRequest('请点击“开始进件分析”授权并创建任务。')
  }
}

function isPathInside(root, candidate) {
  const relative = path.relative(root, candidate)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function badRequest(message) {
  const error = new Error(message)
  error.statusCode = 400
  return error
}

function normalizeReceptionQuestion(question) {
  return { question: String(question?.question || '').trim() }
}

function normalizeSearchSites(sites) {
  if (!Array.isArray(sites) || sites.length > 10) throw badRequest('指定网站最多填写10个。')
  return [...new Set(sites.map(value => {
    const input = String(value || '').trim()
    if (!input) return ''
    let host
    try { host = new URL(/^https?:\/\//i.test(input) ? input : `https://${input}`).hostname.toLowerCase() } catch { throw badRequest(`无效的网站：${input}`) }
    if (!/^(?=.{4,253}$)[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(host) || host.endsWith('.local') || host.endsWith('.internal')) throw badRequest(`请填写公开网站域名：${input}`)
    return host
  }).filter(Boolean))]
}

function notFound(message) {
  const error = new Error(message)
  error.statusCode = 404
  return error
}

module.exports = {
  ARTIFACT_KEYS,
  PHASE_PROGRESS,
  STANDARD_TASK,
  WebJobManager,
  discoverCases,
  mergeCompanyRecords,
  normalizeCompanyRecords,
  resolveCompany,
  shanghaiCalendarDate,
  summarizeRun
}
