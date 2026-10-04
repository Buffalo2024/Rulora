const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { validateCase, validateCritique, validateRawCritique, validateStageDecision } = require('../src/contracts')
const { refreshCaseFromEvidencePacket } = require('../src/case-builder')
const { buildDebateTermination, classifyChallenge, decisionSignature, normalizeCritique } = require('../src/debate')
const debateConfig = require('../config/debate.json')
const legacyDebateConfig = {
  minimum_consecutive_clean_rounds_for_exit: 1,
  maximum_automated_rounds_before_forced_conclusion: 6,
  maximum_total_critiques_before_forced_conclusion: 18,
  maximum_total_challenges_before_forced_conclusion: 54,
  maximum_challenges_per_critique: 3,
  suppress_repeated_issue_keys: true,
  severity_policy: {
    allowed_impacts: ['changes_risk_label', 'changes_action', 'invalidates_primary_path', 'invalidates_primary_evidence', 'changes_result', 'changes_advice_only', 'no_decision_impact'],
    high_always_categories: ['cutoff_violation', 'non_public_information', 'evidence_reference_invalid', 'primary_decision_without_ab_evidence', 'result_without_required_evidence'],
    impact_sensitive_categories: ['entity_resolution_error', 'confirmed_inferred_confusion', 'supply_chain_direction_error', 'causal_direction_error', 'material_event_omission', 'duplicate_source_independence', 'factor_double_counting', 'result_logic_gap', 'result_evidence_gap', 'transmission_horizon_error', 'alternative_explanation'],
    high_impacts: ['changes_risk_label', 'changes_action', 'invalidates_primary_path', 'invalidates_primary_evidence'],
    medium_impacts: ['changes_result', 'changes_advice_only'],
    low_only_categories: ['wording_clarity', 'formatting', 'non_material_detail']
  }
}
const { applyImprovementProposal, recordLabeledRun, recordUserFeedback, rollbackGeneration } = require('../src/evolution')
const { executeImprovementSupervisor } = require('../src/improvement-supervisor')
const { aggregateOpinions, applyDebateConclusionPolicy, cappedWeights } = require('../src/judge')
const { FileRepository } = require('../src/file-repository')
const { buildMonitoringRecord } = require('../src/monitoring')
const { parseRoleEnvironment } = require('../src/local-model-environment')
const { ManualAssistanceService } = require('../src/manual-assistance')
const { verifySmokeReceipt, writeSmokeReceipt } = require('../src/model-readiness')
const { ProviderHealthMonitor } = require('../src/provider-health-monitor')
const { MultiModelProvider, extractContent, mergeProfile, requestWithRetry } = require('../src/providers/multi-model-provider')
const { ProviderSupervisor } = require('../src/provider-supervisor')
const { GlobalProviderScheduler } = require('../src/global-provider-scheduler')
const { buildBoundedDecisionStageGraph } = require('../src/cluster-graph')
const { ModelCallCheckpointStore } = require('../src/model-call-checkpoint-store')
const { loadProvider } = require('../src/provider-loader')
const { emptyMetrics } = require('../src/population-store')
const { PublicSourceCollector } = require('../src/source-collector')
const { PublicMonitorService } = require('../src/monitor-service')
const { validateEvidenceRegistry } = require('../src/evidence-registry')
const { RunLedger } = require('../src/run-ledger')
const { loadSchemaValidators } = require('../src/schema-validator')
const { applyIndustryPlanToCollectionRequest, classifyExecutionFailure, runCase } = require('../src/orchestrator')
const { selfImpactReviewPrompt, stageDecisionPrompt } = require('../src/prompts')
const { validateBatchConfig } = require('../src/batch-runner')
const { renderSubmissionCsv } = require('../src/report')
const { buildSubmission, renderRows, validateSubmissionRow } = require('../src/submission')
const { CninfoAdapter } = require('../src/sources/cninfo-adapter')
const { GdeltAdapter } = require('../src/sources/gdelt-adapter')
const { SearxngSiteAdapter } = require('../src/sources/searxng-site-adapter')
const { UserJsonApiAdapter } = require('../src/sources/user-json-api-adapter')
const { isPrivateAddress, validatePublicUrl } = require('../src/sources/http-client')
const { normalizeUserSourceConfig } = require('../src/user-source-config')
const { sha256 } = require('../src/utils')

test('formal batch supports an explicit isolated subset without weakening the default 25-company gate', () => {
  const common = { contract_version: '1.0.0', formal_mode: true, collection_concurrency: 1, case_concurrency: 2 }
  assert.doesNotThrow(() => validateBatchConfig({ ...common, expected_company_count: 3, company_ids: ['001', '002', '003'] }))
  assert.throws(() => validateBatchConfig({ ...common, expected_company_count: 3, company_ids: ['001', '002'] }), /needs 3 unique/)
  assert.throws(() => validateBatchConfig({ ...common, company_ids: ['001', '002', '003'] }), /needs 25 unique/)
})

test('case gate rejects future evidence and a single source type', () => {
  const errors = validateCase({
    contract_version: '1.0.0',
    case_id: 'case-1',
    as_of_date: '2026-01-01',
    company: { id: 'c1', name: 'C1' },
    evidence: [{
      id: 'e1', source_type: 'news', publisher: 'P', source_url: 'https://example.com', title: 'T', summary: 'S',
      published_at: '2026-01-02', evidence_grade: 'C', content_sha256: 'a'.repeat(64), public: true
    }]
  })
  assert(errors.some(error => error.includes('future evidence rejected')))
  assert(errors.some(error => error.includes('two public source types')))
})

test('production stage protocol accepts exactly four modules and freezes direction before advice', async () => {
  const schemas = await loadSchemaValidators(path.resolve(__dirname, '..'))
  const agent = { agent_id: 'seat-1' }
  const evidenceIds = new Set(['e1'])
  const direction = {
    '执行员': 'seat-1',
    '经营调整方向': 'risk_up',
    '逻辑': [{ claim: '成本压力', mechanism: '成本上升压缩现金流。', evidence_refs: ['e1'] }],
    '证据': ['e1']
  }
  assert.equal(schemas.stageDecision(direction), true)
  assert.equal(validateStageDecision(direction, { agent, phase: 'decision_direction', evidenceIds }).length, 0)
  assert.equal(schemas.stageDecision({ ...direction, probability: 0.8 }), false)
  const advice = {
    '执行员': 'seat-1',
    '风控建议': ['4'],
    '逻辑': [{ claim: '收紧敞口', mechanism: '依据冻结的风险上升方向控制新增敞口。', evidence_refs: ['e1'] }],
    '证据': ['e1']
  }
  assert(validateStageDecision(advice, { agent, phase: 'risk_control_advice', evidenceIds }).some(error => error.includes('frozen decision direction')))
  assert.equal(validateStageDecision(advice, { agent, phase: 'risk_control_advice', evidenceIds, frozenDirection: 'risk_up' }).length, 0)
})

test('industry planning schema remains hypothesis-only and forbids a premature decision', async () => {
  const schemas = await loadSchemaValidators(path.resolve(__dirname, '..'))
  const plan = {
    '执行员': 'industry_chain_analyst',
    '产业链': {
      nodes: [{ id: 'u', name: '上游', layer: 'upstream' }, { id: 't', name: '目标企业', layer: 'target' }],
      edges: [{ from: 'u', to: 't', relation: '供给', transmission_mechanism: '供给影响成本。', verification_status: 'hypothesis_pending_public_evidence' }]
    },
    '传导逻辑': [{ factor_id: 'f1', factor: '供给', mechanism: '供给经成本影响现金流。', decision_impact: 'two_sided', invalidation_condition: '公开证据不支持该关系。' }],
    '证据需求': [
      { requirement_id: 'r1', claim_scope: '公司披露', query_terms: ['目标企业'], preferred_source_types: ['company_disclosure'], required: true },
      { requirement_id: 'r2', claim_scope: '政策', query_terms: ['行业政策'], preferred_source_types: ['government_policy'], required: true }
    ]
  }
  assert.equal(schemas.industryPlan(plan), true)
  assert.equal(schemas.industryPlan({ ...plan, '经营调整方向': 'risk_up' }), false)
})

test('industry plan requirements become bounded executable source queries with auditable gaps', () => {
  const request = {
    contract_version: '1.0.0', request_id: 'plan-query-test', as_of_date: '2026-08-09',
    company: { id: '017', name: '测试企业' },
    queries: [
      { source_id: 'cninfo', query: '测试企业', start_date: '2023-01-01', end_date: '2026-08-09', required: true },
      { source_id: 'government_policy', query: '电子信息制造业', start_date: '2023-01-01', end_date: '2026-08-09', required: true }
    ]
  }
  const plan = {
    '证据需求': [
      { requirement_id: 'r1', claim_scope: '供应商集中度', query_terms: ['前五大供应商', '采购占比'], preferred_source_types: ['company_disclosure', 'reputable_media'], required: true },
      { requirement_id: 'r2', claim_scope: '区域经济', query_terms: ['工业增加值'], preferred_source_types: ['government_statistics'], required: true }
    ]
  }
  const output = applyIndustryPlanToCollectionRequest({ request, industryPlan: plan, company: request.company })
  const planned = output.queries.filter(query => query.query_origin === 'industry_plan_requirement')
  const manual = output.queries.filter(query => query.query_origin === 'industry_plan_manual_requirement')
  assert.deepEqual(planned.map(query => query.source_id).sort(), ['cninfo', 'gdelt'])
  assert(planned.every(query => query.requirement_id === 'r1' && query.query.includes('前五大供应商')))
  assert.equal(output.queries.filter(query => query.source_id === 'cninfo').length, 2)
  assert.equal(manual[0].source_id, 'national_statistics')
  assert.equal(manual[0].required, true)
  assert.equal(output.planned_coverage_gaps.length, 0)
})

test('retrieval time remains audit metadata while published_at controls the cutoff', () => {
  const sourceConfig = require('../config/public-sources.json')
  const base = {
    id: 'gdelt:proof', source_id: 'gdelt', source_type: 'reputable_media', publisher: '公开媒体',
    source_url: 'https://example.com/proof', title: '报道', summary: '报道', published_at: '2026-08-09',
    retrieved_at: '2026-08-12T00:00:00.000Z', evidence_grade: 'C', content_sha256: sha256('proof'),
    snapshot_ref: `${sha256('proof')}.bin`, immutable_publication: false, public: true
  }
  const errors = validateEvidenceRegistry([base], { asOfDate: '2026-08-09', sourceConfig, productionMode: true })
  assert.equal(errors.some(error => error.includes('retrieved after')), false)
  assert.equal(errors.some(error => error.includes('immutable-publication proof')), false)
})

