'use strict'

const $ = selector => document.querySelector(selector)
const presentationPrivacy = window.RuloraPresentationPrivacy.createController({ storage: window.localStorage })
const CONVERSATION_PREFIX = 'rulora.runtime-conversation.v2.'
const QUICK_COMMANDS_KEY = 'rulora.quick-commands.v1'
const state = {
  companies: [], jobs: [], agents: [], selectedCompanyIds: new Set(),
  sourceSettings: { built_in_sources: [], search_backend: { type: 'searxng', enabled: true, endpoint: '', jev_prefilter_enabled: false }, websites: [] },
  selectedJobId: null, selectedJob: null, batchLimit: 20, concurrency: 2,
  pollTimer: null, clockTimer: null, pollInFlight: false, submitInFlight: false, conversationMode: 'runtime', conversationAlertToken: null, conversationKey: 'draft', conversationRecords: [], quickCommands: [], currentLogs: { text: '', truncated: false }, acknowledgedExceptions: new Set(), exceptionJob: null, exceptionIncidentToken: null
}
const STATUS_LABELS = { queued: '排队中', running: '运行中', succeeded: '已完成', failed: '失败', interrupted: '已中断', paused: '已暂停', closed: '已关闭', awaiting_question: '待补充问题', awaiting_assistance: '待人工协助', pending_approval: '旧版待人工审批', approved: '系统已交付' }
const AGENT_STATUS_LABELS = { frozen: '已冻结', reactivated: '待复审', idle: '待执行', queued: '等待任务', running: '运行中', standby: '周期待命', completed: '已完成', revise_required: '需要修订', paused: '已暂停', failed: '失败', closed: '已关闭', not_in_case: '不参与单案' }
const AGENT_LAYERS = [
  { stage: 'industry_chain_planning', number: '01', label: '前置研究规划层', note: '先定义要验证的产业链与证据需求' },
  { stage: 'information_collection_monitoring', number: '02', label: '公开证据层', note: '按规划采集、去重、存证和监控，不投票' },
  { stage: 'group_debate', number: '03', label: '三席独立决策层', note: '基于同一冻结证据完成经营方向与风控建议' },
  { stage: 'competition_calibration', number: '04', label: '单次校准审查层', note: '只从冻结候选中执行经营门槛与完整方案审查' },
  { stage: 'periodic_improvement', number: '05', label: '周期改善层', note: '只读取外部结果与用户反馈，不改当次结论' }
]
const ENTERPRISE_LAYERS = [
  { stage: 'industry_chain_planning', number: '01', label: '产业链前置规划', note: '明确产业链环节和资料需求' },
  { stage: 'information_collection_monitoring', number: '02', label: '公开证据采集', note: '收集并核验公开信息' },
  { stage: 'enterprise_direction', number: '03', label: '经营方向五席', note: '逐席冻结与重新激活 · 最多6轮交换' },
  { stage: 'enterprise_condition', number: '04', label: '决策建议五席', note: '逐项论证、整组修订 · 最多10轮' },
  { stage: 'enterprise_review', number: '05', label: '语义复核', note: '核对依据、冲突与适用条件' },
  { stage: 'periodic_improvement', number: '06', label: '周期改善', note: '根据历史反馈优化分析' }
]
const ENTERPRISE_STEPS = [
  ['planning', '产业链前置规划', '梳理环节与待验证问题'],
  ['evidence', '信息搜集与核验', '核验相关信息和独立来源'],
  ['direction', '经营方向五席', '独立研判与分歧复审'],
  ['condition', '决策建议五席', '评估行动建议及其条件'],
  ['search', '补充检索与回退', '补充资料后重新评估'],
  ['report', '结构化报告', '方向、决策建议与理由'],
  ['approval', '系统校验交付', '校验通过后交付报告']
]
let legacyPipelineHtml = null
const PHASE_LABELS = {
  queued: '等待调度', session_initialization: '初始化运行', industry_chain_planning: '产业链前置规划',
  evidence_intake: '统一公开证据建案', public_information_monitoring: '公开信息监控',
  joint_independent_decision: '联合决策 · 三席独立首轮', competition_joint_decision_initial: '联合决策 · 三席独立首轮',
  competition_joint_decision_self_review: '联合决策 · 差异广播与一次修订', competition_joint_decision: '三席结果冻结',
  single_pass_calibration: '程序校准与单次复核', competition_calibration: '程序校准与单次复核',
  decision_direction_initial: '经营方向 · 三席初始判断', decision_direction_self_review: '经营方向 · 差异自审',
  decision_direction: '经营方向校准与冻结', action_calibration: '经营方向校准', risk_control_advice_initial: '风控建议 · 三席初始判断',
  risk_control_advice_self_review: '风控建议 · 差异自审', risk_control_advice: '风控建议冻结',
  risk_calibration: '完整方案冻结', reviewer_selection: '复核已有候选', champion_gate: '交付门禁',
  shadow_validation: '影子候选验证', aggregate_and_render: '聚合结论与报告QA',
  persist_artifacts: '保存结果', complete: '任务完成', supplemental_search: '补充检索与回退', report: '生成决策报告', direction_initial: '经营方向五席初判', direction_self_review: '经营方向差异复审', direction_semantic_review: '经营方向语义复核', condition_initial: '决策建议五席初判', condition_self_review: '决策建议差异复审', condition_semantic_review: '决策建议语义复核', direction: '经营方向 · 五席分析', condition: '决策建议 · 五席分析', awaiting_question: '待补充问题', awaiting_assistance: '待人工协助', pending_approval: '旧版待人工审批', approved: '系统已交付', closed: '任务已关闭'
}

document.addEventListener('DOMContentLoaded', async () => {
  bindEvents()
  restoreConversation('draft')
  loadQuickCommands()
  if (!state.conversationRecords.length) appendWorkspaceMessage('agent', '分析开始后，可在此查询进度、补充信息。')
  syncPresentationPrivacyControls()
  renderPipeline({ decision_mode: 'enterprise_decision_v2', status: 'queued' })
  await Promise.allSettled([loadSystem(), loadCompanies(), loadJobs(), loadAgents(), loadSources()])
  schedulePoll()
  state.clockTimer = window.setInterval(renderElapsed, 1000)
})

function bindEvents() {
  $('#presentation-privacy-toggle').addEventListener('change', handlePrivacyToggle)
  $('#privacy-unlock-form').addEventListener('submit', submitPrivacyUnlock)
  $('#privacy-unlock-cancel').addEventListener('click', closePrivacyUnlock)
  $('#company-search').addEventListener('input', renderCompanyChecklist)
  $('#intake-form').addEventListener('submit', submitBatch)
  $('#workspace-command-form').addEventListener('submit', submitWorkspaceCommand)
  $('#quick-command-form').addEventListener('submit', addQuickCommand)
  $('#quick-command-list').addEventListener('click', handleQuickCommandClick)
  $('#jev-prefilter-enabled').addEventListener('change', saveJevChoice)
  $('#company-import-form').addEventListener('submit', importCompanyRecord)
  $('#import-button').addEventListener('click', importCompanies)
  $('#company-file').addEventListener('change', event => { $('#company-file-name').textContent = event.target.files?.[0]?.name || '支持 CSV、Excel、JSON' })
  $('#refresh-jobs').addEventListener('click', async event => { event.preventDefault(); event.stopPropagation(); const button = event.currentTarget; button.disabled = true; button.setAttribute('aria-busy', 'true'); try { await Promise.allSettled([loadJobs(), loadAgents()]) } finally { button.disabled = false; button.removeAttribute('aria-busy') } })
  $('#source-form').addEventListener('submit', saveSources)
  $('#searxng-enabled').addEventListener('change', saveSearchChoice)
  $('#add-source').addEventListener('click', addSourceWebsite)
  $('#add-api-source').addEventListener('click', addSourceApi)
  $('#exception-confirm').addEventListener('click', acknowledgeCurrentException)
  $('#exception-dialog').addEventListener('close', acknowledgeCurrentException)
  $('#exception-command-form').addEventListener('submit', submitExceptionCommand)
  document.querySelectorAll('[data-exception-command]').forEach(button => button.addEventListener('click', () => handleExceptionCommand(button.dataset.exceptionCommand)))
  document.querySelectorAll('[data-action-resolution]').forEach(button => button.addEventListener('click', () => resolveActionDisagreement(button.dataset.actionResolution)))
}

function handlePrivacyToggle(event) {
  if (event.target.checked) {
    presentationPrivacy.setEnabled(true)
    rerenderPresentationSurface()
    return
  }
  event.target.checked = true
  $('#privacy-unlock-password').value = ''
  $('#privacy-unlock-message').textContent = ''
  $('#privacy-unlock-dialog').showModal()
  window.setTimeout(() => $('#privacy-unlock-password').focus(), 0)
}

async function submitPrivacyUnlock(event) {
  event.preventDefault()
  const password = $('#privacy-unlock-password').value
  try {
    await api('/api/privacy/unlock', { method: 'POST', body: JSON.stringify({ password }) })
    presentationPrivacy.setEnabled(false)
    $('#privacy-unlock-dialog').close()
    rerenderPresentationSurface()
  } catch (error) {
    $('#privacy-unlock-message').textContent = error.message
    $('#privacy-unlock-password').select()
  }
}

function closePrivacyUnlock() {
  $('#privacy-unlock-dialog').close()
  syncPresentationPrivacyControls()
}

async function api(endpoint, options = {}) {
  const response = await fetch(endpoint, { headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }, ...options })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(body.error || ([502, 503, 504].includes(response.status) ? `服务暂时不可用（${response.status}）` : `请求失败（${response.status}）`))
  return body
}

