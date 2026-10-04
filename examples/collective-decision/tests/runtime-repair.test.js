const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { MultiModelProvider } = require('../src/providers/multi-model-provider')
const { WebJobManager } = require('../src/web-job-manager')
const { failureMessage } = require('../src/runtime-failure')
test('failure dialogue distinguishes the last request from all failed routes and strips private fields',()=>{
 const {failureDetails}=require('../src/runtime-failure')
 const diagnostic={attempt:1,timeout_ms:150000,phase:'waiting_headers',authorization:'secret'}
 const failure=failureDetails({code:'MODEL_API_TIMEOUT',message:'timeout',transport_diagnostics:[diagnostic],routing_attempts:[{model_profile:'primary',code:'MODEL_API_TIMEOUT',transport_diagnostics:[diagnostic],secret:'secret'},{model_profile:'backup',code:'MODEL_API_TIMEOUT',transport_diagnostics:[diagnostic,diagnostic]}]})
 assert(!JSON.stringify(failure).includes('secret'));assert.match(failureMessage(failure),/模型路由尝试2条，累计请求3次/)
})
async function providerFixture(responses) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'api-repair-'))
  let calls = 0
  const provider = new MultiModelProvider({ config: { contract_version: '1.0.0', profiles: { test: { provider: 'openai_compatible', base_url: 'https://model.example/v1', api_key: 'test', model: 'test-model', max_retries: 0 } } }, environment: { LLM_OUTPUT_TRACE_ROOT: root }, fetchImpl: async () => ({ ok: true, status: 200, text: async () => responses[Math.min(calls++, responses.length - 1)] }) })
  return { provider, root, calls: () => calls }
}
const request = { agent: { agent_id: 'seat', label: '测试席', model_profile: 'test' }, prompt: [{ role: 'user', content: 'fixture' }], outputInstruction: 'JSON', operation: 'enterpriseDecision' }
test('empty stream retries once, then returns valid output with trace', async () => {
  const f = await providerFixture(['data: [DONE]\n', JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] })])
  assert.equal((await f.provider.callForJson(request)).ok, true)
  assert.equal(f.calls(), 2)
  const traces = await Promise.all((await fs.readdir(f.root)).map(x => fs.readFile(path.join(f.root, x), 'utf8').then(JSON.parse)))
  assert.ok(traces.some(x => x.error_code === 'MODEL_API_EMPTY_RESPONSE' && x.seat === 'seat'))
})
test('persistent empty stream fails bounded with seat and model identity', async () => {
  const f = await providerFixture(['data: [DONE]\n'])
  await assert.rejects(f.provider.callForJson(request), e => e.code === 'MODEL_API_EMPTY_RESPONSE' && e.agent_id === 'seat' && e.model === 'test-model')
  assert.equal(f.calls(), 2)
})
test('SSE authentication error retains its error type and is not retried as empty', async () => {
  const f = await providerFixture(['data: {"error":{"code":"invalid_api_key"}}\n'])
  await assert.rejects(f.provider.callForJson(request), { code: 'MODEL_API_AUTHENTICATION_FAILED' })
  assert.equal(f.calls(), 1)
})
test('enterprise intake plans first, binds available search routes and reports both agents', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'intake-repair-'))
  const order = []
  const manager = new WebJobManager({ root, createIndustryPlanImpl: async ({caseData}) => {
    order.push('plan'); assert.equal(caseData.decision_mode, 'enterprise_decision_v2')
    const plan = structuredClone(require('./fixtures/planner-object-executor.json')); plan['执行员'] = 'industry_research_planner'; plan['证据需求'][0].requirement_id = 'R1'; return { industry_plan: plan }
  }, collectEvidenceImpl: async request => {
    order.push('collect')
    assert.ok(request.queries.some(q => q.requirement_id === 'R1' && q.source_id === 'web_search'))
    assert.ok(request.queries.every(q => ['cninfo', 'web_search'].includes(q.source_id)))
    return { evidence: [], status: 'complete' }
  } })
  manager.companies = [{ company_id: '001', company_name: '测试公司' }]
  manager.builtInSources = [{ id: 'cninfo', source_type: 'company_disclosure', automatic: true }]
  manager.userSourceConfig = { search_backend: { enabled: true }, websites: [] }
  const job = { job_id: 'j', company_id: '001', question: { subject: '测试公司' }, task: '企业产业链风险及决策分析', output_directory: root, agent_states: {} }
  manager.jobs.set('j', job)
  manager.recordProgress = async (_, e) => order.push(e.agent_id + ':' + e.type)
  manager.mutateJob = async (_, f) => f(job)
  await manager.prepareEnterpriseImportedCase('j')
  assert.ok(order.indexOf('plan') < order.indexOf('collect'))
  assert.ok(order.includes('industry_research_planner:agent_completed'))
  assert.ok(order.includes('public_evidence_monitor:agent_completed'))
  assert.ok(job.case_path)
  const plans = order.filter(x => x === 'plan').length
  const collections = order.filter(x => x === 'collect').length
  job.case_path = null // crash after durable intake output, before job update
  await manager.prepareEnterpriseImportedCase('j')
  assert.equal(order.filter(x => x === 'plan').length, plans)
  assert.equal(order.filter(x => x === 'collect').length, collections)
  job.force_evidence_recollection = true
  await manager.prepareEnterpriseImportedCase('j')
  assert.equal(order.filter(x => x === 'collect').length, collections + 1)
  assert.equal(order.filter(x => x === 'plan').length, plans)
  assert.equal(job.force_evidence_recollection, false)
  job.question = { subject: '另一任务' }
  await assert.rejects(manager.prepareEnterpriseImportedCase('j'), { code: 'INTAKE_CHECKPOINT_INVALID' })
})
test('API failure dialogue names cause and affected model', () => {
  const message = failureMessage({ code: 'MODEL_API_TIMEOUT', agent_label: '产业链风险席', model: 'test-model' })
  assert.match(message, /产业链风险席.*超时.*MODEL_API_TIMEOUT.*test-model/)
})