test('GDELT adapter upgrades indexed article URLs to HTTPS before evidence creation', async () => {
  const adapter = new GdeltAdapter({ httpClient: { json: async () => ({ articles: [{ url: 'http://example.com/report', title: '公开报道', domain: 'example.com', seendate: '20260808000000' }] }) } })
  const result = await adapter.collect({ query: 'supply chain', start_date: '2026-08-01', end_date: '2026-08-09', max_records: 1 })
  assert.equal(result.evidence[0].source_url, 'https://example.com/report')
  assert.match(result.evidence[0].id, /^gdelt:https:\/\//)
})

test('user source config accepts a local SearXNG endpoint and HTTPS public websites only', () => {
  const config = normalizeUserSourceConfig({
    search_backend: { type: 'searxng', enabled: true, endpoint: 'http://127.0.0.1:8080' },
    websites: [{ label: '工信部', base_url: 'https://www.miit.gov.cn/path', source_type: 'government_policy' }]
  })
  assert.equal(config.search_backend.enabled, true)
  assert.equal(config.websites[0].id, 'user-www-miit-gov-cn')
  assert.equal(config.websites[0].default_grade, 'C')
  assert.throws(() => normalizeUserSourceConfig({ search_backend: {}, websites: [{ label: '内网', base_url: 'http://127.0.0.1', source_type: 'government_policy' }] }), /HTTPS|public/i)
})

test('configured SearXNG site adapter discovers only the configured domain and preserves published evidence', async () => {
  const adapter = new SearxngSiteAdapter({
    source: { id: 'user-www-miit-gov-cn', label: '工信部', source_type: 'government_policy', data_category: 'policy', allowed_hosts: ['www.miit.gov.cn'] },
    searchBackend: { enabled: true, endpoint: 'http://127.0.0.1:8080' },
    httpClient: {
      json: async () => ({ results: [
        { url: 'https://www.miit.gov.cn/zwgk/policy.html', title: '产业政策' },
        { url: 'https://example.com/ignored', title: '越界结果' }
      ] }),
      text: async () => ({ text: '<html><head><meta property="article:published_time" content="2026-08-01"><meta property="og:title" content="产业政策"></head><body><article>产业链政策内容'.repeat(20) + '</article></body></html>' })
    }
  })
  const result = await adapter.collect({ query: '电子信息制造业', start_date: '2026-01-01', end_date: '2026-08-09', max_records: 2 })
  assert.equal(result.evidence.length, 1)
  assert.equal(result.evidence[0].source_id, 'user-www-miit-gov-cn')
  assert.equal(result.evidence[0].published_at, '2026-08-01')
  assert.equal(result.evidence[0].evidence_grade, 'C')
})

test('user source config accepts a public unauthenticated JSON API with deterministic field mappings', () => {
  const config = normalizeUserSourceConfig({
    search_backend: {},
    websites: [{
      label: '公开政策API', source_type: 'government_policy', connection_type: 'json_api',
      api: {
        endpoint: 'https://api.example.gov.cn/v1/search', query_parameter: 'keyword', static_parameters: { format: 'json' },
        mapping: { items_path: 'data.items', title_field: 'name', summary_field: 'content', published_at_field: 'publish_time', url_field: 'url' }
      }
    }]
  })
  assert.equal(config.websites[0].adapter, 'user_json_api')
  assert.equal(config.websites[0].api.authentication, 'none')
  assert.equal(config.websites[0].api.mapping.items_path, 'data.items')
  assert.equal(config.websites[0].id, 'user-api-api-example-gov-cn-v1-search')
  assert.throws(() => normalizeUserSourceConfig({ search_backend: {}, websites: [{ label: '内网API', source_type: 'government_policy', connection_type: 'json_api', api: { endpoint: 'http://127.0.0.1/api' } }] }), /HTTPS|public/i)
})

test('configured public JSON API maps records without changing business fields', async () => {
  let requestedUrl
  const source = normalizeUserSourceConfig({
    search_backend: {},
    websites: [{
      label: '公开政策API', source_type: 'government_policy', connection_type: 'json_api',
      api: {
        endpoint: 'https://api.example.gov.cn/v1/search', query_parameter: 'keyword', static_parameters: { format: 'json' },
        mapping: { items_path: 'data.items', title_field: 'name', summary_field: 'content', published_at_field: 'publish_time', url_field: 'url' }
      }
    }]
  }).websites[0]
  const adapter = new UserJsonApiAdapter({ source, httpClient: { json: async url => {
    requestedUrl = new URL(url)
    return { data: { items: [{ name: '产业政策', content: '公开政策正文与产业链影响说明', publish_time: '2026-08-01T08:00:00Z', url: 'https://api.example.gov.cn/policies/1' }] } }
  } } })
  const result = await adapter.collect({ query: '电子信息制造业', start_date: '2026-01-01', end_date: '2026-08-09', max_records: 2 })
  assert.equal(requestedUrl.searchParams.get('keyword'), '电子信息制造业')
  assert.equal(requestedUrl.searchParams.get('format'), 'json')
  assert.equal(result.evidence.length, 1)
  assert.equal(result.evidence[0].title, '产业政策')
  assert.equal(result.evidence[0].published_at, '2026-08-01')
  assert.equal(result.evidence[0].source_id, source.id)
})

test('industry plan routes matching evidence requirements to configured public websites', () => {
  const request = {
    contract_version: '1.0.0', request_id: 'custom-route', company: { id: '001', name: '企业' }, as_of_date: '2026-08-09',
    queries: [{ source_id: 'cninfo', query: '企业', start_date: '2026-01-01', end_date: '2026-08-09' }]
  }
  const output = applyIndustryPlanToCollectionRequest({
    request,
    company: request.company,
    industryPlan: { '证据需求': [{ requirement_id: 'r-custom', claim_scope: '行业政策', query_terms: ['产业政策'], preferred_source_types: ['government_policy'], required: true }] },
    configuredSources: [{ id: 'user-www-miit-gov-cn', source_type: 'government_policy', data_category: 'policy', enabled: true }]
  })
  assert(output.queries.some(query => query.source_id === 'user-www-miit-gov-cn' && query.query_origin === 'industry_plan_configured_website'))
})

test('run ledger rejects skipped production states', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'rulora-ledger-'))
  const ledger = new RunLedger(directory)
  await ledger.create({ runId: 'run-1', caseId: 'case-1', inputSha256: sha256('case-1') })
  await assert.rejects(() => ledger.transition('run-1', 'debating'), error => error.code === 'ILLEGAL_RUN_TRANSITION')
})

test('production case gate rejects impossible dates and self-declared source independence', () => {
  const sourceConfig = require('../config/public-sources.json')
  const items = ['e1', 'e2'].map((id, index) => ({
    id,
    source_id: 'cninfo',
    source_type: index ? 'government_policy' : 'company_disclosure',
    publisher: index ? '伪第二发布者' : '巨潮资讯网',
    source_url: `https://static.cninfo.com.cn/${id}.pdf`,
    title: id,
    summary: id,
    published_at: '2026-02-01',
    retrieved_at: '2026-02-01T01:00:00.000Z',
    evidence_grade: 'A',
    content_sha256: sha256(id),
    snapshot_ref: `${sha256(id)}.bin`,
    immutable_publication: true,
    public: true
  }))
  const errors = validateCase({
    contract_version: '1.0.0', case_id: 'bad-date', as_of_date: '2026-02-30', competition_cutoff: '2026-02-30',
    company: { id: '001', name: '企业' }, evidence: items
  }, { sourceConfig, productionMode: true })
  assert(errors.some(error => error.includes('real YYYY-MM-DD')))
  assert(errors.some(error => error.includes('independent registered sources')))
  assert(errors.some(error => error.includes('source_type does not match registry')))
})

test('critique cannot claim a clean review without the fixed production checklist', () => {
  const errors = validateCritique({
    reviewer_id: 'a', target_agent_id: 'b', challenges: [], evidence_refs: [], severity: 'low'
  }, new Set(['a', 'b']))
  assert(errors.some(error => error.includes('checks_performed')))
  assert(errors.some(error => error.includes('review_summary')))
})

test('public HTTP gate blocks private and reserved network targets', () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '172.20.1.1', '192.168.1.1', '169.254.1.1', '::1', 'fc00::1']) assert.equal(isPrivateAddress(address), true)
  assert.throws(() => validatePublicUrl('https://127.0.0.1/private'), /local\/private/)
  assert.throws(() => validatePublicUrl('https://evil.example/path', false, ['gov.cn']), /allowlist/)
})

test('file repository CAS prevents concurrent lost updates', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'rulora-cas-'))
  const repository = new FileRepository(directory)
  await repository.create({ id: 'record', value: 0 })
  const [left, right] = await Promise.all([repository.get('record'), repository.get('record')])
  const results = await Promise.allSettled([
    repository.save({ ...left, value: 1 }),
    repository.save({ ...right, value: 2 })
  ])
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
  assert.equal(results.filter(result => result.status === 'rejected' && result.reason.code === 'CAS_CONFLICT').length, 1)
})

test('durable model-call checkpoint executes an identical concurrent seat input only once', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'rulora-model-checkpoint-'))
  const firstStore = new ModelCallCheckpointStore({ rootDirectory: directory })
  let calls = 0
  const identity = {
    contract_version: '1.0.0', operation: 'decideStage', phase: 'decision_direction',
    agent: { agent_id: 'seat-1', version: 1, model_profile: 'factor' },
    case_id: 'case-1', frozen_case_sha256: sha256('case-1'), prompt_sha256: sha256('prompt-1'), execution_fingerprint: sha256('model-key-v1')
  }
  const execute = store => store.execute({
    identity,
    run: async () => {
      calls += 1
      await new Promise(resolve => setTimeout(resolve, 20))
      return { output: { value: 'risk_up' }, events: [{ stepId: 'model' }] }
    },
    validate: value => { if (value.value !== 'risk_up') throw new Error('invalid output') }
  })
  const [left, right] = await Promise.all([execute(firstStore), execute(firstStore)])
  assert.equal(calls, 1)
  assert.deepEqual(left.output, right.output)
  assert.deepEqual([left.checkpoint.status, right.checkpoint.status].sort(), ['completed', 'reused'])

  const restartedStore = new ModelCallCheckpointStore({ rootDirectory: directory })
  const resumed = await execute(restartedStore)
  assert.equal(resumed.checkpoint.status, 'reused')
  assert.equal(calls, 1)

  const changed = await restartedStore.execute({
    identity: { ...identity, prompt_sha256: sha256('prompt-2') },
    run: async () => ({ output: { value: 'risk_flat' }, events: [] }),
    validate: () => true
  })
  assert.equal(changed.checkpoint.status, 'completed')
})

test('public monitor checkpoint reuses the same frozen case across task-wrapper and runtime fingerprint changes', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'rulora-monitor-semantic-checkpoint-'))
  const baseIdentity = {
    contract_version: '1.0.0', operation: 'monitor', phase: 'information_collection_monitoring',
    agent: { agent_id: 'public_evidence_monitor', version: 1, method_family: 'monitoring', model_profile: 'monitor' },
    case_id: 'contest-013-2026-08-09', frozen_case_sha256: sha256('same-frozen-evidence'),
    monitoring_record_sha256: sha256('same-monitoring-record'), prompt_sha256: sha256('web-task-wrapper'),
    execution_fingerprint: sha256('runtime-before-adapter-change')
  }
  let calls = 0
  const first = new ModelCallCheckpointStore({ rootDirectory: directory })
  await first.execute({
    identity: baseIdentity,
    run: async () => { calls += 1; return { output: { monitoring_gaps: [], query_refinements: [] }, events: [] } },
    validate: () => true
  })
  const restarted = new ModelCallCheckpointStore({ rootDirectory: directory })
  const resumed = await restarted.execute({
    identity: { ...baseIdentity, prompt_sha256: sha256('cli-task-wrapper'), execution_fingerprint: sha256('runtime-after-adapter-change') },
    run: async () => { calls += 1; throw new Error('monitor must be reused') },
    validate: () => true
  })
  assert.equal(calls, 1)
  assert.equal(resumed.checkpoint.status, 'reused')
  assert.equal(resumed.checkpoint.checkpoint_reused_by_semantic_identity, true)
  assert.equal(restarted.caseSnapshot().completed_nodes[0].checkpoint_reused_by_semantic_identity, true)
})

test('failed or degraded model calls are never promoted into reusable completed checkpoints', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'rulora-model-checkpoint-failure-'))
  const store = new ModelCallCheckpointStore({ rootDirectory: directory })
  const identity = { contract_version: '1.0.0', operation: 'reviewStage', phase: 'decision_direction', agent: { agent_id: 'seat-1' }, case_id: 'case-1' }
  await assert.rejects(() => store.execute({ identity, run: async () => { throw new Error('model API request timed out') }, validate: () => true }), /timed out/)
  const degraded = await store.execute({
    identity,
    run: async () => ({ output: { value: 'fallback' }, events: [] }),
    validate: () => true,
    cacheable: () => false
  })
  assert.equal(degraded.checkpoint.status, 'skipped_degraded')
  const completedFiles = await fs.readdir(path.join(directory, 'completed')).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error))
  assert.equal(completedFiles.length, 0)
})

test('bounded decision graph uses a conditional exit and invokes self-review at most once', async () => {
  let reviews = 0
  const graph = buildBoundedDecisionStageGraph({
    evaluate_initial: async context => ({ ...context, route: context.same ? 'freeze_initial' : 'self_review' }),
    freeze_initial: async context => ({ ...context, result: 'initial' }),
    self_review: async context => { reviews += 1; return context },
    freeze_reviewed: async context => ({ ...context, result: 'reviewed' })
  })
  assert.equal((await graph.invoke({ context: { same: true } })).context.result, 'initial')
  assert.equal(reviews, 0)
  assert.equal((await graph.invoke({ context: { same: false } })).context.result, 'reviewed')
  assert.equal(reviews, 1)
})

test('provider supervisor emits a deterministic degraded output on primary failure', async () => {
  const fallback = { analyze: async () => ({ valid: true }) }
  const supervisor = new ProviderSupervisor({
    primary: { analyze: async () => { throw new Error('provider unavailable') } },
    fallback,
    config: { maximum_primary_model_calls: 2, maximum_elapsed_seconds: 60, maximum_total_prompt_characters: 1000 },
    validateOutput: (_operation, value) => { if (value.valid !== true) throw new Error('invalid') }
  })
  const result = await supervisor.analyze({ agent: { agent_id: 'a' }, prompt: [] })
  assert.equal(result.model_provenance.degraded, true)
  assert.equal(supervisor.diagnostics().degraded, true)
  assert.equal(supervisor.diagnostics().fallback_events.length, 1)
})

test('global provider scheduler limits aggregate and per-profile concurrency', async () => {
  const scheduler = new GlobalProviderScheduler({ maximumConcurrent: 2, maximumConcurrentPerProfile: 1 })
  let active = 0
  let peak = 0
  const byProfile = new Map()
  const peakByProfile = new Map()
  const task = profile => scheduler.schedule(profile, 'test', async () => {
    active += 1
    peak = Math.max(peak, active)
    byProfile.set(profile, (byProfile.get(profile) || 0) + 1)
    peakByProfile.set(profile, Math.max(peakByProfile.get(profile) || 0, byProfile.get(profile)))
    await new Promise(resolve => setTimeout(resolve, 5))
    active -= 1
    byProfile.set(profile, byProfile.get(profile) - 1)
  })
  await Promise.all([task('a'), task('a'), task('b'), task('c')])
  assert.equal(peak, 2)
  assert.equal(peakByProfile.get('a'), 1)
})