async function loadCompanies() {
  const { companies } = await api('/api/companies')
  state.companies = companies
  presentationPrivacy.registerCompanies(companies)
  renderConversation()
  const valid = new Set(companies.filter(company => company.selectable).map(company => company.company_id))
  state.selectedCompanyIds = new Set([...state.selectedCompanyIds].filter(id => valid.has(id)))
  renderCompanyChecklist()
}

async function loadJobs() {
  try {
    const { jobs } = await api('/api/jobs')
    $('#history-message').textContent = ''
    state.jobs = jobs
    presentationPrivacy.registerJobs(jobs)
    renderJobList()
    if (!state.selectedJobId) {
      const enterpriseJob = jobs.find(job => job.decision_mode === 'enterprise_decision_v2' && ['queued', 'running', 'awaiting_question', 'awaiting_assistance', 'pending_approval', 'paused'].includes(job.status))
      if (enterpriseJob) await selectJob(enterpriseJob.job_id)
    }
  } catch (error) { $('#history-message').textContent = `记录暂未刷新：${error.message}，正在自动重试。` }
}

async function loadAgents() {
  try {
    const { agents } = await api('/api/agents')
    state.agents = agents
    renderAgents()
  } catch {
    $('#agent-grid').innerHTML = '<p class="empty-state">Agent状态读取失败。</p>'
  }
}

async function loadSystem() {
  try {
    const { system, providers } = await api('/api/system')
    state.batchLimit = Number(system.batch_limit) || 20
    state.concurrency = Number(system.concurrency) || 2
    const healthyCount = (providers.profiles || []).filter(profile => profile.configured && !profile.alert_active).length
    const total = (providers.profiles || []).length
    const node = $('#system-health')
    const level = providers.healthy && providers.live_ready ? 'good' : providers.healthy ? 'warn' : 'bad'
    const readiness = providers.live_ready ? '模型验证有效' : '模型验证待更新'
    node.innerHTML = `<span class="pulse ${level}"></span><span>模型 ${healthyCount}/${total} · ${readiness} · 运行 ${system.running_jobs}/${system.concurrency}</span>`
    node.title = displayText([...(providers.profiles || []).map(profile => `${profile.profile_id}: ${profile.model} · ${profile.status}`), `readiness: ${providers.readiness_reason || (providers.live_ready ? 'ready' : 'unknown')}`].join('\n'))
    $('#batch-notice').textContent = `进件容量 ${state.batchLimit} 家 · 最多同时分析 ${state.concurrency} 家`
    updateSelectionCount()
  } catch {
    $('#system-health').innerHTML = '<span class="pulse bad"></span><span>系统状态读取失败</span>'
  }
}

async function loadSources() {
  try {
    const { sources } = await api('/api/sources')
    state.sourceSettings = sources
    $('#searxng-endpoint').value = sources.search_backend?.endpoint || ''
    $('#searxng-enabled').checked = sources.search_backend?.enabled === true
    $('#jev-prefilter-enabled').checked = sources.search_backend?.jev_prefilter_enabled === true
    $('#search-backend-status').textContent = sources.search_backend?.enabled ? '联网检索已启用。' : '联网检索未启用，请先在“公开信息来源”中配置。'
    renderJevStatus()
    renderSources()
  } catch (error) {
    $('#built-in-sources').innerHTML = `<p class="form-message error">${displayHtml(error.message)}</p>`
  }
}

function renderSources() {
  const builtIn = state.sourceSettings.built_in_sources || []
  const sourceCard = source => `<div class="source-item"><span><strong>${displayHtml(source.label)}</strong><small>${displayHtml(sourceTypeLabel(source.source_type))} · ${displayHtml((source.claims || []).join('、') || '按来源规则访问')}</small></span><span class="source-status ${source.automatic ? '' : 'pending'}">${source.automatic ? '已接通' : '已预设'}</span></div>`
  const connected = builtIn.filter(source => source.automatic)
  const preset = builtIn.filter(source => !source.automatic && source.id !== 'web_search')
  $('#built-in-sources').innerHTML = `${connected.length ? `<div class="source-group-label">已接通来源</div>${connected.map(sourceCard).join('')}` : ''}${preset.length ? `<details class="preset-source-group"><summary>已预设来源 <span>${preset.length}项</span></summary><div class="source-list">${preset.map(sourceCard).join('')}</div></details>` : ''}` || '<p class="empty-state">暂无已验证来源。可配置联网检索。</p>'
  const websites = state.sourceSettings.websites || []
  $('#user-sources').innerHTML = websites.length ? websites.map((source, index) => `
    <div class="source-item"><span><strong>${displayHtml(source.label)}</strong><small>${displayHtml(source.connection_type === 'json_api' ? source.api?.endpoint : source.base_url)} · ${displayHtml(source.source_type)} · ${source.connection_type === 'json_api' ? 'JSON API' : '网页检索'}</small></span><button type="button" data-remove-source="${index}">移除</button></div>`).join('') : '<p class="empty-state">尚未添加自定义网站或API。</p>'
  $('#user-sources').querySelectorAll('[data-remove-source]').forEach(button => button.addEventListener('click', () => {
    state.sourceSettings.websites.splice(Number(button.dataset.removeSource), 1)
    renderSources()
  }))
}

function renderJevStatus() {
  const backend = state.sourceSettings.search_backend || {}
  const status = !backend.jev_prefilter_enabled ? 'Jev 未启用'
    : !backend.enabled ? 'Jev 已启用，等待联网检索'
      : !backend.jev_prefilter_key_configured ? 'Jev 已启用，API Key 未就绪'
        : 'Jev 已启用，候选排序生效'
  $('#jev-prefilter-status').textContent = status
}

async function saveJevChoice(event) {
  const desired = event.target.checked
  event.target.disabled = true
  try {
    const { sources } = await api('/api/sources', { method: 'PUT', body: JSON.stringify({
      contract_version: '1.0.0',
      search_backend: { ...(state.sourceSettings.search_backend || {}), jev_prefilter_enabled: desired },
      websites: state.sourceSettings.websites || []
    }) })
    state.sourceSettings = sources
    $('#search-backend-status').textContent = sources.search_backend?.enabled ? '联网检索已启用。' : '联网检索未启用，请先在“公开信息来源”中配置。'
    event.target.checked = sources.search_backend?.jev_prefilter_enabled === true
  } catch (error) {
    event.target.checked = !desired
    $('#jev-prefilter-status').textContent = `Jev 设置失败：${error.message}`
  } finally { event.target.disabled = false; if (event.target.checked === desired) renderJevStatus() }
}

function addSourceWebsite() {
  const label = $('#source-label').value.trim()
  const baseUrl = $('#source-url').value.trim()
  const sourceType = $('#source-type').value
  if (!label || !baseUrl) { showSourceMessage('请填写网站名称和HTTPS网址。', 'error'); return }
  try {
    const parsed = new URL(baseUrl)
    if (parsed.protocol !== 'https:') throw new Error('来源网站必须使用HTTPS。')
    if ((state.sourceSettings.websites || []).some(source => source.connection_type !== 'json_api' && new URL(source.base_url).hostname === parsed.hostname)) throw new Error('该网站已经存在。')
    state.sourceSettings.websites ||= []
    state.sourceSettings.websites.push({ label, base_url: parsed.origin, source_type: sourceType, data_category: sourceType, connection_type: 'web_search', enabled: true })
    $('#source-label').value = ''
    $('#source-url').value = ''
    renderSources()
    showSourceMessage('已加入草稿，请点击保存来源配置。')
  } catch (error) { showSourceMessage(error.message, 'error') }
}

function addSourceApi() {
  const label = $('#api-label').value.trim()
  const endpoint = $('#api-endpoint').value.trim()
  const sourceType = $('#api-source-type').value
  if (!label || !endpoint) { showSourceMessage('请填写API名称和HTTPS端点。', 'error'); return }
  try {
    const parsed = new URL(endpoint)
    if (parsed.protocol !== 'https:') throw new Error('来源API必须使用HTTPS。')
    if ((state.sourceSettings.websites || []).some(source => source.connection_type === 'json_api' && source.api?.endpoint === parsed.href)) throw new Error('该API已经存在。')
    const staticParameters = JSON.parse($('#api-static-parameters').value.trim() || '{}')
    state.sourceSettings.websites ||= []
    state.sourceSettings.websites.push({
      label,
      base_url: parsed.origin,
      source_type: sourceType,
      data_category: sourceType,
      connection_type: 'json_api',
      enabled: true,
      api: {
        endpoint: parsed.href,
        query_parameter: $('#api-query-parameter').value.trim() || 'q',
        static_parameters: staticParameters,
        mapping: {
          items_path: $('#api-items-path').value.trim() || 'data',
          title_field: $('#api-title-field').value.trim() || 'title',
          summary_field: $('#api-summary-field').value.trim() || 'summary',
          published_at_field: $('#api-date-field').value.trim() || 'published_at',
          url_field: $('#api-url-field').value.trim() || 'url'
        }
      }
    })
    $('#api-label').value = ''
    $('#api-endpoint').value = ''
    renderSources()
    showSourceMessage('API已加入草稿，请点击保存来源配置。')
  } catch (error) { showSourceMessage(error instanceof SyntaxError ? '固定参数必须是合法JSON对象。' : error.message, 'error') }
}