test('API failure persists a readable chat record and preserves completed seat states', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'failure-chat-'))
  const manager = new WebJobManager({root})
  const job = { job_id: 'j', user_consent: true, consent_action: 'start_analysis', decision_mode: 'enterprise_decision_v2', output_directory: root, case_path: path.join(root, 'case.json'), agent_states: { completed_seat: {status:'completed'} }, events: [], progress_percent: 0 }
  manager.jobs.set('j', job)
  await fs.writeFile(path.join(root, 'industry-plan.json'), '{}')
  manager.mutateJob = async (_, fn) => fn(job)
  manager.appendLog = async () => {}
  manager.pump = () => {}
  manager.executeEnterprise = async () => { throw Object.assign(new Error('model API request timed out'), {code:'MODEL_API_TIMEOUT', agent_label:'产业链风险席', model:'test-model'}) }
  await manager.execute('j')
  assert.equal(job.status, 'failed')
  assert.equal(job.agent_states.completed_seat.status, 'completed')
  assert.match(job.runtime_messages.at(-1).message, /产业链风险席.*超时/)
})

test('timeout details persist safe transport stages and show them in runtime dialogue', () => {
  const { failureDetails } = require('../src/runtime-failure')
  const failure = failureDetails(Object.assign(new Error('timeout'), { code: 'MODEL_API_TIMEOUT', model: 'same-model', transport_diagnostics: [{ attempt: 1, phase: 'waiting_headers', timeout_ms: 150000, elapsed_ms: 150001, authorization: 'must-not-survive' }] }))
  assert.equal(failure.transport_diagnostics[0].authorization, undefined)
  assert.match(failureMessage(failure), /等待响应头.*150秒.*1次/)
})