test('provider supervisor binds routing metadata instead of trusting model self-identification', async () => {
  const supervisor = new ProviderSupervisor({
    primary: {
      analyze: async () => ({ probabilities: { risk_up: 1, risk_flat: 0, risk_down: 0 }, recommended_advice: '4,8', uncertainties: '待验证', factors: [{ evidence_refs: 'e1', strength: '0.8', confidence: '0.7', horizon_days: '180' }], chain_map: { edges: [{ evidence_refs: 'e1', horizon_days: '90' }] } }),
      critique: async () => ({
        reviewer_id: '中文角色名', target_agent_id: 'wrong-target',
        checks_performed: { time_boundary: '已检查', citation_integrity: true },
        challenges: [], review_summary: '完成检查', evidence_refs: []
      }),
      conclude: async () => ({ agent_id: 'wrong', agent_version: 99, action: '1', risk_control_advice: ['9'] })
    },
    fallback: {},
    config: { maximum_primary_model_calls: 4, maximum_elapsed_seconds: 60, maximum_total_prompt_characters: 10000 },
    validateOutput: () => {}
  })
  const critique = await supervisor.critique({
    agent: { agent_id: 'reviewer' }, targetOpinion: { agent_id: 'target' }, prompt: []
  })
  assert.equal(critique.reviewer_id, 'reviewer')
  assert.equal(critique.target_agent_id, 'target')
  assert.deepEqual(critique.checks_performed, ['time_boundary', 'citation_integrity'])
  const opinion = await supervisor.analyze({ agent: { agent_id: 'analyst', version: 1, method_family: 'causal' }, prompt: [] })
  assert.deepEqual(opinion.recommended_advice, ['4', '8'])
  assert.deepEqual(opinion.uncertainties, ['待验证'])
  assert.deepEqual(opinion.factors[0].evidence_refs, ['e1'])
  assert.equal(opinion.factors[0].strength, 0.8)
  assert.equal(opinion.factors[0].horizon_days, 180)
  const conclusion = await supervisor.conclude({
    agent: { agent_id: 'decision', version: 2 },
    consensus: { action: '-1', risk_control_advice: ['2', '4'] }, prompt: []
  })
  assert.equal(conclusion.agent_id, 'decision')
  assert.equal(conclusion.agent_version, 2)
  assert.equal(conclusion.action, '-1')
  assert.deepEqual(conclusion.risk_control_advice, ['2', '4'])
  assert.equal(supervisor.diagnostics().degraded, false)
})

test('reasoning content is never substituted for a missing final answer', () => {
  assert.throws(() => extractContent('openai_compatible', {
    choices: [{ message: { content: '', reasoning_content: '{"ok":true}' } }]
  }), { code: 'MODEL_API_EMPTY_RESPONSE' })
})

test('model response parser accepts a provider stream even when a JSON completion was requested', async () => {
  const { extractResponseContent } = require('../src/providers/multi-model-provider')
  const stream = 'data: {"choices":[{"delta":{"content":"{\\"ok\\":"}}]}\n\ndata: {"choices":[{"delta":{"content":"true}"}}]}\n\ndata: [DONE]\n'
  assert.equal(await extractResponseContent('openai_compatible', new Response(stream, { headers: { 'content-type': 'text/event-stream' } })), '{"ok":true}')
})

test('model transport reconnects with bounded exponential retries and preserves failure classification', async () => {
  let calls = 0
  const delays = []
  const response = await requestWithRetry({
    fetchImpl: async () => {
      calls += 1
      return calls < 3 ? new Response('upstream unavailable', { status: 503 }) : new Response('{"ok":true}', { status: 200 })
    },
    url: 'https://relay.example/v1/chat/completions',
    init: { method: 'POST' },
    timeoutMs: 1000,
    maxRetries: 3,
    baseDelayMs: 10,
    maxDelayMs: 100,
    jitterRatio: 0,
    delayImpl: async milliseconds => { delays.push(milliseconds) }
  })
  assert.equal(response.status, 200)
  assert.equal(calls, 3)
  assert.deepEqual(delays, [10, 20])

  await assert.rejects(() => requestWithRetry({
    fetchImpl: async () => new Response('capacity', { status: 429 }),
    url: 'https://relay.example/v1/chat/completions',
    init: { method: 'POST' }, timeoutMs: 1000, maxRetries: 2,
    baseDelayMs: 1, maxDelayMs: 2, jitterRatio: 0, delayImpl: async () => {}
  }), error => {
    assert.equal(error.code, 'MODEL_API_CAPACITY_OR_RATE_LIMIT')
    assert.equal(error.connectivity_category, 'upstream_capacity')
    assert.equal(error.connection_attempts, 3)
    assert.equal(error.is_model_transport_failure, true)
    return true
  })
})

test('model deadline covers stalled response bodies and retries remain bounded', async () => {
  let calls = 0
  await assert.rejects(() => requestWithRetry({
    fetchImpl: async () => { calls++; return { ok: true, status: 200, text: () => new Promise(() => {}) } },
    url: 'https://relay.example', init: {}, timeoutMs: 15, maxRetries: 1, delayImpl: async () => {}
  }), e => e.code === 'MODEL_API_TIMEOUT' && e.connection_attempts === 2)
  assert.equal(calls, 2)
  const response = await requestWithRetry({
    fetchImpl: async () => new Response('data: [DONE]\n'), url: 'https://relay.example', init: {}, timeoutMs: 1000, maxRetries: 0
  })
  assert.equal(await response.text(), 'data: [DONE]\n')
})

test('competition transport retry uses two fixed reconnects while remaining one logical call', async () => {
  let transportCalls = 0
  const delays = []
  const response = await requestWithRetry({
    fetchImpl: async () => {
      transportCalls += 1
      return transportCalls < 3
        ? new Response('temporary upstream unavailable', { status: 502 })
        : new Response('{"ok":true}', { status: 200 })
    },
    url: 'https://relay.example/v1/chat/completions',
    init: { method: 'POST' }, timeoutMs: 1000, maxRetries: 2,
    retryDelaysMs: [2000, 5000], jitterRatio: 0,
    delayImpl: async milliseconds => { delays.push(milliseconds) }
  })
  assert.equal(response.transport_attempts, 3)
  assert.equal(transportCalls, 3)
  assert.deepEqual(delays, [2000, 5000])

  const supervisor = new ProviderSupervisor({
    primary: { analyze: async () => {
      const value = { ok: true }
      Object.defineProperty(value, 'model_provenance', { value: { transport_attempts: 3 } })
      return value
    } },
    fallback: {},
    config: { maximum_primary_model_calls: 1, maximum_elapsed_seconds: 60, maximum_total_prompt_characters: 1000, maximum_primary_protocol_retries: 0 },
    validateOutput: () => true,
    failClosed: true
  })
  await supervisor.analyze({ prompt: [] })
  assert.equal(supervisor.diagnostics().logical_model_calls, 1)
  assert.equal(supervisor.diagnostics().transport_attempts, 3)
  assert.equal(supervisor.diagnostics().transport_retries, 2)
})

test('exhausted transient upstream failure pauses a case while schema failure remains non-retriable', async () => {
  const transport = Object.assign(new Error('model API 502: temporary upstream unavailable'), {
    code: 'MODEL_API_UPSTREAM_FAILURE', http_status: 502, retryable: true,
    is_model_transport_failure: true, connection_attempts: 3
  })
  const wrappedTransport = Object.assign(new Error('competition provider fail-closed'), { cause: transport })
  assert.equal(classifyExecutionFailure(wrappedTransport), 'PAUSED_UPSTREAM')

  const schema = Object.assign(new Error('competition single-pass JSON gate rejected without repair'), { code: 'MODEL_SCHEMA_FAILURE' })
  const wrappedSchema = Object.assign(new Error('competition provider fail-closed'), { cause: schema })
  assert.equal(classifyExecutionFailure(wrappedSchema), 'SCHEMA_FAILURE')
})

test('case resume snapshot reuses completed nodes without duplicate successful calls', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'rulora-case-resume-'))
  const identity = agentId => ({
    contract_version: '1.0.0', operation: 'decideStage', phase: 'competition_joint_decision',
    agent: { agent_id: agentId, version: 1, model_profile: agentId },
    case_id: 'contest-010-2026-08-09', frozen_case_sha256: sha256('frozen'), prompt_sha256: sha256(agentId),
    decision_mode: 'competition_calibrated', execution_fingerprint: sha256('config')
  })
  let calls = 0
  const first = new ModelCallCheckpointStore({ rootDirectory: directory })
  for (const agentId of ['industry_chain_analyst', 'risk_factor_analyst']) {
    await first.execute({
      identity: identity(agentId),
      run: async () => { calls += 1; return { output: { action_candidate: 0, '风控建议': ['3'] }, events: [] } },
      validate: () => true
    })
  }
  const restarted = new ModelCallCheckpointStore({ rootDirectory: directory })
  for (const agentId of ['industry_chain_analyst', 'risk_factor_analyst']) {
    await restarted.execute({
      identity: identity(agentId),
      run: async () => { calls += 1; throw new Error('must not execute') },
      validate: () => true
    })
  }
  const snapshot = restarted.caseSnapshot()
  assert.equal(calls, 2)
  assert.equal(snapshot.completed_nodes.length, 2)
  assert(snapshot.completed_nodes.every(item => item.checkpoint_status === 'reused'))
  assert.deepEqual(Object.keys(snapshot.initial_results).sort(), ['industry_chain_analyst', 'risk_factor_analyst'])
})