async function saveSearchChoice(event) {
  const control = event.target
  const previous = state.sourceSettings.search_backend?.enabled === true
  const status = $('#search-choice-message')
  status.textContent = ''
  control.disabled = true
  try {
    if (control.checked && !state.sourceSettings.search_backend?.endpoint) throw new Error('检索服务尚未配置，请在来源配置中填写服务地址。')
    const { sources } = await api('/api/sources', { method: 'PUT', body: JSON.stringify({ contract_version: '1.0.0', search_backend: { ...state.sourceSettings.search_backend, enabled: control.checked }, websites: state.sourceSettings.websites || [] }) })
    state.sourceSettings = sources
    control.checked = sources.search_backend.enabled
    $('#search-backend-status').textContent = sources.search_backend.enabled ? '联网检索已启用。' : '联网检索已关闭。'
    renderSources(); renderJevStatus()
  } catch (error) { control.checked = previous; status.textContent = error.message }
  finally { control.disabled = false }
}

async function saveSources(event) {
  event.preventDefault()
  const endpoint = $('#searxng-endpoint').value.trim()
  const enabled = $('#searxng-enabled').checked
  if (enabled && !endpoint) { showSourceMessage('启用检索前请填写SearXNG地址。', 'error'); return }
  $('#save-sources').disabled = true
  try {
    const { sources } = await api('/api/sources', {
      method: 'PUT',
      body: JSON.stringify({
        contract_version: '1.0.0',
        search_backend: { type: 'searxng', enabled, endpoint, jev_prefilter_enabled: $('#jev-prefilter-enabled').checked },
        websites: state.sourceSettings.websites || []
      })
    })
    state.sourceSettings = sources
    $('#search-backend-status').textContent = sources.search_backend?.enabled ? '联网检索已启用。' : '联网检索未启用，请先在“公开信息来源”中配置。'
    renderJevStatus()
    renderSources()
    showSourceMessage(`已保存${sources.websites.length}个自定义网站。`, 'success')
  } catch (error) { showSourceMessage(error.message, 'error') } finally { $('#save-sources').disabled = false }
}

function showSourceMessage(message, type = '') {
  const node = $('#source-message')
  node.textContent = displayText(message || '')
  node.className = `form-message ${type}`
}

async function importCompanies() {
  const input = $('#company-file')
  const button = $('#import-button')
  const file = input.files?.[0]
  if (!file) { showImportMessage('请选择企业文件。', 'error'); return }
  button.disabled = true
  showImportMessage('正在校验并导入企业信息…')
  try {
    const bytes = new Uint8Array(await file.arrayBuffer())
    const { result } = await api('/api/companies/import', {
      method: 'POST',
      body: JSON.stringify({ filename: file.name, content_base64: bytesToBase64(bytes) })
    })
    await loadCompanies()
    const importedIds = (result.companies || []).filter(company => company.selectable).map(company => company.company_id)
    for (const id of importedIds) {
      if (state.selectedCompanyIds.size >= state.batchLimit) break
      state.selectedCompanyIds.add(id)
    }
    renderCompanyChecklist()
    showImportMessage(`已导入${result.imported_count}家企业；可勾选后自动进件。`, 'success')
    input.value = ''
  } catch (error) { showImportMessage(error.message, 'error') } finally { button.disabled = false }
}

async function importCompanyRecord(event) {
  event.preventDefault()
  const button = $('#import-record-button')
  const record = { company_name: $('#import-company-name').value.trim(), taxpayer_id: $('#import-taxpayer-id').value.trim(), industry: $('#import-industry').value.trim(), business_scope: $('#import-business-scope').value.trim() }
  button.disabled = true
  try {
    const bytes = new TextEncoder().encode(JSON.stringify({ records: [record] }))
    const { result } = await api('/api/companies/import', { method: 'POST', body: JSON.stringify({ filename: 'web-company-import.json', content_base64: bytesToBase64(bytes) }) })
    const imported = result.companies?.[0]
    await loadCompanies(); if (imported?.company_id && state.selectedCompanyIds.size < state.batchLimit) state.selectedCompanyIds.add(imported.company_id)
    renderCompanyChecklist(); $('#company-import-form').reset(); showImportMessage(`企业已导入，系统编号为 ${Number(imported?.company_id)}；已加入待分析列表。`, 'success')
  } catch (error) { showImportMessage(error.message, 'error') } finally { button.disabled = false }
}

async function submitBatch(event) {
  event.preventDefault()
  if (state.submitInFlight) return
  const companyIds = [...state.selectedCompanyIds]
  if (!companyIds.length) { showMessage('请至少勾选一家企业。', 'error'); return }
  const button = $('#submit-button')
  state.submitInFlight = true
  button.disabled = true
  button.setAttribute('aria-busy', 'true')
  button.textContent = '正在提交…'
  showMessage('正在提交企业产业链风险及决策分析…')
  const lines = id => $(id).value.split('\n').map(x => x.trim()).filter(Boolean)
  try {
    const { batch } = await api('/api/jobs/batch', { method: 'POST', body: JSON.stringify({ company_ids: companyIds, user_consent: true, consent_action: 'start_analysis', decision_mode: 'enterprise_decision_v2', rules: lines('#decision-rules'), experience: lines('#decision-experience'), search_sites: lines('#search-sites') }) })
    state.selectedCompanyIds.clear()
    renderCompanyChecklist()
    showMessage(`已提交${batch.accepted_count}家企业，按队列开始分析。`)
    await Promise.all([loadJobs(), loadAgents()])
    if (batch.jobs[0]) await selectJob(batch.jobs[0].job_id)
  } catch (error) { showMessage(`提交失败：${error.message}`, 'error') }
  finally { state.submitInFlight = false; button.removeAttribute('aria-busy'); button.textContent = '开始分析'; updateSelectionCount() }
}

function renderCompanyChecklist() {
  const checklist = $('#company-checklist')
  const search = String($('#company-search')?.value || '').trim().toLowerCase()
  const companies = state.companies.filter(company => !search || presentationPrivacy.visibleSearchText(company).toLowerCase().includes(search))
  if (!companies.length) { checklist.innerHTML = '<p class="empty-state">没有匹配企业。</p>'; updateSelectionCount(); return }
  checklist.innerHTML = companies.map(company => {
    const checked = state.selectedCompanyIds.has(company.company_id)
    const disabled = !company.selectable
    const tag = company.intake_required ? '<span class="company-tag intake">自动采集公开证据</span>' : '<span class="company-tag">可直接分析</span>'
    return `<label class="company-option ${checked ? 'selected' : ''} ${disabled ? 'disabled' : ''}">
      <input type="checkbox" value="${escapeHtml(company.company_id)}" ${checked ? 'checked' : ''} ${disabled ? 'disabled' : ''}>
      <span class="company-info"><strong>${displayHtml(displayCompanyLabel(company))}</strong><small>${displayHtml(company.industry || '行业未标注')}</small>${tag}</span>
    </label>`
  }).join('')
  checklist.querySelectorAll('input[type="checkbox"]').forEach(input => input.addEventListener('change', () => toggleCompany(input.value, input.checked)))
  updateSelectionCount()
}

function toggleCompany(companyId, checked) {
  if (checked && state.selectedCompanyIds.size >= state.batchLimit) {
    showMessage(`单次最多进件${state.batchLimit}家企业。`, 'error')
    renderCompanyChecklist()
    return
  }
  if (checked) state.selectedCompanyIds.add(companyId)
  else state.selectedCompanyIds.delete(companyId)
  renderCompanyChecklist()
}

function updateSelectionCount() {
  $('#selection-count').textContent = `已选 ${state.selectedCompanyIds.size} / ${state.batchLimit}`
  $('#submit-button').disabled = state.submitInFlight || state.selectedCompanyIds.size === 0
}

function showImportMessage(message, type = '') {
  const node = $('#import-message')
  node.textContent = displayText(message)
  node.className = `field-hint ${type}`
}

function showMessage(message, type = '') {
  const node = $('#form-message')
  node.textContent = displayText(message || '')
  node.className = `form-message ${type}`
}

async function selectJob(jobId, { forceExceptionDialog = false, preserveConversation = false } = {}) {
  state.conversationMode = 'runtime'
  state.conversationAlertToken = null
  if (preserveConversation) state.conversationKey = jobId
  else restoreConversation(jobId)
  state.commandJobId = state.conversationRecords.length ? jobId : null
  state.selectedJobId = jobId
  renderJobList()
  await refreshSelectedJob({ forceExceptionDialog })
}

async function refreshSelectedJob({ forceExceptionDialog = false } = {}) {
  if (!state.selectedJobId) return
  try {
    const [{ job }, logs] = await Promise.all([api(`/api/jobs/${encodeURIComponent(state.selectedJobId)}`), api(`/api/jobs/${encodeURIComponent(state.selectedJobId)}/logs`)])
    state.selectedJob = job
    presentationPrivacy.registerJobs([job])
    state.currentLogs = logs
    renderSelectedJob({ forceExceptionDialog })
    renderLogs(logs)
  } catch (error) { $('#log-output').textContent = displayText(`状态读取失败：${error.message}`) }
}

function schedulePoll(delay = 2500) {
  window.clearTimeout(state.pollTimer)
  state.pollTimer = window.setTimeout(poll, delay)
}

async function poll() {
  if (state.pollInFlight || state.submitInFlight) {
    schedulePoll()
    return
  }
  state.pollInFlight = true
  try {
    await Promise.allSettled([loadJobs(), loadSystem(), loadAgents(), refreshSelectedJob()])
  } finally {
    state.pollInFlight = false
    schedulePoll()
  }
}