test('first-layer review has only direction obligations, second-layer retains action gate', () => {
  const { buildReviewPrompt, REVIEW_RULES } = require('../src/enterprise-deliberation')
  const input = { policy: '', question: {}, rules: [], arbitrationRules: REVIEW_RULES, candidates: [], evidence: [] }
  const first = buildReviewPrompt({ ...input, stage: 'direction' })[0].content
  assert.match(first, /多个候选同方向不是冲突/)
  assert.doesNotMatch(first, /第二层须绑定|行动定义：|逐项必要性与组合相容性/)
  const second = buildReviewPrompt({ ...input, stage: 'condition' })[0].content
  assert.deepEqual(JSON.parse(buildReviewPrompt({ ...input, stage: 'condition' })[1].content).action_options, require('../src/enterprise-action-contract').ACTIONS)
  assert.equal(JSON.parse(buildReviewPrompt({ ...input, stage: 'direction' })[1].content).action_options, undefined)
  assert.match(second, /direction_assessment/)
})

test('planner receives the same count and field constraints as the schema gate', async () => {
  const { provider } = await providerFixture([])
  let contract
  provider.callForJson = async args => { contract = JSON.parse(args.outputInstruction.split('\n')[1]); return {} }
  await provider.planIndustry({ agent: { agent_id: 'industry_research_planner' }, prompt: [] })
  const expected = structuredClone(require('../schemas/industry-plan.schema.json'))
  delete expected.properties['执行员']
  expected.required = expected.required.filter(key => key !== '执行员')
  assert.deepEqual(contract, expected)
})

test('collection failure preserves valid planner output for resume without another model call', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'plan-resume-'))
  let plans = 0, collections = 0
  const manager = new WebJobManager({ root, createIndustryPlanImpl: async () => {
    plans++
    const plan = structuredClone(require('./fixtures/planner-object-executor.json'))
    plan['执行员'] = 'industry_research_planner'
    return { industry_plan: plan }
  }, collectEvidenceImpl: async () => {
    if (++collections === 1) throw new Error('interrupted collection')
    return { evidence: [], status: 'complete' }
  } })
  manager.companies = [{ company_id: '001', company_name: '测试公司' }]
  manager.builtInSources = []
  manager.userSourceConfig = { search_backend: { enabled: false }, websites: [] }
  const job = { job_id: 'j', company_id: '001', question: {}, task: 'fixed', output_directory: root }
  manager.jobs.set('j', job)
  manager.mutateJob = async (_, fn) => fn(job)
  manager.recordProgress = async () => {}
  await assert.rejects(manager.prepareEnterpriseImportedCase('j'), /interrupted collection/)
  await manager.prepareEnterpriseImportedCase('j')
  assert.equal(plans, 1)
  assert.equal(collections, 2)
  const p = path.join(root, 'industry-plan.json')
  const saved = JSON.parse(await fs.readFile(p, 'utf8'))
  saved.industry_plan['执行员'] = 'wrong'
  await fs.writeFile(p, JSON.stringify(saved))
  await assert.rejects(manager.prepareEnterpriseImportedCase('j'), { code: 'INTAKE_CHECKPOINT_INVALID' })
  assert.equal(plans, 1)
})

test('enterprise planning receives the same internal-information policy without mandatory exhaustive due diligence',()=>{
 const {industryPlanningPrompt}=require('../src/prompts')
 const content=industryPlanningPrompt({agent:{agent_id:'industry_research_planner',label:'规划'},caseData:{decision_mode:'enterprise_decision_v2',company:{}}})[0].content
 assert.match(content,/查不到的企业内部信息/)
 assert.match(content,/不要求每个维度齐备/)
 assert.doesNotMatch(content,/对每层做停供反事实/)
 const legacy=industryPlanningPrompt({agent:{agent_id:'legacy',label:'规划'},caseData:{company:{}}})[0].content
 assert.match(legacy,/对每层做停供反事实/)
})