test('provider health persists consecutive failures, deduplicates alerts, and notifies recovery', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rulora-provider-health-'))
  const notifications = []
  let current = new Date('2026-01-02T00:00:00.000Z')
  const monitor = new ProviderHealthMonitor({
    root,
    config: { consecutive_failed_attempts_alert_threshold: 3, repeat_alert_minutes: 30 },
    notifier: event => { notifications.push(event); return { attempted: true, delivered: true } },
    now: () => current,
    wait: async () => {}
  })
  const error = Object.assign(new Error('relay unavailable'), {
    code: 'MODEL_API_UPSTREAM_FAILURE', http_status: 503, retryable: true,
    connectivity_category: 'upstream_transport', connection_attempts: 4, is_model_transport_failure: true
  })
  const first = await monitor.recordFailure({ profileId: 'monitor_extractor', model: 'qwen3.7-plus', operation: 'monitor', error })
  assert.equal(first.alerted, true)
  assert.equal(first.state.consecutive_failed_attempts, 4)
  assert.equal(notifications.length, 1)
  current = new Date('2026-01-02T00:01:00.000Z')
  const repeated = await monitor.recordFailure({ profileId: 'monitor_extractor', model: 'qwen3.7-plus', operation: 'monitor', error })
  assert.equal(repeated.alerted, false)
  assert.equal(notifications.length, 1)
  current = new Date('2026-01-02T00:02:00.000Z')
  const recovered = await monitor.recordSuccess({ profileId: 'monitor_extractor', model: 'qwen3.7-plus', operation: 'monitor' })
  assert.equal(recovered.recovered, true)
  assert.equal(recovered.state.status, 'healthy')
  assert.equal(recovered.state.consecutive_failed_attempts, 0)
  assert.equal(notifications.length, 2)
  assert.equal(notifications[1].type, 'connection_recovered')
  const status = await monitor.status()
  assert.equal(status[0].alert_active, false)
  const alerts = (await fs.readFile(path.join(root, '.runtime', 'provider-health', 'alerts.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse)
  assert.deepEqual(alerts.map(item => item.type), ['connection_alert', 'connection_recovered'])
})

test('provider access misconfiguration alarms immediately without retrying', async () => {
  let calls = 0
  await assert.rejects(() => requestWithRetry({
    fetchImpl: async () => { calls += 1; return new Response('forbidden', { status: 403 }) },
    url: 'https://relay.example/v1/chat/completions', init: { method: 'POST' },
    timeoutMs: 1000, maxRetries: 3, delayImpl: async () => {}
  }), error => error.connectivity_category === 'access_configuration' && error.connection_attempts === 1)
  assert.equal(calls, 1)
})

test('family cap remains within the exact production ceiling after normalization', () => {
  const opinions = [
    { agent_id: 'a1', method_family: 'same' }, { agent_id: 'a2', method_family: 'same' },
    { agent_id: 'b', method_family: 'b' }, { agent_id: 'c', method_family: 'c' }
  ]
  const agents = new Map(opinions.map(opinion => [opinion.agent_id, { weight: opinion.agent_id.startsWith('a') ? 100 : 1 }]))
  const weights = cappedWeights(opinions, agents, 0.35)
  assert(Object.values(weights).reduce((sum, value) => sum + value, 0) > 0.999999999)
  assert(weights.a1 + weights.a2 <= 0.350000000001)
})

test('program judge maps risk direction to contest action', () => {
  const agents = [
    { agent_id: 'a', method_family: 'f1', weight: 1 },
    { agent_id: 'b', method_family: 'f2', weight: 1 },
    { agent_id: 'c', method_family: 'f3', weight: 1 }
  ]
  const opinions = agents.map((agent, index) => ({
    agent_id: agent.agent_id,
    method_family: agent.method_family,
    probabilities: index === 2 ? { risk_up: 0.6, risk_flat: 0.25, risk_down: 0.15 } : { risk_up: 0.7, risk_flat: 0.2, risk_down: 0.1 },
    recommended_advice: ['4', '8'],
    factors: [{ name: 'x', strength: 0.8, confidence: 0.8, evidence_refs: ['e1'] }],
    chain_map: { nodes: [], edges: [] },
    thesis: 'risk rises'
  }))
  const result = aggregateOpinions(opinions, agents, {
    maximum_family_weight_share: 0.35,
    contest_action_map: { risk_up: '-1', risk_flat: '0', risk_down: '1' },
    advice_vote_threshold: 0.32,
    maximum_advice_items: 3
  })
  assert.equal(result.risk_label, 'risk_up')
  assert.equal(result.action, '-1')
  assert.deepEqual(result.risk_control_advice, ['4', '8'])
})

test('active monitoring creates a fixed public-source watch policy without a vote', () => {
  const caseData = {
    case_id: 'watch-case',
    as_of_date: '2026-06-30',
    competition_cutoff: '2026-06-30',
    company: { id: 'c1', name: 'C1' },
    monitoring: { mode: 'active', watch_topics: ['关键材料'] },
    evidence: [
      { id: 'e1', public: true, published_at: '2026-06-01', source_type: 'company_disclosure' },
      { id: 'e2', public: true, published_at: '2026-06-02', source_type: 'government_statistics' }
    ]
  }
  const record = buildMonitoringRecord({
    caseData,
    monitoringConfig: { active: { default_schedule: '0 */6 * * *', alert_conditions: ['new_A_or_B_grade_evidence'] } },
    sourceConfig: { sources: [{ id: 'official', default_grade: 'A' }] },
    baselineChainOpinion: { chain_map: { nodes: [{ id: 'upstream:x' }, { id: 'company:c1' }] } },
    runId: 'run-1'
  })
  assert.equal(record.mode, 'active')
  assert.equal(record.participates_in_prediction, false)
  assert.deepEqual(record.eligible_evidence_ids, ['e1', 'e2'])
  assert.equal(record.watch_policy.schedule, '0 */6 * * *')
  assert.deepEqual(record.watch_policy.watch_topics, ['关键材料'])
})

test('evolution promotes only a same-role shadow challenger after repeated paired wins', () => {
  const state = {
    generation: 1,
    checkpoint: 0,
    evaluated_case_ids: [],
    active: [agent('factor_champion', 'event', { slotId: 'risk_factor_analyst' })],
    challengers: [agent('factor_challenger', 'event', { slotId: 'risk_factor_analyst', status: 'shadow' })],
    retired: [],
    evolution_log: [],
    case_evaluations: {}
  }
  const config = {
    contract_version: '1.0.0',
    evaluation_batch_size: 1,
    minimum_cases_before_challenger: 1,
    challenger_minimum_paired_cases: 1,
    minimum_evaluated_cases_before_promotion: 2,
    promotion_required_consecutive_checkpoints: 2,
    promotion_minimum_fitness_gain: 0.03,
    promotion_minimum_brier_skill_gain: 0.02,
    promotion_minimum_direction_gain: 0,
    challenger_retirement_checkpoints: 2,
    challenger_retirement_fitness_gap: -0.03,
    maximum_active_challengers: 1,
    challenger_initial_weight: 0.45,
    promoted_champion_weight: 1,
    active_minimum_weight: 0.2,
    active_maximum_weight: 2,
    metric_weights: { brier_skill: 0.5, direction_accuracy: 0.3, advice_f1: 0.2 },
    role_mutation_pool: { risk_factor_analyst: ['mutation-a'] }
  }
  const firstRun = pairedLabeledRun('case-a')
  const first = recordLabeledRun(state, firstRun, truthFor(firstRun), config)
  assert.equal(first.evolution.action, 'retain_champions')
  assert.equal(first.state.retired.length, 0)
  const secondRun = pairedLabeledRun('case-b')
  const second = recordLabeledRun(first.state, secondRun, truthFor(secondRun), config)
  assert.equal(second.evolution.action, 'promote_challenger')
  assert.equal(second.state.retired[0].agent_id, 'factor_champion')
  assert.equal(second.state.active.find(item => item.slot_id === 'risk_factor_analyst').agent_id, 'factor_challenger')
  assert.equal(second.state.challengers.length, 0)
  rollbackGeneration(second.state, 1)
  assert.equal(second.state.generation, 1)
  assert.equal(second.state.active.find(item => item.slot_id === 'risk_factor_analyst').agent_id, 'factor_champion')
})

test('automation limit forces a production conclusion without human handoff', () => {
  const rounds = Array.from({ length: 6 }, (_, index) => ({
    summary: {
      clean: false,
      unanswered_challenge_ids: [],
      unresolved_important_ids: [`r${index + 1}:high`],
      unresolved_high_severity_ids: [`r${index + 1}:high`],
      result_consensus: false,
      suppressed_duplicate_challenge_count: 0
    }
  }))
  const termination = buildDebateTermination({ rounds, config: legacyDebateConfig, cleanStreak: 0, limitReason: 'automated_round_limit_reached' })
  assert.equal(termination.status, 'forced_conclusion_exit')
  assert.equal(termination.production_eligible, true)
  assert.equal(termination.clean_gate_satisfied, false)
  assert.equal(termination.forced_conclusion, true)
  assert.equal(termination.reason, 'automated_round_limit_reached')
  assert.equal(termination.rounds_completed, 6)
  assert.equal(termination.requires_human_review, false)
})

test('forced conclusion applies an exact categorical conservative result policy', () => {
  const termination = {
    forced_conclusion: true,
    unresolved_high_severity_ids: ['high-1'],
    unresolved_important_ids: ['high-1'],
    unanswered_challenge_ids: []
  }
  const opinions = [
    { probabilities: { risk_up: 0.2, risk_flat: 0.2, risk_down: 0.6 } },
    { probabilities: { risk_up: 0.3, risk_flat: 0.2, risk_down: 0.5 } }
  ]
  const base = {
    probabilities: { risk_up: 0.25, risk_flat: 0.2, risk_down: 0.55 },
    risk_label: 'risk_down',
    action: '1',
    risk_control_advice: ['1']
  }
  const result = applyDebateConclusionPolicy(base, opinions, termination, require('../config/decision.json'), debateConfig)
  assert.equal(result.decision_mode, 'forced_conservative')
  assert.equal(result.conclusion_grade, 'restricted')
  assert.deepEqual(result.probabilities, { risk_up: 1, risk_flat: 0, risk_down: 0 })
  assert.equal(result.risk_label, 'risk_up')
  assert.equal(result.action, '-1')
  assert.equal(result.risk_control_advice[0], '4')
  assert.equal(Object.values(result.probabilities).reduce((sum, value) => sum + value, 0), 1)
})

test('forced conclusion without high disputes cannot output a risk-easing action', () => {
  const termination = {
    forced_conclusion: true,
    unresolved_high_severity_ids: [],
    unresolved_important_ids: ['medium-1'],
    unanswered_challenge_ids: []
  }
  const opinions = [
    { probabilities: { risk_up: 0.1, risk_flat: 0.2, risk_down: 0.7 } },
    { probabilities: { risk_up: 0.2, risk_flat: 0.2, risk_down: 0.6 } }
  ]
  const base = {
    probabilities: { risk_up: 0.15, risk_flat: 0.2, risk_down: 0.65 },
    risk_label: 'risk_down',
    action: '1',
    risk_control_advice: ['1']
  }
  const result = applyDebateConclusionPolicy(base, opinions, termination, require('../config/decision.json'), debateConfig)
  assert.equal(result.decision_mode, 'forced_conservative')
  assert.equal(result.conclusion_grade, 'cautious')
  assert.equal(result.risk_label, 'risk_flat')
  assert.equal(result.action, '0')
  assert.equal(result.risk_control_advice[0], '3')
})

test('challenge severity is computed from the fixed category and impact matrix', () => {
  const policy = legacyDebateConfig.severity_policy
  assert.equal(classifyChallenge('cutoff_violation', 'no_decision_impact', policy), 'high')
  assert.equal(classifyChallenge('factor_double_counting', 'changes_result', policy), 'medium')
  assert.equal(classifyChallenge('alternative_explanation', 'no_decision_impact', policy), 'medium')
  assert.equal(classifyChallenge('causal_direction_error', 'changes_risk_label', policy), 'high')
  assert.equal(classifyChallenge('wording_clarity', 'no_decision_impact', policy), 'low')
  assert.throws(() => classifyChallenge('wording_clarity', 'changes_risk_label', policy), /must use no_decision_impact/)
  const normalized = normalizeCritique({
    reviewer_id: 'a',
    target_agent_id: 'b',
    severity: 'low',
    evidence_refs: [],
    challenges: [{
      category: 'cutoff_violation',
      impact: 'no_decision_impact',
      target_result: 'risk_up',
      evidence_refs: [],
      claim: '使用了截止日后信息',
      logic_gap: '截止日后信息不能支持目标结果',
      requested_test: '核验发布时间'
    }]
  }, 1, legacyDebateConfig)
  assert.equal(normalized.severity, 'high')
  assert.equal(normalized.challenges[0].program_severity, 'high')
})

test('debate rejects probability disputes and suppresses repeated result-evidence-logic issues', () => {
  const probabilityErrors = validateRawCritique({
    reviewer_id: 'a', target_agent_id: 'b',
    checks_performed: ['time_boundary', 'citation_integrity', 'source_independence', 'causal_direction', 'substitution_and_qualification', 'factor_double_counting', 'outcome_support'],
    review_summary: '完成审查', evidence_refs: [],
    challenges: [{
      target_result: 'risk_up', category: 'result_logic_gap', impact: 'changes_result', evidence_refs: [],
      claim: '风险上升概率应从51%改为48%', logic_gap: '百分比没有校准', requested_test: '重新校准概率'
    }]
  }, 'a', 'b')
  assert.equal(probabilityErrors.includes('probability percentage is outside the debate contract'), true)
  const financialPercentageErrors = validateRawCritique({
    reviewer_id: 'a', target_agent_id: 'b',
    checks_performed: ['time_boundary', 'citation_integrity', 'source_independence', 'causal_direction', 'substitution_and_qualification', 'factor_double_counting', 'outcome_support'],
    review_summary: '完成审查', evidence_refs: [],
    challenges: [{ target_result: 'risk_up', category: 'result_evidence_gap', impact: 'changes_result', evidence_refs: [], claim: '净利润下降78%', logic_gap: '尚未证明现金流下降', requested_test: '核验经营现金流' }]
  }, 'a', 'b')
  assert.equal(financialPercentageErrors.includes('probability percentage is outside the debate contract'), false)

  const seen = new Set()
  const raw = {
    reviewer_id: 'a', target_agent_id: 'b', evidence_refs: [],
    challenges: [{
      target_result: 'risk_up', category: 'result_evidence_gap', impact: 'changes_result', evidence_refs: ['e1'],
      claim: '缺少现金流证据', logic_gap: '利润下降不能直接证明偿债风险上升', requested_test: '核验经营现金流和债务期限'
    }]
  }
  const first = normalizeCritique(structuredClone(raw), 1, legacyDebateConfig, seen)
  const repeated = normalizeCritique(structuredClone(raw), 2, legacyDebateConfig, seen)
  assert.equal(first.challenges.length, 1)
  assert.equal(repeated.challenges.length, 0)
  assert.equal(repeated.suppressed_duplicate_count, 1)
})

test('decision consensus compares only decision action and normalized advice codes', () => {
  const left = decisionSignature({ result_candidate: 'risk_flat', recommended_advice: ['4', '2', '2'] })
  const right = decisionSignature({ result_candidate: 'risk_flat', recommended_advice: ['2', '4'] })
  const differentAdvice = decisionSignature({ result_candidate: 'risk_flat', recommended_advice: ['2'] })
  const differentAction = decisionSignature({ result_candidate: 'risk_up', recommended_advice: ['2', '4'] })
  assert.equal(left, right)
  assert.notEqual(left, differentAdvice)
  assert.notEqual(left, differentAction)
})

test('broadcast context accepts only executor plus the three phase modules', async () => {
  const schemas = await loadSchemaValidators(path.resolve(__dirname, '..'))
  const logic = [{ claim: '现金流压力', mechanism: '成本经现金流传导。', evidence_refs: ['e1'] }]
  const direction = { '执行员': 'seat-a', '经营调整方向': 'risk_flat', '逻辑': logic, '证据': ['e1'] }
  const advice = { '执行员': 'seat-a', '风控建议': ['3', '8'], '逻辑': logic, '证据': ['e1'] }
  assert.equal(schemas.debateBroadcast(direction), true)
  assert.equal(schemas.debateBroadcast(advice), true)
  assert.equal(schemas.debateBroadcast({ ...direction, raw_model_output: 'forbidden' }), false)
})

test('monitoring and improvement supervisor roles never enter automatic evolution scoring', () => {
  const debater = agent('industry_chain_analyst', 'causal')
  const monitor = agent('public_evidence_monitor', 'monitor', { evolutionEligible: false })
  monitor.participates_in_prediction = false
  monitor.participates_in_debate = false
  const improvement = agent('improvement_supervisor', 'aggregate_feedback', { evolutionEligible: false })
  improvement.participates_in_prediction = false
  improvement.participates_in_debate = false
  const state = {
    generation: 1,
    checkpoint: 0,
    evaluated_case_ids: [],
    active: [debater, monitor, improvement],
    challengers: [],
    retired: [],
    evolution_log: [],
    case_evaluations: {}
  }
  const run = {
    case_id: 'objective-only-case',
    run_id: 'objective-only-run',
    as_of_date: '2026-01-01',
    revised_opinions: [{
      agent_id: debater.agent_id,
      probabilities: { risk_up: 0.8, risk_flat: 0.15, risk_down: 0.05 },
      recommended_advice: ['4']
    }],
    consensus: { probabilities: { risk_up: 0.8, risk_flat: 0.15, risk_down: 0.05 }, risk_control_advice: ['4'], decision_mode: 'clean_consensus' },
    debate_record: { termination: { clean_gate_satisfied: true } },
    report: { qa: { fixture_provider: false, schema_valid: true, probabilities_valid: true, cutoff_verified: true, source_registry_verified: true, evidence_snapshots_verified: true, evidence_refs_valid: true, evidence_coverage_sufficient: true, degraded: false, production_ready: true } }
  }
  const truth = truthFor(run)
  const result = recordLabeledRun(state, run, truth, require('../config/evolution.json'))
  assert.deepEqual(Object.keys(result.evaluation.agents), ['industry_chain_analyst'])
  assert.equal(monitor.metrics.cases, 0)
  assert.equal(improvement.metrics.cases, 0)
})

test('improvement feedback can score only the three debate seats', () => {
  const config = require('../config/evolution.json')
  const state = {
    active: [
      agent('chain', 'chain', { slotId: 'industry_chain_analyst' }),
      agent('factor', 'factor', { slotId: 'risk_factor_analyst' }),
      agent('red', 'red', { slotId: 'adversarial_reviewer' }),
      { ...agent('monitor', 'monitor', { slotId: 'public_evidence_monitor', evolutionEligible: false }), participates_in_prediction: false, participates_in_debate: false }
    ]
  }
  const feedback = {
    contract_version: '1.0.0', feedback_id: 'fb-1', case_id: 'case-1',
    seat_ratings: [{ slot_id: 'risk_factor_analyst', rating: -1 }]
  }
  const result = recordUserFeedback(state, feedback, config)
  assert.equal(result.duplicate, false)
  assert.equal(state.active[1].metrics.user_feedback_count, 1)
  assert.throws(() => recordUserFeedback(state, {
    contract_version: '1.0.0', feedback_id: 'fb-2', case_id: 'case-1',
    seat_ratings: [{ slot_id: 'public_evidence_monitor', rating: 1 }]
  }, config), /non-debate role/)
})

test('improvement supervisor model selects and applies only an approved factor', async () => {
  const config = require('../config/evolution.json')
  const target = 'risk_factor_analyst'
  const challengerId = 'risk_factor_analyst_v2_challenger_test'
  const state = {
    active: [
      { ...agent('industry_chain_analyst', 'causal'), slot_id: 'industry_chain_analyst' },
      { ...agent(target, 'factor'), slot_id: target },
      { ...agent('adversarial_reviewer', 'red'), slot_id: 'adversarial_reviewer' }
    ],
    challengers: [{ ...agent(challengerId, 'factor', { slotId: target, status: 'shadow' }), agent_id: challengerId, slot_id: target, mutation: 'old' }],
    evaluated_case_ids: Array.from({ length: 20 }, (_, index) => `case-${index + 1}`),
    user_feedback: []
  }
  const event = { checkpoint: 1, evaluated_cases: 20, spawned: { slot_id: target, challenger_agent_id: challengerId, mutation: 'old' } }
  const execution = await executeImprovementSupervisor({ state, evolutionEvent: event, config, allowFixture: true })
  const applied = applyImprovementProposal(state, event, execution.proposal, config, { provider_mode: execution.provider_mode, degraded: execution.diagnostics.degraded })
  assert(config.role_mutation_pool[target].includes(applied.mutation))
  assert.equal(event.improvement_supervisor.executed, true)
  assert.equal(applied.mutation_source, 'improvement_supervisor_model_with_program_gate')
})

test('approved challenger mutation is injected into both stage prompts and degraded proposals cannot apply', () => {
  const challenger = {
    agent_id: 'risk_factor_analyst_v2_challenger', version: 2, label: '风险因子挑战者',
    method_family: 'bayesian_factor_event_decay', status: 'shadow', mutation: '缩短事件证据半衰期',
    mission: '只依据冻结证据判断。', required_lenses: ['事件时衰']
  }
  const stage = stageDecisionPrompt({ agent: challenger, phase: 'decision_direction', caseData: { contract_version: '1.0.0', case_id: 'c', as_of_date: '2026-08-09', company: { id: '001', name: '企业' }, evidence: [] }, industryPlan: {}, frozenDirection: null })
  const review = selfImpactReviewPrompt({ agent: challenger, phase: 'decision_direction', ownDecision: {}, peerDecisions: [], differencePacket: {}, evidenceIndex: [], frozenDirection: null })
  assert.equal(JSON.parse(stage[1].content).agent_protocol.approved_mutation, challenger.mutation)
  assert.equal(JSON.parse(review[1].content).agent_protocol.approved_mutation, challenger.mutation)
  const config = require('../config/evolution.json')
  const state = { challengers: [{ agent_id: 'challenger', slot_id: 'risk_factor_analyst' }] }
  const event = { spawned: { slot_id: 'risk_factor_analyst', challenger_agent_id: 'challenger' } }
  const proposal = { '执行员': 'improvement_supervisor', '目标席位': 'risk_factor_analyst', '选择因子': config.role_mutation_pool.risk_factor_analyst[0] }
  assert.throws(() => applyImprovementProposal(state, event, proposal, config, { degraded: true }), /degraded improvement proposal/)
})

test('fixture run completes both Rulora freezes and emits stable artifacts', async () => {
  const output = await fs.mkdtemp(path.join(os.tmpdir(), 'rulora-risk-agents-'))
  const run = await runCase({
    inputPath: path.resolve(__dirname, 'fixtures', 'control-case.json'),
    outputDirectory: output,
    allowFixture: true
  })
  assert.equal(run.rulora.frozen_analysis.scenarioId, 'monitor-three-seat-debate-improvement-v7')
  assert.equal(run.rulora.frozen_delivery.scenarioId, 'decision-risk-delivery-v1')
  assert.equal(run.consensus.action, '-1')
  assert.equal(run.monitoring_record.mode, 'passive')
  assert.equal(run.monitoring_record.public_information_only, true)
  assert.equal(run.active_agents.find(agent => agent.agent_id === 'public_evidence_monitor').participates_in_prediction, false)
  assert.equal(run.opinions.length, 3)
  assert.equal(run.debate_record.termination.rounds_completed, 2)
  assert.equal(run.debate_record.termination.production_eligible, true)
  assert.equal(run.debate_record.termination.reason, 'two_stage_unanimous')
  assert.equal(run.debate_record.termination.forced_conclusion, false)
  assert.equal(run.debate_record.same_seats_in_both_stages, true)
  assert.deepEqual(run.debate_record.phases.decision_direction.participant_agent_ids, run.debate_record.phases.risk_control_advice.participant_agent_ids)
  assert.equal(run.consensus.decision_mode, 'two_stage_unanimous')
  assert.equal(run.active_agents.find(agent => agent.agent_id === 'improvement_supervisor').participates_in_debate, false)
  assert.equal(run.active_agents.find(agent => agent.agent_id === 'improvement_supervisor').evolution_eligible, false)
  assert.equal(run.decision_strategy.agent_id, 'program_consensus_renderer')
  assert.deepEqual(run.cluster_events.map(event => event.stage), [
    'public_evidence_planning_and_intake',
    'information_collection_monitoring',
    'group_debate',
    'conclusion_output'
  ])
  assert.equal(run.rulora.frozen_analysis.fields.industry_plan['执行员'], 'industry_research_planner')
  assert(run.debate_record.participant_agent_ids.includes('industry_chain_analyst'))
  const planningAgent = run.active_agents.find(agent => agent.agent_id === 'industry_research_planner')
  const monitorAgent = run.active_agents.find(agent => agent.agent_id === 'public_evidence_monitor')
  const debateChainAgent = run.active_agents.find(agent => agent.agent_id === 'industry_chain_analyst')
  assert.notEqual(planningAgent.agent_id, debateChainAgent.agent_id)
  assert.equal(planningAgent.stage, 'industry_chain_planning')
  assert.equal(planningAgent.participates_in_prediction, false)
  assert.equal(planningAgent.participates_in_debate, false)
  assert.equal(monitorAgent.stage, 'information_collection_monitoring')
  assert.equal(monitorAgent.participates_in_prediction, false)
  assert.equal(monitorAgent.participates_in_debate, false)
  assert.equal(debateChainAgent.stage, 'group_debate')
  assert.equal(debateChainAgent.participates_in_prediction, true)
  assert.equal(debateChainAgent.participates_in_debate, true)
  assert.equal(run.report.qa.fixture_provider, true)
  const submission = await fs.readFile(run.artifacts.submission_csv, 'utf8')
  assert.equal(submission.split('\n')[0], 'company_id,action,risk_control_advice')
  for (const artifact of Object.values(run.artifacts)) await fs.access(artifact)
  const manifest = JSON.parse(await fs.readFile(run.artifacts.manifest_json, 'utf8'))
  const reportBytes = await fs.readFile(run.artifacts.report_json)
  assert.equal(manifest.status, 'committed')
  assert.equal(manifest.files.report_json.sha256, sha256(reportBytes))
  assert.throws(
    () => recordLabeledRun({ evaluated_case_ids: [] }, run, { risk_label: 'risk_up', risk_control_advice: ['4'], source: 'demo', revealed_at: '2026-08-01' }, {}),
    /fixture or missing-QA/
  )
})

test('identical independent decision answers exit before unnecessary challenges', async () => {
  const output = await fs.mkdtemp(path.join(os.tmpdir(), 'rulora-forced-conclusion-'))
  const run = await runCase({
    inputPath: path.resolve(__dirname, 'fixtures', 'control-case.json'),
    outputDirectory: output,
    allowBaseline: true
  })
  const artifacts = await fs.readdir(output)
  assert.equal(artifacts.length, 5)
  assert.equal(artifacts.some(item => item.endsWith('.handoff.json')), false)
  assert.equal(run.debate_record.termination.status, 'clean_exit')
  assert.equal(run.debate_record.termination.production_eligible, true)
  assert.equal(run.debate_record.termination.rounds_completed, 2)
  assert.equal(run.debate_record.rounds[0].stage, 'independent_answer_alignment')
  assert.equal(Object.hasOwn(run, 'critiques'), false)
  assert.equal(run.consensus.decision_mode, 'two_stage_unanimous')
  assert.equal(run.report.debate_summary.unresolved_high_conflicts, 0)
})

test('production artifacts require verified snapshots and a committed manifest before submission', async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'rulora-production-contract-'))
  const snapshotRoot = path.join(temporary, 'snapshots')
  const output = path.join(temporary, 'output')
  await fs.mkdir(snapshotRoot, { recursive: true })
  const evidenceItems = [
    {
      id: 'cninfo:test', source_id: 'cninfo', source_type: 'company_disclosure', publisher: '巨潮资讯网',
      source_url: 'https://static.cninfo.com.cn/finalpage/test.pdf', title: '公司公告', summary: '已发布公司公告',
      published_at: '2026-08-09', retrieved_at: '2026-08-10T00:01:00.000Z', evidence_grade: 'A', public: true,
      immutable_publication: true, publication_time_basis: 'official_announcement_publication_date', immutable_proof_url: 'https://static.cninfo.com.cn/finalpage/test.pdf', data_category: 'enterprise_disclosure', content: 'official-company-document'
    },
    {
      id: 'gov-policy:test', source_id: 'government_policy', source_type: 'government_policy', publisher: '中国政府网',
      source_url: 'https://www.gov.cn/zhengce/test.htm', title: '产业政策', summary: '已发布产业政策',
      published_at: '2026-08-09', retrieved_at: '2026-08-10T00:01:00.000Z', evidence_grade: 'A', public: true,
      immutable_publication: true, publication_time_basis: 'official_policy_publication_date', immutable_proof_url: 'https://www.gov.cn/zhengce/test.htm', data_category: 'policy', content: 'official-policy-document'
    }
  ]
  for (const item of evidenceItems) {
    const content = Buffer.from(item.content)
    item.ingestion_mode = 'validated_manual_import'
    item.content_sha256 = sha256(content)
    item.snapshot_ref = `${item.content_sha256}.bin`
    delete item.content
    await fs.writeFile(path.join(snapshotRoot, item.snapshot_ref), content)
  }
  const casePath = path.join(temporary, 'case.json')
  await fs.writeFile(casePath, JSON.stringify({
    contract_version: '1.0.0', case_id: 'production-contract-test', as_of_date: '2026-08-09', competition_cutoff: '2026-08-09',
    decision_horizon_days: 180, company: { id: '001', name: '公开测试企业', industry: '制造业' },
    evidence_snapshot_root: snapshotRoot, evidence: evidenceItems, monitoring: { mode: 'passive' }
  }))
  const providerPath = path.join(temporary, 'provider.cjs')
  await fs.writeFile(providerPath, `const { FixtureProvider } = require(${JSON.stringify(path.resolve(__dirname, '..', 'src', 'providers', 'fixture-provider.js'))}); const provider = new FixtureProvider(); provider.productionReady = true; provider.mode = 'test-only-structured-provider'; module.exports = provider;`)
  const previousModule = process.env.AGENT_PROVIDER_MODULE
  const previousConfig = process.env.AGENT_MODEL_CONFIG
  delete process.env.AGENT_MODEL_CONFIG
  process.env.AGENT_PROVIDER_MODULE = providerPath
  try {
    const run = await runCase({ inputPath: casePath, outputDirectory: output, allowArchivedLegacy: true })
    assert.equal(run.report.qa.production_ready, true)
    const submissionPath = path.join(temporary, 'submission.csv')
    const result = await buildSubmission({ reportPaths: [run.artifacts.report_json], outputPath: submissionPath, expectedCompanyIds: ['001'] })
    assert.equal(result.row_count, 1)
    const report = JSON.parse(await fs.readFile(run.artifacts.report_json, 'utf8'))
    report.submission_row.action = '1'
    await fs.writeFile(run.artifacts.report_json, JSON.stringify(report))
    await assert.rejects(() => buildSubmission({ reportPaths: [run.artifacts.report_json], outputPath: submissionPath }), /hash mismatch/)
  } finally {
    if (previousModule === undefined) delete process.env.AGENT_PROVIDER_MODULE
    else process.env.AGENT_PROVIDER_MODULE = previousModule
    if (previousConfig === undefined) delete process.env.AGENT_MODEL_CONFIG
    else process.env.AGENT_MODEL_CONFIG = previousConfig
  }
})