function renderJobList() {
  const list = $('#job-list')
  const archivedOpen = list.querySelector('.archived-jobs')?.open || false
  const currentJobs = state.jobs.filter(job => job.decision_mode === 'enterprise_decision_v2')
  const archivedJobs = state.jobs.filter(job => job.decision_mode !== 'enterprise_decision_v2')
  $('#history-count').textContent = `${currentJobs.length} 条新任务 · ${archivedJobs.length} 条旧版存档`
  if (!state.jobs.length) { list.innerHTML = '<p class="empty-state">暂无进件记录。</p>'; return }
  const cards = jobs => jobs.map(job => `
    <button type="button" class="job-card ${job.job_id === state.selectedJobId ? 'active' : ''}" data-job-id="${escapeHtml(job.job_id)}">
      <div class="job-card-top"><strong>${displayHtml(displayCompanyLabel(job))}</strong><span class="mini-status ${escapeHtml(job.status)}">${displayHtml(STATUS_LABELS[job.status] || job.status)}</span></div>
      <p>${job.decision_mode === 'enterprise_decision_v2' ? '两层五席 · ' : '旧版存档 · 仅供查看 · '}${displayHtml(PHASE_LABELS[job.phase] || (job.intake_required ? '等待公开证据建案' : '等待分析'))}</p><p class="job-record-meta">${displayHtml(new Date(job.created_at || job.updated_at).toLocaleString('zh-CN', {month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit'}))} · ${escapeHtml(job.job_id.slice(-8))}</p>
    </button>`).join('')
  list.innerHTML = `${currentJobs.length ? cards(currentJobs) : '<p class="empty-state">暂无分析任务。</p>'}${archivedJobs.length ? `<details class="archived-jobs" ${archivedOpen ? 'open' : ''}><summary>旧版任务存档（${archivedJobs.length}）</summary>${cards(archivedJobs)}</details>` : ''}`
  list.querySelectorAll('[data-job-id]').forEach(button => button.addEventListener('click', () => selectJob(button.dataset.jobId, { forceExceptionDialog: true })))
}

function renderSelectedJob({ forceExceptionDialog = false } = {}) {
  const job = state.selectedJob
  if (!job) return
  $('#job-status').textContent = displayText(STATUS_LABELS[job.status] || job.status)
  $('#job-status').className = `status-badge ${job.status}`
  $('#job-title').textContent = job.decision_mode === 'enterprise_decision_v2' ? displayText(job.task) : displayCompanyLabel(job)
  $('#job-subtitle').textContent = job.decision_mode === 'enterprise_decision_v2' ? displayCompanyLabel(job) : job.intake_required ? '正在自动完成产业链规划、公开证据建案与分析。' : '历史版本存档，仅供查看。'
  $('#progress-fill').style.width = `${Math.max(0, Math.min(100, job.progress_percent || 0))}%`
  $('#progress-label').textContent = `${job.progress_percent || 0}%`
  $('#stage-label').textContent = PHASE_LABELS[job.phase] || job.phase || '等待调度'
  if (state.conversationMode === 'runtime' && state.commandJobId !== job.job_id) {
    state.commandJobId = job.job_id
    if (job.runtime_messages?.length) { state.conversationRecords = job.runtime_messages; saveConversation(); renderConversation() }
    appendWorkspaceMessage('agent', `已打开“${displayCompanyLabel(job)}”的分析任务。`)
  }
  if (state.conversationMode === 'runtime' && job.runtime_messages?.length) {
    const incoming = JSON.stringify(job.runtime_messages)
    if (incoming !== state.runtimeMessagesSnapshot) {
      state.runtimeMessagesSnapshot = incoming
      state.conversationRecords = job.runtime_messages
      saveConversation(); renderConversation()
    }
  }
  if (state.conversationMode === 'runtime') $('#command-context').textContent = `${STATUS_LABELS[job.status] || job.status} · ${PHASE_LABELS[job.phase] || job.phase || '等待调度'}`
  renderElapsed()
  renderPipeline(job)
  renderAgents()
  renderResult(job)
  if (state.conversationMode === 'runtime' && ['failed', 'paused', 'interrupted', 'awaiting_question', 'awaiting_assistance'].includes(job.status)) {
    const token = exceptionIncidentToken(job)
    if (token !== state.conversationAlertToken && !job.runtime_messages?.some(item => ['error','assistance'].includes(item.kind) && item.at >= (job.started_at || ''))) {
      state.conversationAlertToken = token
      if (job.status === 'awaiting_assistance') {
        state.conversationRecords.push({ role: 'agent', label: '运行协调Agent', kind: 'assistance', gaps: displayItems(job.assistance_request?.gaps || job.result?.gaps), at: new Date().toISOString() })
        saveConversation(); renderConversation()
      } else {
      const issue = job.failure ? friendlyFailureMessage(job.failure) : (job.assistance_request?.gaps || []).join('；')
      appendWorkspaceMessage('agent', `任务${STATUS_LABELS[job.status] || job.status}。${issue || '请查看运行结果和日志。'}${['failed', 'paused', 'interrupted'].includes(job.status) ? ' 可输入“失败原因”或“从断点继续”。' : ' 可输入“当前状态”或“失败原因”查看详情。'}`)
      }
    }
  }
}

function renderElapsed() {
  const job = state.selectedJob
  if (!job?.started_at) { $('#elapsed-time').textContent = '—'; return }
  const end = job.completed_at ? Date.parse(job.completed_at) : Date.now()
  const seconds = Math.max(0, Math.floor((end - Date.parse(job.started_at)) / 1000))
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const rest = seconds % 60
  $('#elapsed-time').textContent = hours ? `${hours}:${pad(minutes)}:${pad(rest)}` : `${pad(minutes)}:${pad(rest)}`
}

function renderPipeline(job) {
  const pipeline = $('#pipeline')
  legacyPipelineHtml ||= pipeline.innerHTML
  if (job.decision_mode === 'enterprise_decision_v2') {
    const events = job.result?.metadata?.graph_trace || job.events || []
    const phases = new Set(events.map(event => event.phase))
    const gate = job.result?.metadata?.evidence_processing?.source_gate || job.evidence_gate
    const stages = job.result?.metadata?.stages || job.enterprise_stages || {}
    const completed = key => key === 'planning' ? job.agent_states?.industry_research_planner?.status === 'completed' : key === 'evidence' ? gate?.satisfied === true : key === 'direction' ? Boolean(stages.direction) : key === 'condition' ? Boolean(stages.condition) : key === 'search' ? phases.has('supplemental_search') : key === 'report' ? Boolean(job.result?.report) : job.status === 'approved'
    const active = key => job.status === 'running' && ((key === 'planning' && job.phase === 'industry_chain_planning') || (key === 'evidence' && ['evidence_intake','session_initialization','public_information_monitoring'].includes(job.phase)) || (key === 'direction' && String(job.phase).startsWith('direction')) || (key === 'condition' && String(job.phase).startsWith('condition')) || (key === 'search' && job.phase === 'supplemental_search') || (key === 'report' && job.phase === 'report'))
    pipeline.innerHTML = ENTERPRISE_STEPS.map(([key, title, note], index) => { const status = completed(key) ? 'completed' : active(key) ? 'running' : key === 'approval' && job.status === 'pending_approval' ? 'running' : ''; const visibleTitle = key === 'approval' && job.status === 'pending_approval' ? '旧版人工审批' : title; return `<article class="pipeline-step ${status}" data-step="${key}"><span class="step-number">${index + 1}</span><div><h3>${visibleTitle}</h3><p>${note}</p></div><span class="step-state">${status === 'completed' ? '已通过' : status === 'running' ? '进行中' : key === 'search' ? '按需执行' : '等待'}</span></article>` }).join('')
    const attempts = job.result?.metadata?.attempts || []
    const last = attempts.at(-1)
    $('#runtime-diagnostics').innerHTML = `<div><span>整案独立来源</span><strong>${gate ? `${escapeHtml(gate.independent_source_count)}/2` : '待筛选'}</strong><small>${!gate ? '等待证据' : gate.satisfied ? '门禁通过' : '需补充'}</small></div><div><span>Rulora 冻结</span><strong>${last ? `第${escapeHtml(last.attempt)}次` : '待冻结'}</strong><small>${escapeHtml(last?.status || '等待运行')}</small></div>`
    return
  }
  if (pipeline.innerHTML !== legacyPipelineHtml) pipeline.innerHTML = legacyPipelineHtml

  const stateByStep = job.v2_state?.stages || {}
  const map = { evidence: 'evidence_collection', 'action-decision': 'action_decision', 'action-calibration': 'action_calibration', 'risk-decision': 'risk_decision', 'risk-calibration': 'risk_calibration', reviewer: 'reviewer_selection', 'champion-gate': 'champion_gate', finalization: 'finalization' }
  document.querySelectorAll('.pipeline-step').forEach(step => {
    const stage = stateByStep[map[step.dataset.step]]
    let status = stage?.status || 'pending'
    if (status === 'pending') status = 'waiting'
    if (job.status === 'succeeded') status = 'completed'
    step.className = `pipeline-step ${status === 'waiting' ? '' : status}`
    step.querySelector('.step-state').textContent = { waiting: '等待', running: '执行中', completed: '已通过', failed: '失败', paused: '已暂停', closed: '已关闭' }[status] || status
  })
  const constraint = job.v2_state?.constraint || { status: 'pending', attempt: 0, max_attempts: 3 }
  const recovery = job.v2_state?.recovery || { count: 0, last_mode: null }
  $('#runtime-diagnostics').innerHTML = `
    <div><span>约束检查</span><strong>${escapeHtml(constraint.status === 'pending' ? '等待' : constraint.status)}</strong><small>第 ${escapeHtml(constraint.attempt || 0)}/${escapeHtml(constraint.max_attempts || 3)} 次</small></div>
    <div><span>格式恢复</span><strong>${recovery.count ? `${escapeHtml(recovery.count)}次` : '未触发'}</strong><small>${escapeHtml(recoveryLabel(recovery.last_mode))}</small></div>`
}

function renderSeatSummaries(metadata) {
  return ['direction', 'condition'].map(stage => {
    const record = metadata?.stages?.[stage]
    if (!record?.seat_summaries?.length) return ''
    return `<details class="advice-detail-panel" data-result-detail="seats-${stage}"><summary>${stage === 'direction' ? '第一层' : '第二层'}五席摘要与复核依据</summary>${record.seat_summaries.map(seat => `<p><strong>${displayHtml(seat.label || seat.seat_id)}</strong> · ${displayHtml(seat.status === 'frozen' ? '席位已冻结' : '轮次结束时仍待复审')}<br>${displayHtml(seat.summary)}<br>复审摘要：${displayHtml(seat.review_summary || '—')}</p>`).join('')}<p>复核：${displayHtml(record.semantic_review?.review_reason || '—')}<br>适用规则：${displayHtml((record.semantic_review?.applied_rule_ids || []).join('、') || '—')}</p></details>`
  }).join('')
}

function renderAgents() {
  const selectedStates = state.selectedJob?.agent_states || {}
  const displayedAgents = state.agents.map(agent => selectedStates[agent.agent_id] ? { ...agent, ...selectedStates[agent.agent_id] } : agent)
  const layerDefinitions = state.selectedJob && state.selectedJob.decision_mode !== 'enterprise_decision_v2' ? AGENT_LAYERS : ENTERPRISE_LAYERS
  const visibleStages = new Set(layerDefinitions.map(layer => layer.stage))
  const active = displayedAgents.filter(agent => visibleStages.has(agent.stage) && agent.status === 'running')
  $('#active-agent-label').textContent = active.length ? `正在运行：${active.map(agent => agent.label).join('、')}` : '当前无Agent运行'
  if (!state.agents.length) { $('#agent-grid').innerHTML = '<p class="empty-state">尚未载入Agent配置。</p>'; return }
  const layers = layerDefinitions.map(layer => ({ ...layer, agents: displayedAgents.filter(agent => agent.stage === layer.stage) })).filter(layer => layer.agents.length)
  $('#agent-grid').innerHTML = layers.map(layer => `<section class="agent-layer agent-layer-${escapeHtml(layer.stage)}" aria-label="${escapeHtml(layer.label)}">
    <div class="agent-layer-head"><b>${layer.number}</b><div><h3>${layer.label}</h3><p>${layer.note}</p></div></div>
    <div class="agent-seat-list">${layer.agents.map(agent => {
      const status = agent.status === 'not_in_case' && agent.stage === 'periodic_improvement' ? '案外待命' : AGENT_STATUS_LABELS[agent.status] || agent.status
      const work = agent.phase ? PHASE_LABELS[agent.phase] || agent.phase : (agent.current_companies || []).map(item => `${displayCompanyLabel(item)} · ${PHASE_LABELS[item.phase] || item.phase}`).join('；')
      return `<span class="seat-chip ${escapeHtml(agent.status)}" title="${escapeHtml([agent.label, status, work].filter(Boolean).join(' · '))}"><i aria-hidden="true"></i><strong>${displayHtml(agent.label)}</strong><em>${escapeHtml(status)}${agent.exchange_round ? ` · ${escapeHtml(agent.exchange_round)}/${escapeHtml(agent.max_exchange_rounds || '—')}轮` : ''}</em></span>`
    }).join('')}</div>
  </section>`).join('')
}

function exceptionIncidentToken(job) {
  if (!job?.job_id) return null
  const failure = job.failure || {}
  return [job.job_id, job.status, job.completed_at || job.updated_at || '', job.resume_count || 0, failure.code || '', failure.message || ''].join('|')
}
function acknowledgeCurrentException() {
  if (state.exceptionIncidentToken) state.acknowledgedExceptions.add(state.exceptionIncidentToken)
}
function showExceptionDialog(job, { force = false } = {}) {
  if (job.decision_mode === 'enterprise_decision_v2') return // Runtime interaction lives in the main dialogue.
  if (!['failed', 'paused', 'interrupted'].includes(job?.status)) return
  const incidentToken = exceptionIncidentToken(job)
  if (!force && state.acknowledgedExceptions.has(incidentToken)) return
  const dialog = $('#exception-dialog')
  if (!dialog) return
  // Polling refreshes the selected job frequently. Keep an open conversation
  // intact for the same incident instead of clearing its messages every poll.
  if (dialog.open && state.exceptionIncidentToken === incidentToken && !force) return
  const issue = exceptionExplanation(job)
  state.exceptionJob = job
  state.exceptionIncidentToken = incidentToken
  $('#exception-chat').innerHTML = ''
  appendExceptionMessage('agent', `我是运行协调Agent。当前问题：${issue.message}`)
  $('#exception-company').textContent = displayCompanyLabel(job)
  $('#exception-title').textContent = issue.title
  $('#exception-message').textContent = issue.message
  $('#exception-guidance').textContent = issue.guidance
  const unresolved = job.failure?.code === 'PAUSED_ACTION_UNRESOLVED'
  $('#exception-default-actions').hidden = unresolved
  $('#exception-action-resolution').hidden = !unresolved
  if (!dialog.open) dialog.showModal()
}
function appendExceptionMessage(role, message) {
  const chat = $('#exception-chat')
  const node = document.createElement('div')
  node.className = `exception-message ${role}`
  node.innerHTML = `<b>${role === 'user' ? '你' : '运行协调Agent'}</b><p>${escapeHtml(message)}</p>`
  chat.appendChild(node); chat.scrollTop = chat.scrollHeight
}
function readConversation(key) {
  try {
    const rows = JSON.parse(window.localStorage.getItem(CONVERSATION_PREFIX + key) || (key !== 'draft' ? window.localStorage.getItem('rulora.conversation.v1.' + key) : null) || '[]')
    if (key === 'draft' && Array.isArray(rows) && rows.every(row => row?.role === 'agent')) return []
    return Array.isArray(rows) ? rows.filter(row => row && ['user', 'agent'].includes(row.role) && typeof row.message === 'string' && row.message.length <= 4000).slice(-150) : []
  } catch { return [] }
}

function saveConversation() {
  try { window.localStorage.setItem(CONVERSATION_PREFIX + state.conversationKey, JSON.stringify(state.conversationRecords.slice(-150))) } catch {}
}

function cleanDisplayText(value) {
  return String(value || '').replace(/[。；;]\s*[；;]/g, '；').replace(/；\s*。/g, '。').replace(/([。；，！？])\1+/g, '$1').trim()
}
function displayItems(values) {
  return [...new Set((values || []).map(value => cleanDisplayText(value).replace(/[。；;\s]+$/g, '')).filter(Boolean))]
}
function renderGapList(values) {
  const items = displayItems(values)
  const list = rows => `<ul>${rows.map(text => `<li>${displayHtml(text)}</li>`).join('')}</ul>`
  return list(items)
}
function renderMessageBody(row) {
  if (row.kind === 'assistance') return `<div class="assistance-message"><strong>需要处理</strong><p>分析暂未通过交付审核。<a href="#result-content">查看运行结果及原因</a></p><p>可补充影响判断的规则或经验，或输入“从断点继续”；无需继续时输入“关闭任务”。</p></div>`
  return row.role === 'agent' && String(row.message || '').length > 600 ? renderReason(row.message) : `<p class="message-text">${displayHtml(cleanDisplayText(row.message))}</p>`
}
function renderReason(value) {
  return cleanDisplayText(value).split(/\n+|；(?=决策建议：)/).filter(Boolean).map(text => text.split('；').length > 3 ? renderGapList(text.split('；')) : `<p class="message-text">${displayHtml(text)}</p>`).join('')
}

function renderConversation() {
  const list = $('#command-messages')
  const html = state.conversationRecords.length ? state.conversationRecords.map(row => {
    const when = Number.isFinite(Date.parse(row.at)) ? new Date(row.at).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : ''
    return `<div class="command-message ${escapeHtml(row.role)}"><div class="message-meta"><b>${displayHtml(row.label || (row.role === 'user' ? '你' : '系统'))}</b><time>${escapeHtml(when)}</time></div>${renderMessageBody(row)}</div>`
  }).join('') : '<p class="empty-state">分析开始后，可在此查询进度、补充信息。</p>'
  if (list.innerHTML === html) return
  const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 48
  list.innerHTML = html
  if (nearBottom) list.scrollTop = list.scrollHeight
}

function restoreConversation(key) {
  state.conversationKey = key
  state.conversationRecords = readConversation(key)
  renderConversation()
}

function appendWorkspaceMessage(role, message, { label = null } = {}) {
  const record = { role, label: label || (role === 'user' ? '你' : '运行协调Agent'), message: String(message), at: new Date().toISOString() }
  state.conversationRecords.push(record)
  state.conversationRecords = state.conversationRecords.slice(-150)
  saveConversation()
  renderConversation()
}

function loadQuickCommands() {
  try {
    const saved = JSON.parse(window.localStorage.getItem(QUICK_COMMANDS_KEY) || 'null')
    state.quickCommands = Array.isArray(saved) ? saved.filter(item => typeof item === 'string' && item.trim()).slice(0, 12) : ['当前状态', '失败原因', '从断点继续']
  } catch { state.quickCommands = ['当前状态', '失败原因', '从断点继续'] }
  renderQuickCommands()
}