test('submission contract is exactly three text columns and rejects invalid rows', () => {
  const row = validateSubmissionRow({ company_id: 2, action: -1, risk_control_advice: '2,4,8' })
  assert.deepEqual(row, { company_id: '002', action: '-1', risk_control_advice: '2,4,8' })
  assert.equal(renderSubmissionCsv(row), 'company_id,action,risk_control_advice\n002,-1,"2,4,8"\n')
  assert.equal(renderRows([row]), 'company_id,action,risk_control_advice\n002,-1,"2,4,8"\n')
  assert.throws(() => validateSubmissionRow({ company_id: '002', action: '2', risk_control_advice: '4' }), /invalid action/)
})

test('active watch registration rejects non-production baselines', async () => {
  const service = new PublicMonitorService({ runtimeDirectory: path.join(os.tmpdir(), 'unused-monitor') })
  await assert.rejects(() => service.registerFromRun({
    monitoring_record: { mode: 'active', watch_policy: { query_templates: [{}] } },
    report: { qa: { fixture_provider: false, production_ready: false } }
  }), /only production-ready/)
})

test('multi-model provider routes each production operation to its own API profile', async () => {
  const requests = []
  const direction = { '执行员': 'industry_chain_analyst', '经营调整方向': 'risk_up', '逻辑': [{ claim: '承压', mechanism: '现金流压力', evidence_refs: ['e1'] }], '证据': ['e1'] }
  const advice = { '执行员': 'risk_factor_analyst', '风控建议': ['4'], '逻辑': [{ claim: '收紧', mechanism: '冻结方向为风险上升', evidence_refs: ['e1'] }], '证据': ['e1'] }
  const provider = new MultiModelProvider({
    config: {
      contract_version: '1.0.0',
      profiles: {
        chain: {
          provider: 'openai_compatible', base_url: 'https://chain.example/v1', api_key_env: 'CHAIN_KEY',
          model: 'chain-model', json_mode: true, max_retries: 0
        },
        factor: {
          provider: 'anthropic', base_url: 'https://factor.example/v1', api_key_env: 'FACTOR_KEY',
          model: 'factor-model', max_retries: 0
        },
        monitor: {
          provider: 'openai_compatible', base_url: 'https://monitor.example/v1', api_key_env: 'MONITOR_KEY',
          model: 'monitor-model', json_mode: true, max_retries: 0
        }
      }
    },
    environment: { CHAIN_KEY: 'chain-secret', FACTOR_KEY: 'factor-secret', MONITOR_KEY: 'monitor-secret' },
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body) })
      if (String(url).includes('chain.example')) return jsonResponse({ choices: [{ message: { content: JSON.stringify(direction) } }] })
      if (String(url).includes('monitor.example')) return jsonResponse({ choices: [{ message: { content: JSON.stringify({
        agent_id: 'public_evidence_monitor', relevant_evidence_ids: ['e1'], topic_signals: [{
          topic: '公告', direction: 'neutral', evidence_refs: ['e1'], summary: '公开公告相关'
        }], monitoring_gaps: [], query_refinements: [], abstain: false
      }) } }] })
      return jsonResponse({ content: [{ type: 'text', text: JSON.stringify(advice) }] })
    }
  })
  const decided = await provider.decideStage({
    agent: { agent_id: 'industry_chain_analyst', model_profile: 'chain' },
    phase: 'decision_direction',
    prompt: [{ role: 'user', content: 'direction' }]
  })
  const reviewed = await provider.reviewStage({
    agent: { agent_id: 'risk_factor_analyst', model_profile: 'factor' },
    phase: 'risk_control_advice',
    prompt: [{ role: 'user', content: 'advice' }]
  })
  const monitored = await provider.monitor({
    agent: { agent_id: 'public_evidence_monitor', model_profile: 'monitor' },
    prompt: [{ role: 'user', content: 'monitor' }]
  })
  assert.equal(decided.model_provenance.profile_id, 'chain')
  assert.equal(reviewed.model_provenance.profile_id, 'factor')
  assert.equal(monitored.model_provenance.profile_id, 'monitor')
  assert.equal(requests[0].url, 'https://chain.example/v1/chat/completions')
  assert.equal(requests[0].headers.authorization, 'Bearer chain-secret')
  assert.equal(requests[0].headers['user-agent'], 'RuloraRiskAgents/0.1 OpenAI-Compatible')
  assert.equal(requests[1].url, 'https://factor.example/v1/messages')
  assert.equal(requests[1].headers['x-api-key'], 'factor-secret')
  assert.equal(requests[0].body.model, 'chain-model')
  assert.equal(Object.hasOwn(requests[0].body, 'temperature'), false)
  assert.equal(requests[1].body.model, 'factor-model')
  assert.equal(requests[2].url, 'https://monitor.example/v1/chat/completions')
  assert.equal(requests[2].headers.authorization, 'Bearer monitor-secret')
  assert.equal(requests[2].body.model, 'monitor-model')
})