function renderQuickCommands() {
  $('#quick-command-list').innerHTML = state.quickCommands.length ? state.quickCommands.map((command, index) => `<span class="quick-command-item"><button type="button" data-quick-select="${index}">${escapeHtml(command)}</button><button type="button" class="quick-remove" data-quick-remove="${index}" aria-label="删除常用指令：${escapeHtml(command)}">×</button></span>`).join('') : '<p class="field-hint">尚未设置常用指令。</p>'
}

function saveQuickCommands() {
  try { window.localStorage.setItem(QUICK_COMMANDS_KEY, JSON.stringify(state.quickCommands)) } catch {}
  renderQuickCommands()
}

function addQuickCommand(event) {
  event.preventDefault()
  const input = $('#quick-command-input')
  const command = input.value.trim()
  if (!command || state.quickCommands.includes(command) || state.quickCommands.length >= 12) return
  state.quickCommands.push(command)
  input.value = ''
  saveQuickCommands()
}

function handleQuickCommandClick(event) {
  const select = event.target.closest('[data-quick-select]')
  const remove = event.target.closest('[data-quick-remove]')
  if (select) { $('#workspace-command').value = state.quickCommands[Number(select.dataset.quickSelect)] || ''; $('#workspace-command').focus() }
  if (remove) { state.quickCommands.splice(Number(remove.dataset.quickRemove), 1); saveQuickCommands() }
}

async function submitWorkspaceCommand(event) {
  event.preventDefault()
  const input = $('#workspace-command')
  const message = input.value.trim()
  if (!message) return
  const job = state.selectedJob
  if (!job || job.decision_mode !== 'enterprise_decision_v2') { appendWorkspaceMessage('agent', '请先在企业选择区启动分析，或选择当前版本的任务。'); return }
  const button = $('#workspace-command-form button')
  button.disabled = true
  try {
    const response = await api(`/api/jobs/${encodeURIComponent(job.job_id)}/command`, { method: 'POST', body: JSON.stringify({ message }) })
    input.value = ''
    state.conversationRecords = response.job.runtime_messages || []
    saveConversation()
    renderConversation()
    await selectJob(job.job_id)
  } catch (error) { appendWorkspaceMessage('agent', `指令未执行：${error.message}`) }
  finally { button.disabled = false }
}
function submitExceptionCommand(event) { event.preventDefault(); const input = $('#exception-command'); const value = input.value.trim(); if (!value) return; input.value = ''; handleExceptionCommand(value) }
async function handleExceptionCommand(command) {
  const job = state.exceptionJob
  if (!job) return
  appendExceptionMessage('user', command)
  if (/断点|恢复|重试|继续|重新|再运行/.test(command)) {
    if (state.resumeRequestPending) { appendExceptionMessage('agent', '恢复请求已经提交，请等待当前操作完成。'); return }
    state.resumeRequestPending = true
    document.querySelectorAll('[data-exception-command]').forEach(button => { button.disabled = true })
    appendExceptionMessage('agent', '收到。我会沿用原任务断点；已经完成的节点不重复调用，只执行失败和未完成节点。')
    try {
      const { job: resumed } = await api(`/api/jobs/${encodeURIComponent(job.job_id)}/resume`, { method:'POST' })
      acknowledgeCurrentException()
      state.exceptionJob = resumed
      state.selectedJobId = resumed.job_id
      appendExceptionMessage('agent', `已从断点恢复：${displayCompanyLabel(resumed)}。任务编号保持不变，可查看继续运行的进度。`)
      await Promise.all([loadJobs(), loadAgents()])
    } catch (error) { appendExceptionMessage('agent', `未能从断点恢复：${error.message}`) }
    finally { state.resumeRequestPending = false; document.querySelectorAll('[data-exception-command]').forEach(button => { button.disabled = false }) }
    return
  }
  if (/原因|为什么|解释|详情/.test(command)) { const issue=exceptionExplanation(job); appendExceptionMessage('agent', issue.detail || `${issue.title}。${issue.message} ${issue.guidance}`); return }
  if (/暂不|关闭|稍后|忽略/.test(command)) { acknowledgeCurrentException(); appendExceptionMessage('agent', '已记录为暂不处理。本次结果不会进入正式交付。'); return }
  appendExceptionMessage('agent', '我可以执行“从断点继续”、说明“失败原因”，或将任务标记为“暂不处理”。请明确选择一种处理方式。')
}

async function resolveActionDisagreement(selection) {
  const job = state.exceptionJob
  if (!job || state.resumeRequestPending) return
  const labels = { tighten:'收紧经营', maintain:'维持经营', increase:'增加经营', reanalyze:'重新进行三席分析' }
  appendExceptionMessage('user', labels[selection] || selection)
  state.resumeRequestPending = true
  document.querySelectorAll('[data-action-resolution]').forEach(button => { button.disabled = true })
  try {
    const body = selection === 'reanalyze' ? { mode:'reanalyze' } : { mode:'adjudicate', direction:selection }
    const { job: resumed } = await api(`/api/jobs/${encodeURIComponent(job.job_id)}/action-resolution`, { method:'POST', body:JSON.stringify(body) })
    state.exceptionJob = resumed; state.selectedJobId = resumed.job_id
    appendExceptionMessage('agent', selection === 'reanalyze' ? '已保留原记录，并重新启动三席独立分析。' : `已记录人工裁决“${labels[selection]}”。三席原意见保持不变，程序将基于该方向继续。`)
    acknowledgeCurrentException(); await Promise.all([loadJobs(), loadAgents()])
  } catch (error) { appendExceptionMessage('agent', `处理失败：${error.message}`) }
  finally { state.resumeRequestPending = false; document.querySelectorAll('[data-action-resolution]').forEach(button => { button.disabled = false }) }
}

function exceptionExplanation(job = {}) {
  const failure = job.failure || {}
  const text = String(failure.message || '')
  const phase = PHASE_LABELS[job.phase] || job.phase || '当前阶段'
  const failedAgents = Object.values(job.agent_states || {}).filter(agent => agent.status === 'failed')
  const agentNames = failedAgents.map(agent => agent.label || agent.agent_id).join('、') || '当前执行Agent'
  const retained = Number(job.progress_percent || 0) > 0 ? `任务已完成到${job.progress_percent}%，成功节点和冻结数据仍然保留。` : '本次尚未形成可交付结果。'
  if (failure.code === 'PAUSED_ACTION_UNRESOLVED') {
    return {
      title:'三席经营方向未达成一致',
      message:'三席分别给出风险上升、风险持平和风险下降，没有任何方向达到冻结条件。',
      guidance:'程序已在风控措施分析前暂停，避免在经营方向未确定时继续推演。',
      detail:'失败发生在经营方向冻结环节。三席交流后仍各自保持不同判断，没有方向获得至少两席支持，因此程序不能选择默认答案，也不能进入依赖经营方向的风控措施阶段。这属于需要宿主原则或人工指令处理的真实分歧，不是模型格式错误。'
    }
  }
  if (failure.code === 'EVIDENCE_INCOMPLETE') {
    const rawMissing = text.includes('：') ? text.split('：').slice(1).join('：').split(',').map(value => value.trim()).filter(Boolean) : []
    const sourceNames = { cninfo:'巨潮资讯企业披露', government_policy:'政府政策', gdelt:'公开媒体', tianyancha:'企业登记', credit_china:'政府信用' }
    const missing = rawMissing.map(value => sourceNames[value] || value).join('、') || '必需公开来源'
    return {
      title:'公开证据不足',
      message:`${agentNames}在${phase}停止：${missing}没有达到建案门槛。`,
      guidance:'分析席尚未开始。需要先修正来源适用性、恢复来源连接或补足证据，再从断点继续。',
      detail:`失败发生在${phase}，执行角色是${agentNames}。系统要求的${missing}没有达到最低数量或来源接口未正常返回，因此证据包没有通过门禁，后续分析没有启动。这不是分析结论失败，也不是模型判断企业有风险；它表示当前公开证据不足以建立合格案例。修正来源或补足证据后，可以沿用原任务断点继续。`
    }
  }
  if (failure.code === 'SCHEMA_FAILURE' || /JSON gate|recoverable Competition|schema/i.test(text)) {
    return {
      title:'模型返回格式不完整',
      message:`${agentNames}在${phase}没有返回系统要求的完整结构化结果。`,
      guidance:'已有分析与候选方案仍保留；从断点继续时只重新执行这个未完成节点。',
      detail:`失败发生在${phase}，执行角色是${agentNames}。模型返回了分析过程文本，但没有形成必需的JSON字段，程序无法确认它最终选择了哪个经营方向候选和哪个完整风控方案。为避免程序从过程文本猜答案，门禁拒绝了本次输出。${retained}从断点继续只会重新执行该格式失败节点。`
    }
  }
  if (failure.code === 'PAUSED_UPSTREAM' && /timed out|timeout/i.test(text)) {
    return {
      title:'模型服务响应超时',
      message:`${agentNames}在${phase}调用模型时，等待超过本次允许时间。`,
      guidance:'企业资料和已经完成的Agent结果均已保留；可从断点继续，只重试超时节点。',
      detail:`失败发生在${phase}，受影响角色是${agentNames}。模型请求已经发出，但在规定时间内没有完成返回。这是上游响应超时，不是503错误，也不代表三席已经形成无法收敛的结论。${retained}从断点继续只重试超时节点。`
    }
  }
  if (failure.code === 'PAUSED_UPSTREAM' || /503|Service temporarily unavailable/i.test(text)) {
    return {
      title:'模型服务临时不可用',
      message:`${agentNames}在${phase}调用模型时，服务端返回503临时不可用。`,
      guidance:'企业资料和已经完成的Agent结果没有问题；可从断点继续，只重试失败节点。',
      detail:`失败发生在${phase}，受影响角色是${agentNames}。模型接入服务明确返回503 Service temporarily unavailable，表示当时上游服务短暂不可用或负载过高，不代表企业数据错误，也不代表Agent得出了失败结论。${retained}从断点继续只重试失败及未完成节点。`
    }
  }
  if (/timed out/i.test(text)) {
    return {
      title:'模型响应超时',
      message:`${agentNames}在${phase}超过等待时间，没有返回完整结果。`,
      guidance:'已完成步骤仍然保留；可从断点继续，只重试未完成节点。',
      detail:`失败发生在${phase}，受影响角色是${agentNames}。系统在规定时间内没有收到完整响应，所以停止等待并保留断点。${retained}这不是企业数据错误，从断点继续只重试未完成节点。`
    }
  }
  if (/lock timeout/i.test(text) || failedAgents.some(agent => agent.error_code === 'LOCK_TIMEOUT')) return {
    title:'任务执行发生冲突',
    message:`${agentNames}在${phase}等待同一任务的执行锁超时。`,
    guidance:'这是重复恢复或旧进程占用造成的运行冲突；确认当前没有同一任务正在运行后，可从断点继续。',
    detail:`失败发生在${phase}。同一任务曾被重复启动，多个进程同时争用相同检查点，程序为避免覆盖结果而停止。企业资料与已完成节点仍然保留。当前任务互斥机制已启用，从断点继续会沿用同一任务并防止再次重复提交。`
  }
  if (/forbidden loop|data refresh/.test(text)) return {
    title:'复核请求超出权限',
    message:`${agentNames}在${phase}提出了复核权限之外的操作。`,
    guidance:'系统已停止交付，避免复核改变既有分析。',
    detail:`失败发生在${phase}。复核只能校对或从冻结候选中选择，不能要求重新分析、重新广播或刷新证据；本次输出越过了这个边界，因此程序拒绝交付。已有候选和过程记录仍保留。`
  }
  if (failure.code === 'WEB_SERVER_RESTARTED') return {
    title:'服务重启导致中断',
    message:`任务在${phase}运行时，本地服务被重启。`,
    guidance:'原任务断点仍然保留，可以确认后继续。',
    detail:`任务不是业务失败，而是在${phase}运行期间遇到本地服务重启。${retained}从断点继续会沿用原任务，不会重新进件。`
  }
  return {
    title:'任务未完成',
    message:`任务在${phase}停止：${friendlyFailureMessage(failure)}`,
    guidance:'可查看实时日志，或从断点继续。',
    detail:`任务在${phase}停止，相关角色为${agentNames}。系统记录的直接原因是：${friendlyFailureMessage(failure)} ${retained}`
  }
}