test('stage output instruction exposes exactly one phase contract and excludes the legacy opinion protocol', async () => {
  const requests = []
  const response = { '执行员': 'industry_chain_analyst', '经营调整方向': 'risk_flat', '逻辑': [{ claim: '维持', mechanism: '公开证据中性', evidence_refs: ['e1'] }], '证据': ['e1'] }
  const provider = new MultiModelProvider({
    config: { contract_version: '1.0.0', profiles: { chain: { provider: 'openai_compatible', base_url: 'https://chain.example/v1', api_key: 'secret', model: 'chain-model', max_retries: 0 } } },
    fetchImpl: async (url, init) => {
      requests.push(JSON.parse(init.body))
      return jsonResponse({ choices: [{ message: { content: JSON.stringify(response) } }] })
    }
  })
  await provider.decideStage({
    agent: { agent_id: 'industry_chain_analyst', model_profile: 'chain' },
    phase: 'decision_direction',
    prompt: [{ role: 'system', content: 'current phase only' }, { role: 'user', content: '{}' }]
  })
  const system = requests[0].messages.find(message => message.role === 'system').content
  assert.match(system, /当前且仅执行经营调整方向阶段/)
  assert.doesNotMatch(system, /风控建议阶段必须/)
  assert.doesNotMatch(system, /probabilities=|factors 至少|recommended_advice 只能/)
  assert.match(system, /排序去重并集确定性覆盖/)
})

test('stage evidence summary is deterministically derived while semantic evidence binding remains model-owned', async () => {
  const requests = []
  const provider = new MultiModelProvider({
    config: {
      contract_version: '1.0.0',
      profiles: { chain: { provider: 'openai_compatible', base_url: 'https://chain.example/v1', api_key: 'secret', model: 'chain-model', max_retries: 0 } }
    },
    fetchImpl: async (url, init) => {
      requests.push(JSON.parse(init.body))
      return jsonResponse({ choices: [{ message: { content: JSON.stringify({
        '执行员': 'industry_chain_analyst',
        '经营调整方向': 'risk_up',
        '逻辑': [
          { claim: '需求承压', mechanism: '收入及现金流承压', evidence_refs: ['e2', 'e1'] },
          { claim: '融资约束', mechanism: '债务成本上升', evidence_refs: ['e2'] }
        ],
        '证据': ['e1']
      }) } }] })
    }
  })
  const primary = await provider.decideStage({
    agent: { agent_id: 'industry_chain_analyst', model_profile: 'chain' },
    phase: 'decision_direction',
    prompt: [{ role: 'user', content: '{}' }]
  })
  assert.deepEqual(primary['证据'], ['e1', 'e2'])
  assert.equal(primary.stage_evidence_derivation.changed, true)
  assert.equal(requests.length, 1)

  const supervisor = new ProviderSupervisor({
    primary: { decideStage: async () => primary },
    fallback: {},
    config: { maximum_primary_model_calls: 2, maximum_elapsed_seconds: 60, maximum_total_prompt_characters: 10000 },
    validateOutput: (_operation, value) => {
      const errors = validateStageDecision(value, {
        agent: { agent_id: 'industry_chain_analyst' }, phase: 'decision_direction', evidenceIds: new Set(['e1', 'e2'])
      })
      if (errors.length) throw new Error(errors.join('; '))
    }
  })
  const result = await supervisor.decideStage({ agent: { agent_id: 'industry_chain_analyst' }, phase: 'decision_direction', prompt: [] })
  assert.deepEqual(result['证据'], ['e1', 'e2'])
  assert.equal(supervisor.diagnostics().program_derivations.length, 1)
  assert.equal(supervisor.diagnostics().program_derivations[0].changed_from_model_report, true)
})

test('deterministic stage evidence derivation never launders an unknown evidence reference', async () => {
  const supervisor = new ProviderSupervisor({
    primary: { decideStage: async () => ({
      '执行员': 'seat-1', '经营调整方向': 'risk_up',
      '逻辑': [{ claim: '承压', mechanism: '现金流承压', evidence_refs: ['unknown-evidence'] }], '证据': []
    }) },
    fallback: { decideStage: async () => ({
      '执行员': 'seat-1', '经营调整方向': 'risk_flat',
      '逻辑': [{ claim: '缺少证据', mechanism: '保守维持', evidence_refs: ['e1'] }], '证据': ['e1']
    }) },
    config: { maximum_primary_model_calls: 1, maximum_primary_protocol_retries: 0, maximum_elapsed_seconds: 60, maximum_total_prompt_characters: 10000 },
    validateOutput: (_operation, value) => {
      const errors = validateStageDecision(value, { agent: { agent_id: 'seat-1' }, phase: 'decision_direction', evidenceIds: new Set(['e1']) })
      if (errors.length) throw new Error(errors.join('; '))
    }
  })
  const result = await supervisor.decideStage({ agent: { agent_id: 'seat-1' }, phase: 'decision_direction', prompt: [] })
  assert.equal(result.model_provenance.degraded, true)
  assert.deepEqual(result['证据'], ['e1'])
  assert.match(supervisor.diagnostics().fallback_events[0].reason_detail, /unknown stage evidence ref/)
})

test('multi-model provider repairs markdown-only answers through the same profile before parsing', async () => {
  const requests = []
  const repaired = {
    '执行员': 'industry_chain_analyst',
    '经营调整方向': 'risk_flat',
    '逻辑': [{ claim: '维持', mechanism: '公开证据未显示重大恶化', evidence_refs: ['e1'] }],
    '证据': ['e1']
  }
  const provider = new MultiModelProvider({
    config: {
      contract_version: '1.0.0',
      profiles: { chain: { provider: 'openai_compatible', base_url: 'https://chain.example/v1', api_key: 'secret', model: 'chain-model', max_retries: 0 } }
    },
    fetchImpl: async (url, init) => {
      requests.push(JSON.parse(init.body))
      const content = requests.length === 1 ? '# 经营调整方向\n维持，证据为e1。' : JSON.stringify(repaired)
      return jsonResponse({ choices: [{ message: { content } }] })
    }
  })
  const result = await provider.decideStage({
    agent: { agent_id: 'industry_chain_analyst', model_profile: 'chain' },
    phase: 'decision_direction',
    prompt: [{ role: 'user', content: '{}' }]
  })
  assert.deepEqual({ ...result }, repaired)
  assert.equal(result.model_provenance.format_repaired, true)
  assert.equal(requests.length, 2)
  assert.match(requests[1].messages[0].content, /只转换格式/)
})

test('multi-model provider repairs parseable stage JSON that violates the four-module wire contract', async () => {
  const requests = []
  const repaired = {
    '执行员': 'industry_chain_analyst',
    '经营调整方向': 'risk_flat',
    '逻辑': [{ claim: '维持', mechanism: '证据不足以支持调整', evidence_refs: ['e1'] }],
    '证据': ['e1']
  }
  const provider = new MultiModelProvider({
    config: {
      contract_version: '1.0.0',
      profiles: { chain: { provider: 'openai_compatible', base_url: 'https://chain.example/v1', api_key: 'secret', model: 'chain-model', max_retries: 0 } }
    },
    fetchImpl: async (url, init) => {
      requests.push(JSON.parse(init.body))
      const content = requests.length === 1 ? JSON.stringify({ answer: '维持', reason: 'e1' }) : JSON.stringify(repaired)
      return jsonResponse({ choices: [{ message: { content } }] })
    }
  })
  const result = await provider.decideStage({
    agent: { agent_id: 'industry_chain_analyst', model_profile: 'chain' },
    phase: 'decision_direction',
    prompt: [{ role: 'user', content: '{}' }]
  })
  assert.deepEqual({ ...result }, repaired)
  assert.equal(result.model_provenance.format_repaired, true)
  assert.equal(requests.length, 2)
})

test('multi-model provider repairs a valid four-module response from the wrong decision phase', async () => {
  const requests = []
  const repaired = {
    '执行员': 'industry_chain_analyst',
    '风控建议': ['3'],
    '逻辑': [{ claim: '监控', mechanism: '冻结经营方向要求加强监控', evidence_refs: ['e1'] }],
    '证据': ['e1']
  }
  const provider = new MultiModelProvider({
    config: {
      contract_version: '1.0.0',
      profiles: { chain: { provider: 'openai_compatible', base_url: 'https://chain.example/v1', api_key: 'secret', model: 'chain-model', max_retries: 0 } }
    },
    fetchImpl: async (url, init) => {
      requests.push(JSON.parse(init.body))
      const wrongPhase = {
        '执行员': 'industry_chain_analyst',
        '经营调整方向': 'risk_flat',
        '逻辑': [],
        '证据': ['e1']
      }
      return jsonResponse({ choices: [{ message: { content: JSON.stringify(requests.length === 1 ? wrongPhase : repaired) } }] })
    }
  })
  const result = await provider.decideStage({
    agent: { agent_id: 'industry_chain_analyst', model_profile: 'chain' },
    phase: 'risk_control_advice',
    prompt: [{ role: 'user', content: '{}' }]
  })
  assert.deepEqual({ ...result }, repaired)
  assert.equal(result.model_provenance.format_repaired, true)
  assert.match(requests[1].messages[0].content, /当前是风控建议阶段/)
})

test('multi-model provider deterministically projects a wrapped stage answer without another model call', async () => {
  const requests = []
  const expected = {
    '执行员': 'industry_chain_analyst',
    '经营调整方向': 'risk_up',
    '逻辑': [{ claim: '承压', mechanism: '现金流压力上升', evidence_refs: ['e1'] }],
    '证据': ['e1']
  }
  const provider = new MultiModelProvider({
    config: {
      contract_version: '1.0.0',
      profiles: { chain: { provider: 'openai_compatible', base_url: 'https://chain.example/v1', api_key: 'secret', model: 'chain-model', max_retries: 0 } }
    },
    fetchImpl: async (url, init) => {
      requests.push(JSON.parse(init.body))
      return jsonResponse({ choices: [{ message: { content: JSON.stringify({ result: expected, explanation: 'must be discarded' }) } }] })
    }
  })
  const result = await provider.decideStage({
    agent: { agent_id: 'industry_chain_analyst', model_profile: 'chain' },
    phase: 'decision_direction',
    prompt: [{ role: 'user', content: '{}' }]
  })
  assert.deepEqual({ ...result }, expected)
  assert.equal(requests.length, 1)
})

test('Nanshu local role environment accepts only model IDs and independent API keys', () => {
  const parsed = parseRoleEnvironment([
    'NANSHU_CHAIN_MODEL=claude-sonnet-5',
    'NANSHU_CHAIN_API_KEY=chain-key',
    'NANSHU_MONITOR_MODEL="qwen3.7-plus"',
    'NANSHU_MONITOR_API_KEY=monitor-key'
  ].join('\n'))
  assert.deepEqual(parsed, {
    NANSHU_CHAIN_MODEL: 'claude-sonnet-5',
    NANSHU_CHAIN_API_KEY: 'chain-key',
    NANSHU_MONITOR_MODEL: 'qwen3.7-plus',
    NANSHU_MONITOR_API_KEY: 'monitor-key'
  })
  assert.throws(() => parseRoleEnvironment('NANSHU_CHAIN_BASE_URL=https://evil.example/v1'), /unsupported/)
  assert.throws(() => parseRoleEnvironment('NANSHU_CHAIN_API_KEY=a\nNANSHU_CHAIN_API_KEY=b'), /duplicate/)
})

test('all Nanshu roles inherit the fixed OpenClaw-compatible transport settings', () => {
  const config = require('../config/model-profiles.nanshu.example.json')
  for (const configuredProfile of Object.values(config.profiles)) {
    const profile = mergeProfile(config.defaults, configuredProfile)
    assert.equal(profile.provider, 'openai_compatible')
    assert.equal(profile.api, 'openai-completions')
    assert.equal(profile.base_url, 'https://provider.example.invalid/v1')
    assert.equal(profile.send_user_agent, true)
    assert.ok(profile.model_env)
    assert.ok(profile.api_key_env)
  }
  assert.equal(config.profiles.red_team_reasoner.model, 'configure-your-model')
  assert.equal(config.profiles.monitor_extractor.model, 'configure-your-model')
  assert.equal(config.profiles.monitor_extractor.extra_body.enable_thinking, false)
  assert.equal(config.profiles.decision_reasoner.extra_body.reasoning_effort, "high")
  assert.equal(config.profiles.decision_reasoner.extra_body.enable_thinking, undefined)
})

test('explicit fixture mode is isolated from an installed production model config', async () => {
  const previous = process.env.AGENT_MODEL_CONFIG
  process.env.AGENT_MODEL_CONFIG = '/definitely/not/a/model-config.json'
  try {
    const loaded = await loadProvider({ allowFixture: true })
    assert.equal(loaded.fixture, true)
    assert.equal(loaded.mode, 'fixture')
  } finally {
    if (previous === undefined) delete process.env.AGENT_MODEL_CONFIG
    else process.env.AGENT_MODEL_CONFIG = previous
  }
})

// The private competition-dataset audit is intentionally not distributed.

test('public source collector quarantines future information and preserves source status', async () => {
  const collector = new PublicSourceCollector({
    adapters: {
      official_a: { collect: async () => ({ source_id: 'official_a', evidence: [evidence('a1', '2026-01-01', 'company_disclosure')], failures: [] }) },
      official_b: { collect: async () => ({ source_id: 'official_b', evidence: [evidence('b1', '2026-01-03', 'government_policy')], failures: [] }) }
    }
  })
  const packet = await collector.collect({
    contract_version: '1.0.0', request_id: 'request-1', as_of_date: '2026-01-02',
    company: { id: '001', name: '企业' },
    queries: [{ source_id: 'official_a', start_date: '2025-01-01' }, { source_id: 'official_b', start_date: '2025-01-01' }]
  })
  assert.deepEqual(packet.evidence.map(item => item.id), ['a1'])
  assert.deepEqual(packet.quarantined.map(item => item.id), ['b1'])
  assert(packet.source_runs.every(run => run.status === 'available'))
})

test('manual source assistance persists a resumable request and imports immutable public evidence', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rulora-manual-assistance-'))
  await fs.mkdir(path.join(root, 'config'), { recursive: true })
  await Promise.all([
    fs.copyFile(path.resolve(__dirname, '..', 'config', 'manual-source-assistance.json'), path.join(root, 'config', 'manual-source-assistance.json')),
    fs.copyFile(path.resolve(__dirname, '..', 'config', 'public-sources.json'), path.join(root, 'config', 'public-sources.json'))
  ])
  let notifications = 0
  const snapshotDirectory = path.join(root, '.runtime', 'evidence-snapshots')
  const assistance = new ManualAssistanceService({ root, snapshotDirectory, notifier: () => { notifications += 1 } })
  const collector = new PublicSourceCollector({ adapters: {}, snapshotDirectory, manualAssistance: assistance })
  const request = {
    contract_version: '1.0.0', request_id: 'manual-request-1', as_of_date: '2026-01-02',
    company: { id: '001', name: '测试企业' },
    queries: [{ source_id: 'credit_china', keyword: '测试企业' }]
  }
  const first = await collector.collect(request)
  assert.equal(first.status, 'awaiting_manual_assistance')
  assert.equal(first.evidence.length, 0)
  assert.equal(notifications, 1)
  assert.equal(first.source_runs[0].query_id, null)
  const pending = first.manual_assistance_requests[0]
  const secondPending = await collector.collect(request)
  assert.equal(secondPending.manual_assistance_requests[0].assistance_id, pending.assistance_id)
  assert.equal(notifications, 1)

  const metadata = JSON.parse(await fs.readFile(pending.response_template_path, 'utf8'))
  Object.assign(metadata, {
    source_url: 'https://www.creditchina.gov.cn/xinyongfuwu/',
    title: '公开信用查询结果',
    summary: '截至案例截止日的公开查询结果。',
    published_at: '2026-01-01',
    retrieved_at: '2026-08-10T00:00:00.000Z',
    immutable_publication: true,
    publication_time_basis: 'official_result_publication_date',
    immutable_proof_url: 'https://www.creditchina.gov.cn/xinyongfuwu/'
  })
  await fs.writeFile(pending.response_template_path, `${JSON.stringify(metadata, null, 2)}\n`)
  const original = path.join(root, 'public-result.html')
  await fs.writeFile(original, '<html>公开信用查询结果</html>')
  const imported = await assistance.importEvidence({ assistanceId: pending.assistance_id, filePath: original, metadataPath: pending.response_template_path })
  assert.equal(imported.status, 'evidence_validated')
  const resumed = await collector.collect(request)
  assert.equal(resumed.status, 'complete')
  assert.equal(resumed.evidence.length, 1)
  assert.equal(resumed.evidence[0].evidence_grade, 'A')
  assert.equal(resumed.evidence[0].snapshot_ref, `${resumed.evidence[0].content_sha256}.bin`)
  const restored = await assistance.get(pending.assistance_id)
  assert.equal(restored.request.status, 'analysis_resumed')
})

test('manual industry-plan query preserves requirement provenance in source runs', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rulora-manual-plan-audit-'))
  await fs.mkdir(path.join(root, 'config'), { recursive: true })
  await Promise.all([
    fs.copyFile(path.resolve(__dirname, '..', 'config', 'manual-source-assistance.json'), path.join(root, 'config', 'manual-source-assistance.json')),
    fs.copyFile(path.resolve(__dirname, '..', 'config', 'public-sources.json'), path.join(root, 'config', 'public-sources.json'))
  ])
  const assistance = new ManualAssistanceService({ root, notifier: () => ({ attempted: false, delivered: false }) })
  const collector = new PublicSourceCollector({ adapters: {}, manualAssistance: assistance })
  const packet = await collector.collect({
    contract_version: '1.0.0', request_id: 'manual-plan-request', as_of_date: '2026-01-02', company: { id: '001', name: '测试企业' },
    queries: [{ source_id: 'national_statistics', query_id: 'plan:r2:national_statistics', query_origin: 'industry_plan_manual_requirement', requirement_id: 'r2', claim_scope: '区域经济', query: '测试企业 工业增加值', required: true }]
  })
  assert.equal(packet.source_runs[0].query_id, 'plan:r2:national_statistics')
  assert.equal(packet.source_runs[0].requirement_id, 'r2')
  assert.equal(packet.source_runs[0].query_origin, 'industry_plan_manual_requirement')
})

test('manual source assistance rejects future information and unregistered hosts', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rulora-manual-reject-'))
  await fs.mkdir(path.join(root, 'config'), { recursive: true })
  await Promise.all([
    fs.copyFile(path.resolve(__dirname, '..', 'config', 'manual-source-assistance.json'), path.join(root, 'config', 'manual-source-assistance.json')),
    fs.copyFile(path.resolve(__dirname, '..', 'config', 'public-sources.json'), path.join(root, 'config', 'public-sources.json'))
  ])
  const service = new ManualAssistanceService({ root, notifier: () => {} })
  const pending = await service.resolveOrRequest({
    collectionRequestId: 'reject-request', company: { id: '001', name: '企业' },
    query: { source_id: 'tianyancha', keyword: '企业' }, asOfDate: '2026-01-02'
  })
  const metadata = JSON.parse(await fs.readFile(pending.response_template_path, 'utf8'))
  Object.assign(metadata, {
    source_url: 'https://evil.example/result', title: '结果', summary: '摘要',
    published_at: '2026-01-03', retrieved_at: '2026-01-03T00:00:00.000Z', immutable_publication: true
  })
  await fs.writeFile(pending.response_template_path, JSON.stringify(metadata))
  const original = path.join(root, 'result.txt')
  await fs.writeFile(original, 'public')
  await assert.rejects(() => service.importEvidence({ assistanceId: pending.request.assistance_id, filePath: original, metadataPath: pending.response_template_path }), /outside source registry|future information/)
})

test('live model readiness receipt is bound to current models, keys, and expiry', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rulora-model-smoke-'))
  const config = {
    contract_version: '1.0.0', defaults: { provider: 'openai_compatible', base_url: 'https://relay.example/v1' },
    profiles: { red: { model: 'deepseek-v4-flash-0731', api_key_env: 'RED_KEY' } }
  }
  const checkedAt = new Date('2026-01-02T00:00:00.000Z')
  await writeSmokeReceipt({ root, config, environment: { RED_KEY: 'key-one' }, checkedAt, maxAgeHours: 24, passed: true, results: [{ profile_id: 'red', ok: true }] })
  assert.equal(verifySmokeReceipt({ root, config, environment: { RED_KEY: 'key-one' }, now: new Date('2026-01-02T01:00:00.000Z') }).live_ready, true)
  assert.equal(verifySmokeReceipt({ root, config, environment: { RED_KEY: 'key-two' }, now: new Date('2026-01-02T01:00:00.000Z') }).reason, 'model_or_key_changed_since_smoke')
  assert.equal(verifySmokeReceipt({ root, config, environment: { RED_KEY: 'key-one' }, now: new Date('2026-01-04T00:00:00.000Z') }).reason, 'live_smoke_receipt_expired')
})

test('refreshing a real case replaces stale evidence only with a complete two-source packet', () => {
  const packet = {
    status: 'complete', as_of_date: '2026-01-02', company: { id: '001', name: '企业' }, snapshot_root: '/tmp/snapshots',
    evidence: [evidence('a', '2026-01-01', 'company_disclosure'), evidence('b', '2026-01-01', 'government_policy')],
    source_runs: [{ source_id: 'cninfo', status: 'available' }, { source_id: 'government_policy', status: 'available' }],
    query_templates: [{ source_id: 'cninfo' }], packet_sha256: 'c'.repeat(64)
  }
  const refreshed = refreshCaseFromEvidencePacket({
    baseCase: { case_id: 'case', as_of_date: '2026-01-02', company: { id: '001', name: '企业' }, evidence: [{ id: 'stale' }], collection_request: {} },
    evidencePacket: packet
  })
  assert.deepEqual(refreshed.evidence.map(item => item.id), ['a', 'b'])
  assert.equal(refreshed.evidence_snapshot_root, '/tmp/snapshots')
  assert.equal(Object.hasOwn(refreshed, 'collection_request'), false)
})