const resultDisclosureStates = new Map()
let renderedResultJobId = null
let renderedResultHtml = null

function renderResult(job) {
  const container = $('#result-content')
  const detailKey = (node, index) => node.dataset.resultDetail || `${node.closest('[data-result-detail]')?.dataset.resultDetail || 'result'}:nested:${index}`
  if (renderedResultJobId !== null) {
    resultDisclosureStates.set(renderedResultJobId, new Map(Array.from(container.querySelectorAll('details'), (node, index) => [detailKey(node, index), node.open])))
  }
  const next = document.createElement('div')
  renderResultContent(job, next)
  const html = next.innerHTML
  if (renderedResultJobId === job.job_id && renderedResultHtml === html) return
  const saved = resultDisclosureStates.get(job.job_id)
  next.querySelectorAll('details').forEach((node, index) => {
    if (saved?.has(detailKey(node, index))) node.open = saved.get(detailKey(node, index))
  })
  container.replaceChildren(...next.childNodes)
  renderedResultJobId = job.job_id
  renderedResultHtml = html
}

function renderResultContent(job, container) {
  if (job.status === 'failed' || job.status === 'interrupted' || job.status === 'closed') {
    const failure = job.failure || {}
    const assistance = (job.manual_assistance_requests || []).length ? `<br><br>需要人工协助：${displayHtml(job.manual_assistance_requests.map(item => item.source_id || item.id).join('、'))}` : ''
    const heading = job.status === 'closed' ? '任务已关闭' : '任务未完成'
    container.innerHTML = `<div class="failure-box"><strong>${heading}</strong><br>${displayHtml(friendlyFailureMessage(failure))}${assistance}</div>`
    return
  }
  if (!job.result) { container.innerHTML = '<p class="empty-state">进件完成后在此显示正式结论。</p>'; return }
  const result = job.result
  if (job.decision_mode === 'enterprise_decision_v1') {
    const report = result.report || {}
    container.innerHTML = `<section class="advice-detail-panel"><strong>历史版本 · 仅供查看</strong><p>前景方向：${displayHtml(({1:'积极',0:'持平','-1':'保守'})[report.方向] || '暂无法判断')}；行动条件：${displayHtml(({1:'满足',0:'等待','-1':'不满足'})[report.行动条件] || '暂无法判断')}</p><p>${displayHtml(report.理由 || '')}</p></section>`
    return
  }
  if (job.decision_mode === 'enterprise_decision_v2') {
    const report = result.report || {}
    const currentOptions = result.metadata?.action_options_version === '3.0.0-object-boundaries'
    const direction = report.方向 === null ? '暂无法判断' : ({ 1: '拓展', 0: '维持', '-1': '收缩' })[report.方向]
    const actions = report.决策建议 || []
    const limitations = [...new Set(['direction','condition'].flatMap(key => result.metadata?.stages?.[key]?.assumptions || []))]
    const limitationPanel = limitations.length ? `<details class="advice-detail-panel" data-result-detail="limitations"><summary>分析限制与假设（${limitations.length}项）</summary>${renderGapList(limitations)}</details>` : ''
    const cards = actions.map(a => a.编号 === 10 ? `<article class="advice-detail-panel"><strong>10 · 无法提出可靠建议</strong>${renderGapList(String(a.无法建议原因 || '').split(/[；\n]+/))}<p>请在对话与指令区查看缺口或补充信息。</p></article>` : a.编号 === 13 ? `<article class="advice-detail-panel"><strong>13 · 无需新增措施</strong><p>${displayHtml(a.无需新增原因)}</p><p>已有安排经复核支持当前经营方向。</p>${(a.已有安排 || []).map(row => `<p>${displayHtml(row.arrangement)}<br><span>证据：${displayHtml((row.evidence_refs || []).join('、'))}</span></p>`).join('')}<p>方向关系：${displayHtml(a.方向关系)}</p></article>` : `<article class="advice-detail-panel"><strong>${displayHtml(a.编号)} · ${displayHtml(a.建议)}</strong><p>${displayHtml(a.action)}</p><dl class="action-facts"><dt>作用对象</dt><dd>${displayHtml(a.target)} · ${a.scope === 'overall' ? '整体' : '局部'}</dd><dt>执行前提</dt><dd>${displayHtml((a.prerequisites || []).join('；') || '未列额外前提')} · ${a.readiness === 'conditional' ? '需先核实条件' : '证据支持当前建议'}</dd><dt>方向关系</dt><dd>${displayHtml(a.direction_relation)}</dd><dt>证据依据</dt><dd>${displayHtml((a.evidence_refs || []).join('、'))}</dd></dl></article>`).join('') || (currentOptions ? '<p class="empty-state" role="alert">决策建议缺失，不能视为无需新增措施。请检查运行记录。</p>' : '<p class="empty-state">历史版本记录：维持现行安排，无需新增措施。</p>')
    container.innerHTML = `<div class="result-hero"><div class="metric-card"><span>经营方向</span><strong>${displayHtml(direction)}</strong></div><div class="metric-card"><span>决策建议</span><strong>${actions.length ? actions.map(a => displayHtml(a.编号)).join('、') : currentOptions ? '结果缺失' : '无新增建议'}</strong></div><div class="metric-card wide"><span>理由</span>${renderReason(report.理由)}</div></div><div class="decision-actions">${cards}</div>${limitationPanel}<p>状态：${displayHtml(STATUS_LABELS[job.status] || job.status)}</p><details class="advice-detail-panel" data-result-detail="evidence"><summary>证据与冻结记录</summary><p>相关证据 ${displayHtml(result.metadata?.evidence_processing?.screen?.relevant_evidence_ids?.length || 0)} 条；独立来源 ${displayHtml(result.metadata?.evidence_processing?.source_gate?.independent_source_count || 0)} 个；门禁 ${result.metadata?.evidence_processing?.source_gate?.satisfied ? '通过' : '未通过'}</p><p>方向版本：${displayHtml(result.metadata?.direction_version?.slice(0,12) || '—')}；建议版本：${displayHtml(result.metadata?.condition_version?.slice(0,12) || '—')}</p><p>方向复审 ${displayHtml(result.metadata?.stages?.direction?.loop_rounds?.length || 0)} 轮；建议复审 ${displayHtml(result.metadata?.stages?.condition?.loop_rounds?.length || 0)} 轮</p></details>${renderSeatSummaries(result.metadata)}<div class="artifact-links"><a href="/api/jobs/${encodeURIComponent(job.job_id)}/artifacts/report" target="_blank" rel="noopener">决策报告</a><a href="/api/jobs/${encodeURIComponent(job.job_id)}/artifacts/run" target="_blank" rel="noopener">证据与席位记录</a></div>`
    return
  }
  const adviceDetails = result.risk_control_advice_details?.items || []
  const pool = result.reviewer_candidate_pool
  const selection = result.reviewer_selection
  const actionCandidates = pool?.action_candidates || []
  const riskCandidates = pool?.risk_candidates || []
  const selectedActionIndex = actionCandidates.findIndex(item => item.id === selection?.selected_action_candidate_id)
  const selectedRiskIndex = riskCandidates.findIndex(item => item.id === selection?.selected_risk_candidate_id)
  const deliveryMessages = deliveryBlockerMessages(result)
  container.innerHTML = `
    <div class="result-hero">
      <div class="metric-card"><span>经营调整方向</span><strong>${displayHtml(actionLabel(result.action))}</strong></div>
      <div class="metric-card"><span>信用风险方向</span><strong>${displayHtml(riskDirectionLabel(result.risk_label))}</strong></div>
      <div class="metric-card wide"><span>风控建议码</span><div class="advice-chips">${(result.risk_control_advice || []).map(item => `<b class="advice-chip">${displayHtml(item)}</b>`).join('') || '—'}</div></div>
      <div class="metric-card"><span>交付状态</span><strong>${displayHtml(deliveryStatusLabel(result))}</strong></div>
      <div class="metric-card"><span>结论状态</span><strong>${displayHtml(conclusionStatusLabel(result))}</strong></div>
    </div>
    ${deliveryMessages.length ? `<section class="result-status-note" aria-label="交付门禁说明"><div class="delivery-note"><strong>交付门禁说明</strong>${deliveryMessages.map(item => `<p>• ${displayHtml(item)}</p>`).join('')}<p>分析流程已经完成，但该次结果不能标记为正式交付；需要在模型生产就绪后重新运行。</p></div></section>` : ''}
    ${pool ? `<section class="advice-detail-panel"><div class="advice-detail-heading"><strong>复核候选选择</strong><span>复核只选择已有候选，程序负责还原完整内容</span></div>
      <div class="candidate-grid"><div><b>经营方向候选</b>${actionCandidates.map((item, index) => `<p>方案${index + 1}：${displayHtml(actionLabel(item.value))}</p>`).join('') || '<p>—</p>'}</div>
      <div><b>风控措施候选</b>${riskCandidates.map((item, index) => `<p>方案${index + 1}：${displayHtml(adviceSetLabel(item.value))}</p>`).join('') || '<p>—</p>'}</div></div>
      <p class="selection-line">最终选择：经营方向方案${selectedActionIndex >= 0 ? selectedActionIndex + 1 : '—'}；风控措施方案${selectedRiskIndex >= 0 ? selectedRiskIndex + 1 : '—'}；复核状态：${displayHtml(conclusionStatusLabel(result))}</p>
    </section>` : ''}
    <section class="advice-detail-panel" aria-label="风控建议详解">
      <div class="advice-detail-heading"><strong>风控建议详解</strong><span>结论码冻结后确定性查表，不参与模型推理</span></div>
      ${adviceDetails.length ? `<div class="advice-detail-list">${adviceDetails.map(item => `<article class="advice-detail-item">
        <b>${displayHtml(item.code)} · ${displayHtml(item.title)}</b>
        <p>${displayHtml(item.description)}</p>
      </article>`).join('')}</div>` : '<p class="empty-state">无风控建议详解。</p>'}
    </section>
    ${presentationPrivacy.modeState().enabled ? `<div class="artifact-links privacy-artifact-note"><span>原始产物入口已在演示脱敏模式下收起</span></div>` : `<div class="artifact-links">
      <a href="/api/jobs/${encodeURIComponent(job.job_id)}/artifacts/report" target="_blank" rel="noopener">结构化报告</a>
      <a href="/api/jobs/${encodeURIComponent(job.job_id)}/artifacts/markdown" target="_blank" rel="noopener">完整报告</a>
      <a href="/api/jobs/${encodeURIComponent(job.job_id)}/artifacts/submission" target="_blank" rel="noopener">提交表</a>
      <a href="/api/jobs/${encodeURIComponent(job.job_id)}/artifacts/manifest" target="_blank" rel="noopener">校验清单</a>
      <a href="/api/jobs/${encodeURIComponent(job.job_id)}/artifacts/run" target="_blank" rel="noopener">完整运行记录</a>
    </div>`}`
}

function renderLogs(logs) {
  const output = $('#log-output')
  const atBottom = output.scrollHeight - output.scrollTop - output.clientHeight < 30
  state.currentLogs = logs || { text: '', truncated: false }
  output.textContent = displayText(logs.text || '日志尚未产生。')
  if ($('#auto-scroll').checked && (atBottom || state.selectedJob?.status === 'running')) output.scrollTop = output.scrollHeight
}

function bytesToBase64(bytes) {
  const chunkSize = 0x8000
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += chunkSize) binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))
  return btoa(binary)
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character])
}
function actionLabel(value) { return ({ '-1':'收紧经营', '0':'维持经营', '1':'增加经营' })[String(value)] || '尚未确定' }
function riskDirectionLabel(value) { return ({ risk_up:'风险上升', risk_flat:'风险持平', risk_down:'风险下降' })[String(value)] || '尚未确定' }
function conclusionLabel(value) { return ({ A:'可直接采用', B:'建议复核', REVIEW:'需要复核', PASS:'已通过', CHALLENGE_HIGH:'高风险复核', CHALLENGE_MEDIUM:'中风险复核', CHALLENGE_LOW:'低风险复核' })[String(value)] || (value ? '需要复核' : '尚未形成') }
function deliveryStatusLabel(result) { return result?.production_ready === true ? '可正式交付' : '未通过交付门禁' }
function conclusionStatusLabel(result) {
  if (result?.debate_summary?.requires_human_review === true) return '等待人工确认'
  if (result?.finalization_status === 'REJECTED') return '未通过'
  const reviewerCompleted = Boolean(result?.reviewer_selection?.selected_action_candidate_id && result?.reviewer_selection?.selected_risk_candidate_id)
  if (reviewerCompleted && ['FINALIZED', 'FINALIZED_WITH_WARNING'].includes(String(result?.finalization_status))) return '复核已完成'
  if (['FINALIZED', 'FINALIZED_WITH_WARNING'].includes(String(result?.finalization_status))) return '结论已形成'
  return '尚未形成'
}
function adviceSetLabel(values) { const items = Array.isArray(values) ? values : []; return items.length ? `风控建议 ${items.join('、')}` : '不增加风控措施' }
function displayCompanyLabel(record) { if (presentationPrivacy.modeState().enabled) return presentationPrivacy.companyLabel(record); const id = /^\d+$/.test(String(record?.company_id || '')) ? String(Number(record.company_id)) : record?.company_id; return [id, record?.company_name].filter(Boolean).join(' · ') }
function displayText(value) { return presentationPrivacy.sanitizeText(value) }
function displayHtml(value) { return escapeHtml(displayText(value)) }
function syncPresentationPrivacyControls() {
  const mode = presentationPrivacy.modeState()
  $('#presentation-privacy-toggle').checked = mode.enabled
  $('#presentation-privacy-toggle').setAttribute('aria-checked', String(mode.enabled))
  $('#presentation-privacy-badge').hidden = !mode.enabled
  $('#company-search').placeholder = mode.enabled ? '搜索演示企业代号或行业' : '搜索编号、企业名称或行业'
  document.documentElement.dataset.presentationPrivacy = mode.enabled ? 'on' : 'off'
}
function rerenderPresentationSurface() {
  presentationPrivacy.registerCompanies(state.companies)
  presentationPrivacy.registerJobs(state.jobs)
  if (state.selectedJob) presentationPrivacy.registerJobs([state.selectedJob])
  syncPresentationPrivacyControls()
  renderCompanyChecklist()
  renderJobList()
  if (state.selectedJob) renderSelectedJob()
  else renderAgents()
  renderConversation()
  renderLogs(state.currentLogs)
}
function pad(value) { return String(value).padStart(2, '0') }
function deliveryBlockerMessages(result) {
  if (result?.production_ready === true) return []
  const blockers = Array.isArray(result?.delivery_blockers) ? result.delivery_blockers.filter(Boolean) : []
  return blockers.length ? [...new Set(blockers)] : ['该历史运行没有保存具体门禁项；经校验，其运行时模型生产就绪凭证未通过。']
}
function friendlyFailureMessage(failure) {
  const labels = { WEB_SERVER_RESTARTED:'服务重启导致任务中断，可从断点继续。', MODEL_NOT_READY:'模型服务暂不可用。', MODEL_API_EMPTY_RESPONSE:'模型 API 未返回有效文本（空响应）', MODEL_API_TIMEOUT:'模型 API 请求超时', MODEL_API_UPSTREAM_FAILURE:'模型 API 上游服务异常', MODEL_API_CAPACITY_OR_RATE_LIMIT:'模型 API 容量不足或请求限流' }
  const reason = labels[failure?.code] || (/model stream contained no text content/.test(failure?.message || '') ? labels.MODEL_API_EMPTY_RESPONSE : failure?.message || '任务运行未完成')
  return `${failure?.agent_label || failure?.agent_id ? `${failure.agent_label || failure.agent_id}：` : ''}${reason}。错误码：${failure?.code || 'RUN_FAILED'}${failure?.model ? `；模型：${failure.model}` : ''}`
}
function sourceTypeLabel(value) { return ({ government_policy:'政府政策', government_statistics:'政府统计', government_credit:'政府信用', company_disclosure:'企业披露', official_market_data:'官方市场数据', enterprise_registry:'企业登记', reputable_media:'可靠媒体', social_media:'公开研究线索' })[value] || '其他公开来源' }
function recoveryLabel(mode) {
  if (mode === 'decision_block') return '已提取明确决策区块'
  if (mode === 'markdown') return '已从文本提取决策'
  if (mode === 'json_repair') return '已规范输出格式'
  return mode ? `已规范输出格式 · ${mode}` : '未触发格式恢复'
}