test('cninfo evidence hashes immutable PDF bytes even when the PDF parser detaches its input', async () => {
  const downloaded = Uint8Array.from([37, 80, 68, 70, 45, 49, 46, 55])
  const expectedHash = sha256(downloaded)
  const adapter = new CninfoAdapter({
    httpClient: {
      bytes: async () => ({
        bytes: downloaded,
        response: { headers: { get: name => name === 'content-type' ? 'application/pdf' : null } }
      })
    },
    pdfTextExtractor: async bytes => {
      structuredClone(bytes.buffer, { transfer: [bytes.buffer] })
      return '已发布公告正文'
    }
  })
  const item = await adapter.toEvidence({
    announcementId: 'test-pdf',
    adjunctUrl: 'finalpage/test.pdf',
    announcementTitle: '测试公告',
    announcementTime: Date.parse('2026-01-02T00:00:00+08:00'),
    secCode: '000001',
    secName: '测试公司',
    adjunctType: 'PDF'
  }, { fetchDocument: true })
  assert.equal(downloaded.byteLength, 0)
  assert.equal(item.content_sha256, expectedHash)
  assert.equal(item.content_hash_scope, 'source_document_bytes')
  assert.equal(item.document_fetch_status, 'full_text_extracted')
})

test('active monitor persists diffs and only triggers on new A/B evidence', async () => {
  const runtimeDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'rulora-public-monitor-'))
  const collector = {
    collect: async request => ({
      contract_version: '1.0.0', request_id: request.request_id, company: request.company,
      as_of_date: request.as_of_date, public_information_only: true,
      evidence: [evidence('new-a', '2026-01-02', 'company_disclosure')],
      quarantined: [], source_runs: [{ source_id: 'official', status: 'available' }],
      packet_sha256: 'b'.repeat(64)
    })
  }
  const service = new PublicMonitorService({ runtimeDirectory, collector })
  await service.register({
    contract_version: '1.0.0', watch_id: 'watch-1', status: 'active', baseline_run_id: 'run-1',
    company: { id: '001', name: '企业' }, competition_cutoff: '2026-01-02', schedule: '0 */6 * * *',
    baseline_cutoff: '2026-01-02',
    baseline_case: {
      contract_version: '1.0.0', case_id: 'baseline-case', as_of_date: '2026-01-02', competition_cutoff: '2026-01-02',
      company: { id: '001', name: '企业' }, evidence: [], monitoring: { mode: 'active' }
    },
    query_templates: [{ source_id: 'official', query: '企业', start_date: '2025-01-01' }], known_evidence: {}
  })
  const first = await service.run('watch-1')
  assert.deepEqual(first.result.new_evidence_ids, ['new-a'])
  assert.equal(first.result.trigger_reanalysis, true)
  assert.equal(first.result.baseline_cutoff, '2026-01-02')
  assert.equal(first.result.observation_as_of_date, new Date().toISOString().slice(0, 10))
  const reanalysisCase = JSON.parse(await fs.readFile(first.result.reanalysis_case_path, 'utf8'))
  assert.equal(reanalysisCase.as_of_date, new Date().toISOString().slice(0, 10))
  assert.equal(reanalysisCase.parent_case_id, 'baseline-case')
  const second = await service.run('watch-1')
  assert.deepEqual(second.result.new_evidence_ids, [])
  assert.equal(second.result.trigger_reanalysis, false)
})

function agent(id, family, { slotId = id, status = 'champion', evolutionEligible = true } = {}) {
  return {
    slot_id: slotId,
    agent_id: id,
    version: 1,
    status,
    label: id,
    method_family: family,
    mission: id,
    required_lenses: [],
    participates_in_prediction: true,
    participates_in_debate: true,
    evolution_eligible: evolutionEligible,
    mutation: null,
    weight: 1,
    probation_streak: 0,
    metrics: emptyMetrics()
  }
}

function pairedLabeledRun(caseId) {
  return {
    case_id: caseId,
    run_id: `${caseId}-run`,
    as_of_date: '2026-01-01',
    revised_opinions: [
      { agent_id: 'factor_champion', probabilities: { risk_up: 0.05, risk_flat: 0.15, risk_down: 0.8 }, recommended_advice: ['1'] }
    ],
    shadow_opinions: [
      { agent_id: 'factor_challenger', probabilities: { risk_up: 0.85, risk_flat: 0.1, risk_down: 0.05 }, recommended_advice: ['4'] }
    ],
    shadow_runs: [{ agent_id: 'factor_challenger', status: 'completed' }],
    consensus: { probabilities: { risk_up: 0.7, risk_flat: 0.2, risk_down: 0.1 }, risk_control_advice: ['4'], decision_mode: 'clean_consensus' },
    debate_record: { termination: { clean_gate_satisfied: true } },
    report: {
      qa: {
        fixture_provider: false,
        schema_valid: true,
        probabilities_valid: true,
        cutoff_verified: true,
        source_registry_verified: true,
        evidence_snapshots_verified: true,
        evidence_refs_valid: true,
        evidence_coverage_sufficient: true,
        degraded: false,
        production_ready: true
      }
    }
  }
}

function truthFor(run) {
  return {
    contract_version: '1.0.0', case_id: run.case_id, run_id: run.run_id,
    risk_label: 'risk_up', risk_control_advice: ['4'],
    source_url: 'https://example.gov.cn/outcome', content_sha256: 'a'.repeat(64), verified: true,
    revealed_at: '2026-08-01', label_definition_version: 'decision-outcome-v1'
  }
}

function jsonResponse(value) {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => value,
    text: async () => JSON.stringify(value)
  }
}

function evidence(id, publishedAt, sourceType) {
  return {
    id,
    source_type: sourceType,
    publisher: '公开发布者',
    source_url: `https://example.com/${id}`,
    title: id,
    summary: id,
    published_at: publishedAt,
    evidence_grade: 'A',
    content_sha256: id.padEnd(64, 'a').slice(0, 64),
    public: true
  }
}


test('JSON mode includes json in user input for gateways that ignore system messages', () => {
  const provider = new MultiModelProvider({ config: { contract_version: '1.0.0', profiles: {} }, environment: {} })
  const profile = { provider: 'openai_compatible', base_url: 'https://relay.example/v1', model: 'test', api_key_optional: true }
  const messages = [{ role: 'system', content: '只输出JSON对象' }, { role: 'user', content: '分析产业链' }]
  const body = JSON.parse(provider.buildRequest(profile, messages).init.body)
  assert.equal(body.response_format.type, 'json_object')
  assert.ok(body.messages.some(m => m.role === 'user' && /json/i.test(m.content)))
  assert.equal(messages.length, 2)
  assert.deepEqual(JSON.parse(provider.buildRequest({...profile,json_mode:false},messages).init.body).messages,messages)
  assert.deepEqual(JSON.parse(provider.buildRequest(profile,messages,{forceText:true}).init.body).messages,messages)
  const explicit = [...messages,{role:'user',content:'return json'}]
  assert.equal(JSON.parse(provider.buildRequest(profile,explicit).init.body).messages.length,3)
})

test('JSON prerequisite 400 is corrected once without disabling JSON mode or changing caller input', async () => {
  const original = { model:'test', messages:[{role:'system',content:'只返回对象'},{role:'user',content:'合成输入'}], response_format:{type:'json_object'}, temperature:0 }
  const init = { method:'POST', body:JSON.stringify(original) }
  const seen=[], audit=[]
  const result = await requestWithRetry({ fetchImpl:async (url,req)=>{seen.push(JSON.parse(req.body));return seen.length===1?new Response(JSON.stringify({error:{message:"Response input messages must contain the word 'json' in some form to use 'text.format' of type 'json_object'."}}),{status:400}):new Response('{"ok":true}')},url:'https://test.example',init,timeoutMs:1000,maxRetries:0,onRequestRepair:async r=>audit.push(r) })
  assert.equal(seen.length,2)
  assert.equal(result.transport_attempts,2)
  assert.equal(result.request_repairs.length,1)
  assert.deepEqual(seen[1].response_format,original.response_format)
  assert.ok(seen[1].messages.every(m=>/json/.test(m.content)))
  assert.ok(seen[1].messages[1].content.includes('合成输入'))
  assert.equal(init.body,JSON.stringify(original))
  assert.equal(audit[0].reason,'JSON_MODE_INPUT_REQUIRED')
  assert.ok(!JSON.stringify(audit).includes('合成输入'))
})

test('persistent JSON prerequisite errors stop after one correction; other 400 and auth errors are not retried', async () => {
  for (const [status,message,mode,count] of [[400,"messages must contain the word json to use json_object",true,2],[400,'invalid parameter',true,1],[401,'messages must contain json to use json_object',true,1],[400,'messages must contain json to use json_object',false,1]]) {
    let calls=0
    await assert.rejects(()=>requestWithRetry({fetchImpl:async()=>{calls++;return new Response(message,{status})},url:'https://test.example',init:{body:JSON.stringify({messages:[{role:'user',content:'输入'}],...(mode?{response_format:{type:'json_object'}}:{})})},timeoutMs:1000,maxRetries:3,delayImpl:async()=>{}}),e=>e.http_status===status && e.connection_attempts===count)
    assert.equal(calls,count)
  }
})

test('JSON request correction is audited and output still passes strict Recovery/Adapter validation', async () => {
  for (const valid of [true,false]) {
    let calls=0;const traces=[]
    const provider=new MultiModelProvider({config:{contract_version:'1.0.0',profiles:{p:{provider:'openai_compatible',base_url:'https://test.example',model:'test',api_key_optional:true,max_transport_retries:0}}},environment:{},fetchImpl:async()=>{calls++;return calls===1?new Response('messages must contain the word json to use json_object',{status:400}):new Response(JSON.stringify({choices:[{message:{content:valid?'{"ok":true}':'not a JSON object'}}]}))}})
    provider.recordOutputTrace=async trace=>traces.push(trace)
    const run=()=>provider.callForJson({agent:{agent_id:'probe',model_profile:'p'},operation:'enterpriseProtocolSmoke',prompt:[{role:'user',content:'合成测试'}],outputInstruction:'输出对象'})
    if(valid){const out=await run();assert.equal(out.ok,true);assert.equal(out.model_provenance.request_repairs.length,1)}
    else await assert.rejects(run,e=>e.code==='MODEL_SCHEMA_FAILURE')
    assert.equal(calls,2)
    assert.equal(traces.filter(t=>t.status==='REQUEST_RETRY').length,1)
    assert.equal(traces[0].request_repairs[0].attempt,1)
    assert.ok(traces[0].parent_call_id)
  }
})


test('transport timeout diagnostics distinguish header wait from body wait', async () => {
  for (const bodyStall of [false, true]) {
    await assert.rejects(requestWithRetry({
      fetchImpl: async () => bodyStall ? { status: 200, headers: new Headers({ 'x-request-id': 'test-request' }), text: () => new Promise(() => {}) } : new Promise(() => {}),
      url: 'https://test.example', init: {}, timeoutMs: 10, maxRetries: 0
    }), error => {
      assert.equal(error.code, 'MODEL_API_TIMEOUT')
      assert.equal(error.transport_diagnostics.length, 1)
      assert.equal(error.transport_diagnostics[0].phase, bodyStall ? 'reading_body' : 'waiting_headers')
      if (bodyStall) assert.equal(error.transport_diagnostics[0].request_id, 'test-request')
      return true
    })
  }
})


test('native fetch deadline causes retain timeout classification and cause code', async () => {
  await assert.rejects(requestWithRetry({ fetchImpl: async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'UND_ERR_HEADERS_TIMEOUT' } }) }, url: 'https://test.example', init: {}, timeoutMs: 1000, maxRetries: 0 }), error => {
    assert.equal(error.code, 'MODEL_API_TIMEOUT')
    assert.equal(error.transport_diagnostics[0].network_cause_code, 'UND_ERR_HEADERS_TIMEOUT')
    return true
  })
})
test('timeout-specific budget switches early without disabling transient HTTP retries',async()=>{
 let calls=0
 await assert.rejects(requestWithRetry({fetchImpl:async()=>{calls++;return {ok:true,status:200,text:()=>new Promise(()=>{})}},url:'https://model.example',init:{},timeoutMs:10,maxRetries:2,maxTimeoutRetries:0,delayImpl:async()=>{}}),e=>e.code==='MODEL_API_TIMEOUT'&&e.connection_attempts===1)
 assert.equal(calls,1);calls=0
 const response=await requestWithRetry({fetchImpl:async()=>{calls++;return new Response('ok',{status:calls===1?429:200})},url:'https://model.example',init:{},timeoutMs:100,maxRetries:2,maxTimeoutRetries:0,delayImpl:async()=>{}})
 assert.equal(response.status,200);assert.equal(calls,2)
})
test('longer final timeout retry accepts a delayed response without an unlimited retry loop',async()=>{
 let calls=0
 const response=await requestWithRetry({fetchImpl:async()=>{if(++calls===1)return new Promise(()=>{});await new Promise(r=>setTimeout(r,40));return new Response('ok')},url:'https://test.example',init:{},timeoutMs:15,timeoutRetryMs:100,maxRetries:2,maxTimeoutRetries:1,delayImpl:async()=>{}})
 assert.equal(calls,2);assert.deepEqual(response.transport_diagnostics.map(x=>x.timeout_ms),[15,100])
 calls=0
 await assert.rejects(requestWithRetry({fetchImpl:async()=>{calls++;return new Promise(()=>{})},url:'https://test.example',init:{},timeoutMs:5,timeoutRetryMs:10,maxRetries:5,maxTimeoutRetries:1,delayImpl:async()=>{}}),e=>e.code==='MODEL_API_TIMEOUT'&&e.connection_attempts===2)
 assert.equal(calls,2)
})
