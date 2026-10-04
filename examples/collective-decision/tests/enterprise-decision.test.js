const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { sha256 } = require('../src/utils')
const { SEATS, clarifyQuestion, independentChannels, validateCandidate, freezeStage, runEnterpriseDecision } = require('../src/enterprise-decision')

const { question, fixture, enrichCandidate, exchangeResult, reviewResult, fakeProvider } = require('../examples/fixtures/enterprise-provider')

test('reception requires a decision question and subject only', () => {
  assert.equal(clarifyQuestion({ question: '是否继续投入？', subject: '甲公司' }).valid, true)
  assert.deepEqual(clarifyQuestion({ question: '', subject: '甲公司' }).missing, ['决策问题'])
})

test('both layers have five separate seats; income and cost share a seat', () => {
  assert.equal(SEATS.direction.length, 5)
  assert.equal(SEATS.condition.length, 5)
  assert.ok(SEATS.condition.some(item => item[0] === 'revenue_cost'))
})

test('candidate gate enforces structured factors and frozen direction version', () => {
  const errors = validateCandidate({ condition: 0, reason: '等待', evidence_refs: ['E1'], gaps: [], factors: [], direction_version: 'wrong' }, 'condition', new Set(['E1']), { version: 'right' })
  assert.ok(errors.some(error => error.startsWith('第二层未绑定冻结方向版本')))
  assert.ok(errors.includes('有结论必须列出结构化因子'))
})

test('two republished copies of one original are one source', () => {
  const evidence = [
    { id: 'E1', publisher: '转载站甲', source_url: 'https://a.example/1', title: '同一公告', published_at: '2026-09-01' },
    { id: 'E2', publisher: '转载站乙', source_url: 'https://b.example/2', title: '同一公告', published_at: '2026-09-01' }
  ]
  assert.equal(independentChannels(evidence, ['E1', 'E2']).count, 1)
})

test('split final codes do not become a majority conclusion', () => {
  const candidates = [1, 1, 1, 0, 0].map(direction => ({ direction, reason: '依据', gaps: [], evidence_refs: ['E1'], assumptions: [] }))
  assert.equal(freezeStage('direction', candidates, [], null, { satisfied: true }).code, null)
})

test('LangGraph and Rulora freeze both layers; two sources are required globally, not per claim', async () => {
  const { root, caseData } = await fixture()
  const provider = fakeProvider()
  const events = []
  const result = await runEnterpriseDecision({ caseData, question, rules: ['限制未解除时不满足'], provider, outputDirectory: root, onProgress: event => events.push(event) })
  assert.equal(result.status, 'approved')
  assert.deepEqual(Object.keys(result.report), ['方向', '决策建议', '理由'])
  assert.equal(result.report.方向, 1)
  assert.deepEqual(result.report.决策建议.map(a => a.编号), [3])
  assert.ok(provider.calls.slice(0, 6).every(call => call.operation !== 'initial' || call.stage === 'direction'))
  assert.ok(provider.calls.filter(call => call.stage === 'condition' && call.operation === 'initial').every(call => call.prior?.version))
  assert.equal(result.metadata.evidence_processing.source_gate.independent_source_count, 2)
  assert.equal(result.metadata.evidence_processing.source_gate.per_claim_corroboration_required, false)
  assert.equal(result.metadata.attempts.length, 1)
  assert.ok(result.metadata.attempts[0].rulora_snapshot_sha256)
  assert.ok(result.metadata.graph_trace.some(item => item.type === 'stage_frozen'))
  assert.equal(events.filter(item => item.type === 'agent_started' && item.agent_id === 'enterprise_semantic_reviewer').length, 2)
  assert.equal(events.filter(item => item.type === 'agent_completed' && item.agent_id === 'enterprise_semantic_reviewer').length, 2)
})

test('missing user rules and experience do not stop the condition layer', async () => {
  const { root, caseData } = await fixture()
  caseData.evidence[0].summary = '公开披露信息。'.repeat(500)
  const provider = fakeProvider()
  const result = await runEnterpriseDecision({ caseData, question: { question: '是否继续投入储能业务？', subject: '甲公司' }, rules: [], experience: [], provider, outputDirectory: root })
  assert.equal(result.status, 'approved')
  assert.deepEqual(result.report.决策建议.map(a => a.编号), [3])
  assert.ok(provider.calls.some(call => call.stage === 'condition' && call.operation === 'initial'))
  assert.ok(provider.calls.filter(call => call.operation === 'initial').every(call => call.evidence_summary_lengths.every(length => length <= 2400)))
})

test('a rate-limited chain seat uses the configured decision fallback and records it', async () => {
  const { root, caseData } = await fixture()
  const provider = fakeProvider()
  const decide = provider.enterpriseDecision.bind(provider)
  delete provider.enterpriseDecision
  provider.enterpriseDecision = undefined
  provider.callForJson = async ({ agent, prompt }) => {
    if (agent.model_profile === 'chain_reasoner') throw Object.assign(new Error('rate limited'), { code: 'MODEL_API_CAPACITY_OR_RATE_LIMIT' })
    return decide({ agent, prompt, stage: (prompt[0].content.includes('recommendations,actions') || Boolean(JSON.parse(prompt[1].content).output_contract)) ? 'condition' : 'direction', review: Boolean(JSON.parse(prompt[1].content).broadcast_version) })
  }
  const events = []
  const result = await runEnterpriseDecision({ caseData, question, provider, outputDirectory: root, onProgress: event => events.push(event) })
  assert.equal(result.status, 'approved')
  assert.ok(events.some(event => event.type === 'model_fallback' && event.from_profile === 'chain_reasoner' && event.to_profile === 'decision_reasoner'))
})

test('countercheck timeout uses one real-model fallback and retains its role', async () => {
  const { root, caseData } = await fixture()
  const provider = fakeProvider()
  const decide = provider.enterpriseDecision.bind(provider)
  provider.enterpriseDecision = undefined
  const fallbackCalls = []
  provider.callForJson = async ({ agent, prompt }) => {
    if (agent.model_profile === 'red_team_reasoner') throw Object.assign(new Error('timeout'), { code: 'MODEL_API_TIMEOUT' })
    if (agent.model_profile === 'decision_reasoner') fallbackCalls.push({ agent, system: prompt[0].content })
    return decide({ agent, prompt, stage: (prompt[0].content.includes('recommendations,actions') || Boolean(JSON.parse(prompt[1].content).output_contract)) ? 'condition' : 'direction', review: Boolean(JSON.parse(prompt[1].content).broadcast_version) })
  }
  const events = []
  const result = await runEnterpriseDecision({ caseData, question, provider, outputDirectory: root, onProgress: e => events.push(e) })
  assert.equal(result.status, 'approved')
  assert.equal(fallbackCalls.length, 4)
  assert.ok(fallbackCalls.every(c => ['direction_countercheck', 'condition_countercheck'].includes(c.agent.agent_id) && c.system.includes('反向核查')))
  assert.equal(events.filter(e => e.type === 'model_fallback' && e.from_profile === 'red_team_reasoner' && e.reason === 'MODEL_API_TIMEOUT').length, 4)
})

test('semantic reviewer transport fallback still passes independent review contract', async () => {
  const { root, caseData } = await fixture()
  const provider = fakeProvider()
  provider.enterpriseReview = undefined
  const calls = []
  provider.callForJson = async ({ agent, prompt, operation }) => {
    calls.push({ agent, operation })
    if (agent.model_profile === 'red_team_reasoner') throw Object.assign(new Error('timeout'), { code: 'MODEL_API_TIMEOUT' })
    return reviewResult({ stage: JSON.parse(prompt[1].content).stage, prompt })
  }
  const result = await runEnterpriseDecision({ caseData, question, provider, outputDirectory: root })
  assert.equal(result.status, 'approved')
  assert.equal(calls.length, 4)
  assert.ok(calls.every(c => c.agent.agent_id === 'enterprise_semantic_reviewer' && c.operation === 'enterpriseSemanticReview'))
  assert.equal(calls.filter(c => c.agent.model_profile === 'decision_reasoner').length, 2)
})

test('changed peer opinions reactivate frozen seats before the layer stops', async () => {
  const { root, caseData } = await fixture()
  const provider = fakeProvider({ split: true })
  const result = await runEnterpriseDecision({ caseData, question, rules: ['限制未解除时不满足'], provider, outputDirectory: root })
  assert.equal(result.metadata.stages.direction.loop_rounds.length, 2)
  assert.deepEqual(result.metadata.stages.direction.loop_rounds[0].changed_seat_ids, ['supply_competition'])
  assert.equal(provider.calls.filter(item => item.operation === 'review' && item.stage === 'direction').length, 10)
  assert.equal(result.report.方向, 1)
})

test('same unresolved opinion stops loop and remains null', async () => {
  const { root, caseData } = await fixture()
  const provider = fakeProvider({ split: true, noProgress: true })
  provider.enterpriseReview = async ({stage,prompt}) => reviewResult({stage,prompt}, { consistent: false, selected_seat_id: 'demand_growth', unresolved_gaps: ['经营数据不足以消解方向冲突'] })
  const result = await runEnterpriseDecision({ caseData, question, rules: ['限制未解除时不满足'], provider, outputDirectory: root })
  assert.equal(result.metadata.stages.direction.loop_rounds.length, 1)
  assert.equal(result.metadata.stages.direction.termination_reason, 'all_seats_frozen')
  assert.equal(result.report.方向, null)
  assert.deepEqual(result.report.决策建议.map(a => a.编号), [10])
  assert.equal(result.status, 'awaiting_assistance')
})

test('a real model shape error receives one bounded revision with program feedback', async () => {
  const { root, caseData } = await fixture()
  const provider = fakeProvider()
  const decide = provider.enterpriseDecision.bind(provider)
  let attempts = 0
  provider.enterpriseDecision = async input => {
    if (input.agent.agent_id === 'demand_growth' && input.stage === 'direction' && !input.review) {
      attempts += 1
      if (attempts === 1) return { direction: 'positive', reason: { text: 'wrong shape' }, evidence_refs: ['E1'], gaps: [], assumptions: [], factors: [] }
      assert.match(input.prompt.at(-1).content, /direction必须是-1、0、1或null/)
    }
    return decide(input)
  }
  const events = []
  const result = await runEnterpriseDecision({ caseData, question, rules: ['限制未解除时不满足'], provider, outputDirectory: root, onProgress: event => events.push(event) })
  assert.equal(result.status, 'approved')
  assert.equal(attempts, 2)
  assert.equal(events.filter(event => event.type === 'model_revision_requested').length, 1)
})

test('thirteen codes, exclusive outcomes, no cardinality target, and empty proposals rejected', () => {
  const { ACTIONS, validateActions } = require('../src/enterprise-action-contract')
  assert.equal(ACTIONS.length, 13)
  const candidate = { recommendations: [10], actions: [], gaps: ['重大事实冲突'], evidence_refs: [] }
  assert.deepEqual(validateActions(candidate, new Set(), { code: 1 }), [])
  assert.ok(validateActions({ ...candidate, recommendations: [10, 3] }, new Set(), { code: 1 }).some(x => x.includes('独占')))
  assert.ok(!validateActions({ ...candidate, recommendations: [1,2,3,4] }, new Set(), { code: 1 }).some(x => /最多|上限/.test(x)))
  assert.ok(validateActions({ ...candidate, recommendations: [3,3] }, new Set(), { code: 1 }).some(x => x.includes('重复')))
  assert.ok(validateActions({ recommendations: [], actions: [] }, new Set(), { code: 0 }).length)
  assert.ok(validateActions({ recommendations: [], actions: [] }, new Set(), { code: 1 }).length)
})

test('business conflicts belong to semantic review, not the structural action gate', () => {
  const { validateActions } = require('../src/enterprise-action-contract')
  const prior = { code: 1, time_range: '未来12个月' }
  const action = { id: 9, target: '旧产品', scope: 'overall', time_range: prior.time_range, action: '退出旧产品业务', effect: 'exit', readiness: 'conditional', prerequisites: ['履约义务已完成'], evidence_refs: ['E1'], direction_relation: '退出旧产品，将资源投向新产品拓展' }
  const c = { recommendations: [9], actions: [action], evidence_refs: ['E1'] }
  assert.deepEqual(validateActions(c, new Set(['E1']), prior), [])
  action.scope = 'partial'
  assert.deepEqual(validateActions(c, new Set(['E1']), prior), [])
  action.readiness = 'conditional'; action.prerequisites = []
  assert.ok(validateActions(c, new Set(['E1']), prior).some(x => x.includes('执行前提')))
})

test('identical option IDs with conflicting action scopes cannot freeze as agreement', () => {
  const candidates = [1,2,3,4,5].map((x) => ({ recommendations: [4], actions: [{ id: 4, target: '业务A', scope: 'partial', time_range: '未来12个月', effect: x === 5 ? 'decrease' : 'increase', readiness: 'ready' }], reason: '依据', gaps: [], evidence_refs: ['E1'] }))
  const frozen = freezeStage('condition', candidates, [], { code: 0, version: 'v1' }, { satisfied: true })
  assert.equal(frozen.code, null)
})

test('no-advice is preserved and cannot be delivered as an approved decision', async () => {
  const { root, caseData } = await fixture()
  const provider = fakeProvider()
  const decide = provider.enterpriseDecision.bind(provider)
  provider.enterpriseDecision = async input => {
    const value = await decide(input)
    return input.stage === 'condition' && !input.review ? { ...value, recommendations: [10], actions: [], label_assessments: [], gaps: ['执行能力存在重大冲突'], reason: '执行能力无法确认，不能形成可靠行动' } : value
  }
  const result = await runEnterpriseDecision({ caseData, provider, outputDirectory: root })
  assert.equal(result.status, 'awaiting_assistance')
  assert.deepEqual(result.report.决策建议.map(a => a.编号), [10])
  assert.equal(result.report.方向, 1)
})

test('semantic review selects an intact candidate, including its action details', async () => {
  const { root, caseData } = await fixture()
  const provider = fakeProvider()
  const decide = provider.enterpriseDecision.bind(provider)
  provider.enterpriseDecision = async input => {
    const value = await decide(input)
    if (input.stage === 'condition' && !input.review) value.actions[0].action = `采用${input.agent.agent_id}提出的具体回款计划`
    return value
  }
  provider.enterpriseReview = async ({stage,prompt}) => reviewResult({stage,prompt}, { consistent: true, selected_seat_id: stage === 'direction' ? 'demand_growth' : 'revenue_cost', unresolved_gaps: [] })
  const result = await runEnterpriseDecision({ caseData, provider, outputDirectory: root })
  assert.equal(result.status, 'approved')
  assert.equal(result.report.决策建议[0].action, '采用revenue_cost提出的具体回款计划')
  assert.equal(result.metadata.stages.condition.selected_seat_id, 'revenue_cost')
})

test('semantic conflict blocks delivery even when all option codes agree', async () => {
  const { root, caseData } = await fixture()
  const provider = fakeProvider()
  provider.enterpriseReview = async ({stage,prompt}) => reviewResult({stage,prompt}, { consistent: stage === 'direction', selected_seat_id: stage === 'direction' ? 'demand_growth' : null, unresolved_gaps: stage === 'direction' ? [] : ['行动范围重叠且前提冲突'] })
  const result = await runEnterpriseDecision({ caseData, provider, outputDirectory: root })
  assert.equal(result.status, 'awaiting_assistance')
  assert.equal(result.report.决策建议[0].编号, 10)
})

test('new evidence invalidates both stages and binds recommendations to the new direction version', async () => {
  const { root, caseData } = await fixture()
  const provider = fakeProvider()
  const decide = provider.enterpriseDecision.bind(provider)
  let rebased = false
  provider.enterpriseDecision = async input => {
    const value = await decide(input)
    return input.stage === 'condition' && !input.review && !rebased ? { ...value, recommendations: [10], actions: [], label_assessments: [], gaps: ['缺少新事实'], reason: '需补充证据' } : value
  }
  const result = await runEnterpriseDecision({ caseData, provider, outputDirectory: root, supplementalSearch: async () => {
    rebased = true
    const fresh = { ...caseData.evidence[1], id: 'E3', source_url: 'https://www.gov.cn/zhengce/e3', title: '新证据' }
    return { evidence: [fresh], snapshot_root: caseData.evidence_snapshot_root, status: 'collected' }
  } })
  assert.equal(result.status, 'approved')
  assert.equal(result.metadata.attempts.length, 2)
  assert.notEqual(result.metadata.attempts[0].direction_version, result.metadata.attempts[1].direction_version)
  assert.equal(result.metadata.stages.condition.prior_direction_version, result.metadata.stages.direction.version)
})

test('malformed model factors or actions are rejected with errors rather than crashing the gate', () => {
  const c = { recommendations: [4,9], actions: [null, { id: 9, scope: 'overall', action: 7 }], reason: '依据', evidence_refs: ['E1'], gaps: [], factors: [null], direction_version: 'bad' }
  let errors
  assert.doesNotThrow(() => { errors = validateCandidate(c, 'condition', new Set(['E1']), null) })
  assert.ok(errors.length)
})

test('one failed seat does not mark parallel successful seats failed or return before they finish', async () => {
  const f = await fixture()
  const p = fakeProvider()
  const original = p.enterpriseDecision.bind(p)
  const events = []
  p.enterpriseDecision = async args => {
    if (args.agent.agent_id === 'demand_growth') throw Object.assign(new Error('empty'), { code: 'MODEL_API_EMPTY_RESPONSE' })
    await new Promise(resolve => setTimeout(resolve, 15))
    return original(args)
  }
  await assert.rejects(runEnterpriseDecision({ caseData: f.caseData, question, provider: p, outputDirectory: f.root, onProgress: e => events.push(e) }), e => e.code === 'MODEL_API_EMPTY_RESPONSE' && e.agent_id === 'demand_growth')
  assert.equal(events.filter(e => e.type === 'agent_failed' && e.agent_id === 'demand_growth').length, 1)
  assert.equal(events.filter(e => e.type === 'agent_completed' && SEATS.direction.some(x => x[0] === e.agent_id)).length, 4)
  assert.ok(events.some(e => e.type === 'agent_completed' && e.agent_id === 'public_evidence_monitor'))
})

test('independent review can select a supported minority candidate after unresolved debate', async () => {
  const {root,caseData}=await fixture()
  const provider=fakeProvider({split:true,noProgress:true})
  provider.enterpriseReview=async ({stage,prompt})=>reviewResult({stage,prompt}, {consistent:true,selected_seat_id:stage==='direction'?'supply_competition':'technology_fit',unresolved_gaps:[]})
  const result=await runEnterpriseDecision({caseData,question,provider,outputDirectory:root})
  assert.equal(result.report.方向,0)
  assert.equal(result.metadata.stages.direction.selected_seat_id,'supply_competition')
  assert.equal(result.metadata.stages.direction.candidates.filter(c=>c.direction===1).length,4)
  assert.equal(result.status,'approved')
  assert.ok(result.metadata.graph_trace.some(e=>e.type==='evidence_recall'))
})

test('program preserves reviewer rejection even when text mentions optional internal data', async () => {
  const {root,caseData}=await fixture()
  const provider=fakeProvider()
  provider.enterpriseReview=async ({stage,prompt})=>reviewResult({stage,prompt}, {consistent:false,selected_seat_id:stage==='direction'?'demand_growth':'technology_fit',unresolved_gaps:['未提供单店利润及内部订单明细']})
  const result=await runEnterpriseDecision({caseData,question,provider,outputDirectory:root})
  assert.equal(result.status,'awaiting_assistance')
  assert.equal(result.metadata.stages.direction.semantic_review_original.consistent,false)
  assert.equal(result.metadata.stages.direction.semantic_review.consistent,false)
  assert.ok(result.metadata.stages.direction.gaps.some(x=>x.includes('单店利润')))
})

test('raw HTTP outputs traverse recovery, adapter, gate, semantic review and final JSON on both layers', async()=>{
  const {root,caseData}=await fixture()
  const {MultiModelProvider}=require('../src/providers/multi-model-provider')
  const f=fakeProvider({split:true})
  const traces=path.join(root,'raw-traces')
  const p=new MultiModelProvider({config:{contract_version:'1.0.0',profiles:{test:{provider:'openai_compatible',base_url:'https://model.example/v1',api_key:'test',model:'test',max_retries:0}}},environment:{LLM_OUTPUT_TRACE_ROOT:traces},fetchImpl:async(_url,init)=>{
    const msgs=JSON.parse(init.body).messages
    const req=JSON.parse(msgs.find(m=>m.role==='user').content)
    const method=req.operation
    const input=req.input
    let answer
    if(method==='enterpriseEvidenceScreen') answer=await f.enterpriseEvidenceScreen()
    else if(method==='enterpriseSemanticReview') answer=await f.enterpriseReview({stage:input.stage,prompt:input.prompt})
    else answer=await f.enterpriseDecision({agent:req.agent,stage:input.stage,prompt:input.prompt,review:method==='enterpriseDecisionReview'})
    return {ok:true,status:200,json:async()=>({choices:[{message:{content:'```json\n'+JSON.stringify(answer)+'\n```'}}]})}
  }})
  const provider={callForJson:async req=>{
    const payload=JSON.parse(req.prompt[1].content)
    const stage=payload.stage || (payload.frozen_direction ? 'condition':'direction')
    return p.callForJson({...req,agent:{...req.agent,model_profile:'test'},prompt:[{role:'user',content:JSON.stringify({operation:req.operation,agent:req.agent,input:{stage,prompt:req.prompt}})}]})
  }}
  const result=await runEnterpriseDecision({caseData,provider,outputDirectory:root})
  assert.equal(result.status,'approved')
  assert.equal(result.metadata.stages.direction.candidates.length,5)
  assert.equal(result.metadata.stages.condition.candidates.length,5)
  const events=result.metadata.graph_trace.filter(e=>e.type==='output_contract_reviewed')
  assert.ok(events.some(e=>e.phase==='seat_self_review'))
  const raw=await Promise.all((await fs.readdir(traces)).map(n=>fs.readFile(path.join(traces,n),'utf8').then(JSON.parse)))
  for(const event of events) {
    assert.ok(event.audit_paths.length)
    for(const file of event.audit_paths) {
      const audit=JSON.parse(await fs.readFile(file,'utf8'))
      assert.equal(audit.program_review.pass,true)
      assert.ok(raw.some(t=>t.call_id===audit.call_id&&t.raw_model_response===audit.raw_model_response))
      if(event.phase==='semantic_review') assert.equal(audit.semantic_review.consistent,true)
    }
  }
  const again=await runEnterpriseDecision({caseData,provider,outputDirectory:root})
  assert.ok(again.metadata.graph_trace.some(e=>e.type==='output_contract_reviewed'&&e.checkpoint.status==='reused'))
})

test('malformed raw output receives one visible bounded revision, never a hidden format repair',async()=>{
 const {root,caseData}=await fixture(), provider=fakeProvider()
 const base=provider.enterpriseDecision
 let calls=0
 provider.enterpriseDecision=async input=>{
   if(input.agent.agent_id==='demand_growth' && !input.review) {
     calls++
     if(calls===1) throw Object.assign(new Error('输出不是唯一JSON对象'),{code:'MODEL_SCHEMA_FAILURE',raw_model_response:'{} {}',call_id:'bad-call'})
     assert.match(input.prompt.at(-1).content,/\{\} \{\}/)
     assert.match(JSON.parse(input.prompt.at(-1).content).instruction,/第一层不要求第二层行动或冻结方向绑定/)
   }
   return base(input)
 }
 const result=await runEnterpriseDecision({caseData,provider,outputDirectory:root})
 assert.equal(result.status,'approved');assert.equal(calls,2)
 const event=result.metadata.graph_trace.find(e=>e.type==='output_contract_reviewed'&&e.agent_id==='demand_growth')
 assert.equal(event.audit_paths.length,2)
 const first=JSON.parse(await fs.readFile(event.audit_paths[0],'utf8'))
 assert.equal(first.raw_model_response,'{} {}');assert.equal(first.program_review.pass,false)
})

test('no-advice can explicitly report unavailable evidence without inventing factors',()=>{
 const value={recommendations:[10],actions:[],reason:'当前证据不足',evidence_refs:[],gaps:['证据不足以支持行动'],assumptions:[],factors:[],direction_version:'v1'}
 assert.deepEqual(validateCandidate(value,'condition',new Set(),{version:'v1',code:1}),[])
 const actual={...value,recommendations:[3]}
 assert.ok(validateCandidate(actual,'condition',new Set(),{version:'v1',code:1}).includes('有结论必须关联证据'))
})
test('malformed reference container returns contract errors rather than crashing gate',()=>{
 const action={id:3,target:'a',action:'b',scope:'overall',time_range:'未来12个月',direction_relation:'r',effect:'protect',readiness:'ready',prerequisites:[],evidence_refs:['E1']}
 assert.doesNotThrow(()=>validateCandidate({recommendations:[3],actions:[action],evidence_refs:{},reason:'r',gaps:[],factors:[],direction_version:'v1'},'condition',new Set(['E1']),{code:1,version:'v1'}))
})

test('direction reaches six rounds and condition reaches ten; changes are not stopped by code equality',async()=>{
 const {root,caseData}=await fixture(), provider=fakeProvider()
 const decide=provider.enterpriseDecision
 provider.enterpriseDecision=async args=>{
  if(!args.review) return decide(args)
  const input=JSON.parse(args.prompt[1].content)
  const candidate=structuredClone(input.own)
  candidate.reason=`修订依据，第${args.round}轮，由${args.agent.agent_id}提出`
  candidate.seat_summary=candidate.reason
  return exchangeResult(input,candidate)
 }
 const result=await runEnterpriseDecision({caseData,provider,outputDirectory:root})
 assert.equal(result.status,'approved')
 assert.equal(result.metadata.stages.direction.loop_rounds.length,6)
 assert.equal(result.metadata.stages.condition.loop_rounds.length,10)
 assert.equal(result.metadata.stages.direction.termination_reason,'round_limit')
 assert.equal(result.metadata.stages.condition.termination_reason,'round_limit')
 assert.equal(result.metadata.budgets.model_operations,93)
 const sessions=await Promise.all((await fs.readdir(path.join(root,'rulora-sessions'))).filter(n=>n.endsWith('.json')).map(n=>fs.readFile(path.join(root,'rulora-sessions',n),'utf8').then(JSON.parse)))
 const serialized=JSON.stringify(sessions)
 for(const stage of ['direction','condition']) {
  const frozen=result.metadata.stages[stage]
  assert.equal(frozen.seat_summaries.length,5)
  for(const summary of frozen.seat_summaries) {
   assert.ok(summary.summary.includes(stage==='direction'?'第6轮':'第10轮'))
   assert.ok(serialized.includes(summary.summary))
   assert.equal(summary.status,'active') // Hitting cap is not a false declaration of agreement.
  }
  const audit=JSON.parse(await fs.readFile(frozen.loop_rounds.at(-1).audit_path,'utf8'))
  assert.equal(audit.responses.length,5)
  assert.equal(audit.broadcast.length,5)
 }
})

test('one seat maintains its exact candidate; later peer revision reactivates it with four complete peers',async()=>{
 const {root,caseData}=await fixture(), provider=fakeProvider({split:true})
 const result=await runEnterpriseDecision({caseData,provider,outputDirectory:root})
 const layer=result.metadata.stages.direction
 const initial=layer.initial_candidates.find(c=>c.seat_id==='demand_growth')
 const final=layer.candidates.find(c=>c.seat_id==='demand_growth')
 assert.deepEqual(final,initial)
 assert.ok(result.metadata.graph_trace.some(e=>e.type==='seat_frozen'&&e.agent_id==='demand_growth'&&e.round===1))
 assert.ok(result.metadata.graph_trace.some(e=>e.type==='seat_reactivated'&&e.agent_id==='demand_growth'))
 assert.equal(layer.seat_summaries.find(s=>s.seat_id==='demand_growth').frozen_round,2)
 const audit=JSON.parse(await fs.readFile(layer.loop_rounds[1].audit_path,'utf8'))
 assert.equal(audit.broadcast.find(c=>c.seat_id==='supply_competition').direction,1)
 assert.equal(layer.termination_reason,'all_seats_frozen')
})

test('out-of-authority reviewer result goes directly to human without supplemental search',async()=>{
 const {root,caseData}=await fixture(), provider=fakeProvider()
 let searched=0
 provider.enterpriseReview=async args=>reviewResult(args,{consistent:false,selected_seat_id:null,authority:'requires_human',applied_rule_ids:[],unresolved_gaps:['规则之间冲突，需要人工确定优先级'],review_reason:'没有被授权决定规则优先级'})
 const result=await runEnterpriseDecision({caseData,provider,outputDirectory:root,supplementalSearch:async()=>{searched++;return {evidence:[]}}})
 assert.equal(searched,0)
 assert.equal(result.status,'awaiting_assistance')
 assert.equal(result.metadata.stages.direction.requires_human_confirmation,true)
 assert.equal(result.metadata.stages.condition.seat_summaries.length,0)
 assert.ok(result.gaps.some(g=>g.includes('规则')))
})

test('second layer retains an entire three-action set and its per-label assessments',async()=>{
 const {root,caseData}=await fixture(), provider=fakeProvider()
 const decide=provider.enterpriseDecision
 provider.enterpriseDecision=async args=>{
  const value=await decide(args)
  if(args.review||args.stage!=='condition')return value
  value.recommendations=[3,6,8]
  value.actions=[3,6,8].map(id=>({...value.actions[0],id,action:`行动${id}`,target:`作用对象${id}`}))
  return enrichCandidate(value,'condition')
 }
 const result=await runEnterpriseDecision({caseData,provider,outputDirectory:root})
 assert.equal(result.status,'approved')
 assert.deepEqual(result.report.决策建议.map(a=>a.编号),[3,6,8])
 for(const seat of result.metadata.stages.condition.seat_summaries)assert.equal(seat.label_assessments.length,3)
 assert.equal(result.metadata.stages.condition.loop_rounds.length,1)
 assert.ok(result.metadata.stages.condition.semantic_review.candidate_reviews.every(r=>r.action_reviews.length===3))
})
test('review returns optional action to its original seat, rebroadcasts and selects revised candidate within cap',async()=>{
 const {root,caseData}=await fixture();const provider=fakeProvider();const original=provider.enterpriseDecision.bind(provider);let returnSeen=false,rebroadcastSeen=false,conditionReviews=0
 provider.enterpriseDecision=async args=>{
  const input=JSON.parse(args.prompt[1].content)
  if(args.stage==='condition'&&args.review){
   if(input.reviewer_feedback){returnSeen=true;const c=structuredClone(input.own);c.recommendations=[3];c.actions=c.actions.filter(a=>a.id===3);c.label_assessments=c.label_assessments.filter(a=>a.code===3);c.combination_reason='核实后单项已充分';return exchangeResult(input,c)}
   if(input.differences.some(c=>c.seat_id==='technology_fit'&&c.withdrawn_actions?.some(a=>a.action==='有条件调整投入')))rebroadcastSeen=true
   return exchangeResult(input)
  }
  const c=await original(args)
  if(args.stage==='condition'){c.recommendations=[3,4];c.actions.push({...c.actions[0],id:4,decision_object:'new_investment',commitment_status:'uncommitted',action:'有条件调整投入'});c.label_assessments.push({...c.label_assessments[0],code:4})}
  return c
 }
 provider.enterpriseReview=async args=>{
  if(args.stage==='direction')return reviewResult(args)
  conditionReviews++
  if(conditionReviews===1){const v=reviewResult(args,{consistent:false,selected_seat_id:null,revision_requests:[{seat_id:'technology_fit',action_ids:[4],reason:'删除投入建议后是否仍能完成现金风险处置？'}]});return v}
  return reviewResult(args)
 }
 const result=await runEnterpriseDecision({caseData,question,provider,outputDirectory:root})
 assert.equal(result.status,'approved');assert(returnSeen);assert(rebroadcastSeen);assert.equal(conditionReviews,2)
 assert.deepEqual(result.report.决策建议.map(x=>x.编号),[3]);assert.equal(result.metadata.stages.condition.initial_candidates[0].recommendations.length,2)
 assert.equal(result.metadata.stages.condition.review_history.length,2);assert(result.metadata.stages.condition.loop_rounds.length<=10)
})
test('repeated reviewer repair requests stop after one return without forced cropping',async()=>{
 const {root,caseData}=await fixture();const provider=fakeProvider();let count=0
 provider.enterpriseReview=async args=>{if(args.stage==='direction')return reviewResult(args);count++;return reviewResult(args,{consistent:false,selected_seat_id:null,revision_requests:[{seat_id:'technology_fit',action_ids:[3],reason:'必要性仍不能确认'}]})}
 const result=await runEnterpriseDecision({caseData,question,provider,outputDirectory:root,config:{max_exchange_rounds:{direction:6,condition:10},max_search_rounds:0,max_model_operations:100}})
 assert.equal(count,2);assert.equal(result.status,'awaiting_assistance');assert.equal(result.metadata.stages.condition.requires_human_confirmation,true)
})
test('review cannot reopen a layer after its configured exchange budget is exhausted',async()=>{
 const {root,caseData}=await fixture();const provider=fakeProvider();let conditionReviews=0
 provider.enterpriseReview=async args=>{if(args.stage==='direction')return reviewResult(args);conditionReviews++;return reviewResult(args,{consistent:false,selected_seat_id:null,revision_requests:[{seat_id:'technology_fit',action_ids:[3],reason:'必要性待确认'}]})}
 const result=await runEnterpriseDecision({caseData,question,provider,outputDirectory:root,config:{max_exchange_rounds:{direction:1,condition:1},max_search_rounds:0,max_model_operations:100}})
 assert.equal(conditionReviews,1);assert.equal(result.status,'awaiting_assistance');assert.equal(result.metadata.stages.condition.loop_rounds.length,1)
})

test('all eleven distinct necessary options survive exchange, review, Rulora and report schema without truncation', async()=>{
 const {root,caseData}=await fixture();const provider=fakeProvider(),original=provider.enterpriseDecision
 provider.enterpriseDecision=async args=>{const c=await original(args);if(args.stage==='condition'&&!args.review){c.recommendations=[1,2,3,4,5,6,7,8,9,11,12];c.actions=c.recommendations.map(id=>({...c.actions[0],id,...(require('../src/enterprise-action-contract').OBJECT_BOUNDARIES[id]||{}),action:`执行已论证的行动${id}`}));c.label_assessments=c.recommendations.map(code=>({code,necessary:true,why_required:['对应关键目标'],evidence_refs:c.evidence_refs}));delete c.combination_reason}return c}
 const result=await runEnterpriseDecision({caseData,provider,outputDirectory:root})
 assert.equal(result.status,'approved');assert.deepEqual(result.report.决策建议.map(a=>a.编号),[1,2,3,4,5,6,7,8,9,11,12])
 assert.equal(result.metadata.stages.condition.initial_candidates[0].recommendations.length,11)
 assert.ok(result.metadata.attempts[0].rulora_snapshot_sha256)
})

test('live graph passes one shared necessity standard to all five initial seats, exchanges and final reviewer', async()=>{
 const f=await fixture(),provider=fakeProvider(),d=require('../src/enterprise-deliberation'),seen=[]
 for(const name of ['enterpriseDecision','enterpriseReview']){
  const invoke=provider[name].bind(provider)
  provider[name]=async args=>{
   const input=JSON.parse(args.prompt[1].content)
   if(args.stage==='condition'){
    assert.deepEqual(input.necessity_policy,d.NECESSITY_POLICY)
    assert.equal(args.prompt[1].content.split('"necessity_policy"').length-1,1)
    seen.push({operation:name,review:args.review,seat:args.agent?.agent_id})
   }else assert.equal(input.necessity_policy,undefined)
   return invoke(args)
  }
 }
 const result=await runEnterpriseDecision({caseData:f.caseData,provider,outputDirectory:f.root})
 assert.equal(result.status,'approved')
 assert.equal(seen.filter(x=>x.operation==='enterpriseDecision'&&!x.review).length,5)
 assert.equal(seen.filter(x=>x.operation==='enterpriseDecision'&&x.review).length,5)
 assert.equal(seen.filter(x=>x.operation==='enterpriseReview').length,1)
})

test('unchanged decision resumes both layers without volatile audit fields invalidating checkpoints', async () => {
  const { root, caseData } = await fixture()
  const provider = fakeProvider()
  const first = await runEnterpriseDecision({caseData,question,provider,outputDirectory:root})
  const calls = provider.calls.length
  const second = await runEnterpriseDecision({caseData,question,provider,outputDirectory:root})
  assert.equal(second.status,'approved')
  assert.equal(provider.calls.length,calls,'all completed model calls must be reused for identical inputs')
  assert.equal(second.metadata.direction_version,first.metadata.direction_version)
  assert.equal(second.metadata.condition_version,first.metadata.condition_version)
})

test('screening limitations do not become source-gate blockers or supplemental search targets', async()=>{
 const {root,caseData}=await fixture()
 const provider=fakeProvider()
 const queries=[]
 provider.enterpriseEvidenceScreen=async({prompt})=>{
  assert.match(prompt[0].content,/查不到的企业内部信息/)
  return {relevant_evidence_ids:['E1'],reasons_by_id:{E1:'企业披露'},gaps:['缺少供应商集中度、内部订单及量化预测'],analysis_limitations:['未取得内部明细']}
 }
 const result=await runEnterpriseDecision({caseData,question,provider,outputDirectory:root,supplementalSearch:async({gaps})=>{queries.push(...gaps);return {evidence:[],status:'no_new_relevant_evidence'}}})
 assert.equal(result.status,'awaiting_assistance')
 assert.deepEqual(result.metadata.evidence_processing.source_gate.gaps,['整份相关证据集不足两个独立来源'])
 assert(queries.every(g=>!g.includes('供应商')&&!g.includes('内部明细')))
 assert(!result.gaps.some(g=>g.includes('供应商')))
 assert(result.metadata.evidence_processing.source_gate.screening_notes.some(g=>g.includes('供应商')))
})

test('two relevant sources permit both decision layers despite screening internal-data limitations',async()=>{
 const {root,caseData}=await fixture()
 const provider=fakeProvider()
 const original=provider.enterpriseEvidenceScreen
 provider.enterpriseEvidenceScreen=async args=>({...await original(args),gaps:['未取得在手订单及精确合规成本'],analysis_limitations:['无法量化未来预测']})
 const result=await runEnterpriseDecision({caseData,question,provider,outputDirectory:root})
 assert.equal(result.status,'approved')
 assert.deepEqual(result.metadata.evidence_processing.source_gate.gaps,[])
 assert(result.metadata.evidence_processing.source_gate.analysis_limitations.includes('无法量化未来预测'))
})

test('reference typo revision receives exact field path, wrong value and allowed identifiers',async()=>{
 const {root,caseData}=await fixture(),provider=fakeProvider(),base=provider.enterpriseDecision
 let attempts=0
 provider.enterpriseDecision=async input=>{
  const result=await base(input)
  if(input.agent.agent_id==='enterprise_operations'&&!input.review){
   attempts++
   const payload=JSON.parse(input.prompt[1].content)
   assert.deepEqual(payload.allowed_evidence_ids,[1,2])
   if(attempts===1){result.evidence_refs=['E9'];result.factors[0].evidence_refs=['E9'];return result}
   const errors=JSON.parse(input.prompt.at(-1).content).program_errors
   const diagnostic=JSON.parse(errors.find(e=>e.startsWith('证据引用诊断')).split('：').slice(1).join('：'))
   assert(diagnostic.invalid_refs.some(r=>r.path==='evidence_refs[0]'&&r.value==='E9'))
   assert(diagnostic.invalid_refs.some(r=>r.path==='factors[0].evidence_refs[0]'&&r.value==='E9'))
   assert.deepEqual(diagnostic.allowed_evidence_ids,[1,2])
  }
  return result
 }
 const result=await runEnterpriseDecision({caseData,provider,outputDirectory:root})
 assert.equal(result.status,'approved');assert.equal(attempts,2)
 const event=result.metadata.graph_trace.find(e=>e.type==='output_contract_reviewed'&&e.agent_id==='enterprise_operations')
 const rejected=JSON.parse(await fs.readFile(event.audit_paths[0],'utf8'))
 assert.deepEqual(rejected.adapter_result.evidence_refs,['E9'],'audit preserves wrong raw references')
})

test('reference diagnostic distinguishes unregistered IDs from child refs omitted in the candidate list',()=>{
 const {evidenceReferenceDiagnostic}=require('../src/enterprise-decision')
 const value={evidence_refs:['E1'],factors:[{evidence_refs:['E9']}],actions:[{evidence_refs:['E2']}],label_assessments:[{evidence_refs:['E2']}]}
 const d=evidenceReferenceDiagnostic(value,new Set(['E1','E2']))
 assert.deepEqual(d.invalid_refs,[{path:'factors[0].evidence_refs[0]',value:'E9'}])
 assert.equal(d.outside_candidate_refs.length,2)
 assert.deepEqual(value.actions[0].evidence_refs,['E2'])
})


test('full two-layer loop selects numeric references and program carries canonical IDs and versions',async()=>{
 const {root,caseData}=await fixture(),provider=fakeProvider()
 const {transform}=require('../src/enterprise-reference-binding')
 const registry={entries:[{selector:1,id:'E1'},{selector:2,id:'E2'}]}
 const screen=provider.enterpriseEvidenceScreen,seat=provider.enterpriseDecision
 provider.enterpriseEvidenceScreen=async request=>transform(await screen(request),registry)
 provider.enterpriseDecision=async request=>{
   const value=transform(await seat(request),registry)
   delete value.broadcast_version
   const candidate=value.candidate || value
   delete candidate.direction_version
   delete candidate.evidence_refs
   return value
 }
 const result=await runEnterpriseDecision({caseData,provider,outputDirectory:root})
 assert.equal(result.status,'approved')
 const reviews=result.metadata.graph_trace.filter(e=>e.type==='output_contract_reviewed'&&['seat_initial','seat_self_review'].includes(e.phase))
 assert(reviews.length>=20)
 for(const event of reviews){
  const audit=JSON.parse(await fs.readFile(event.audit_paths[0],'utf8'))
  assert.equal(audit.program_review.pass,true)
  assert.equal(audit.reference_binding.entries[0].id,'E1')
  assert(audit.normalization_operations.some(x=>x.type==='DETERMINISTIC_REFERENCE_BINDING'))
  const value=audit.adapter_result.candidate || audit.adapter_result
  if(value.factors) assert(value.evidence_refs.every(id=>typeof id==='string'))
  if(value.recommendations) assert.equal(typeof value.direction_version,'string')
 }
})

test('wording-only updates are retained without reactivating other seats or repeating broadcasts',async()=>{
 const {root,caseData}=await fixture(),provider=fakeProvider(),original=provider.enterpriseDecision
 provider.enterpriseDecision=async args=>{
  if(!args.review)return original(args)
  const input=JSON.parse(args.prompt[1].content),candidate=structuredClone(input.own)
  candidate.reason='改进可读性后的原判断';candidate.seat_summary=candidate.reason
  return {...exchangeResult(input,candidate),revision_kind:'wording_only'}
 }
 const result=await runEnterpriseDecision({caseData,provider,outputDirectory:root})
 assert.equal(result.status,'approved')
 for(const stage of ['direction','condition']){
  assert.equal(result.metadata.stages[stage].loop_rounds.length,1)
  assert.equal(result.metadata.stages[stage].termination_reason,'all_seats_frozen')
  assert(result.metadata.stages[stage].seat_summaries.every(x=>x.summary==='改进可读性后的原判断'))
 }
 assert(!result.metadata.graph_trace.some(x=>x.type==='seat_reactivated'))
})
test('one grounded lens-specific addition reaches peers once without forcing matching combinations',async()=>{
 const {root,caseData}=await fixture(),provider=fakeProvider(),original=provider.enterpriseDecision
 let sawDelta=false,sawReviewBasis=false
 provider.enterpriseDecision=async args=>{
  if(!args.review)return original(args)
  const input=JSON.parse(args.prompt[1].content)
  if(args.stage==='condition'&&args.agent.agent_id==='technology_fit'&&args.round===1){
   const candidate=structuredClone(input.own)
   candidate.recommendations.push(4);candidate.actions.push({...candidate.actions[0],id:4,decision_object:'new_investment',commitment_status:'uncommitted',action:'针对新增技术项目设置阶段投入闸门'})
   candidate.label_assessments.push({...candidate.label_assessments[0],code:4,why_required:['存量回款不能约束新增技术项目现金承诺']})
   return {...exchangeResult(input,candidate),addition_basis:[{code:4,lens_gap:'本席新增技术项目的资金承诺',why_existing_insufficient:'既有现金回收措施未覆盖新增项目放行',evidence_refs:candidate.evidence_refs}]}
  }
  if(args.stage==='condition'&&args.round===2&&args.agent.agent_id!=='technology_fit'){
   assert.equal(input.differences.length,4)
   const changed=input.differences.filter(x=>!x.unchanged)
   assert.equal(changed.length,1);assert.equal(changed[0].seat_id,'technology_fit')
   assert(input.differences.filter(x=>x.unchanged).every(x=>x.actions===undefined&&x.seat_summary===undefined))
   sawDelta=true
  }
  return exchangeResult(input)
 }
 const review=provider.enterpriseReview
 provider.enterpriseReview=async args=>{
  if(args.stage==='condition'){
   const input=JSON.parse(args.prompt[1].content),tech=input.candidates.find(c=>c.seat_id===(args.prompt.reference_binding.candidate_entries.find(x=>x.id==='technology_fit')?.alias || 'technology_fit'))
   assert.equal(tech.addition_basis[0].code,4);assert.equal(tech.seat_lens,undefined);sawReviewBasis=true
  }
  return review(args)
 }
 const result=await runEnterpriseDecision({caseData,provider,outputDirectory:root})
 assert.equal(result.status,'approved');assert(sawDelta);assert(sawReviewBasis)
 assert.deepEqual(result.report.决策建议.map(x=>x.编号),[3,4])
 const layer=result.metadata.stages.condition
 assert.deepEqual(layer.candidates.find(c=>c.seat_id==='technology_fit').recommendations,[3,4])
 assert(layer.candidates.filter(c=>c.seat_id!=='technology_fit').every(c=>JSON.stringify(c.recommendations)==='[3]'))
 assert.equal(layer.loop_rounds.length,2)
})
test('review returns only the named seat when its correction leaves peer content unchanged',async()=>{
 const {root,caseData}=await fixture(),provider=fakeProvider(),original=provider.enterpriseDecision,seen=[]
 let reviews=0
 provider.enterpriseDecision=async args=>{
  if(args.stage==='condition'&&args.review)seen.push({seat:args.agent.agent_id,round:args.round})
  return original(args)
 }
 provider.enterpriseReview=async args=>{
  if(args.stage==='direction')return reviewResult(args)
  reviews++
  return reviews===1 ? reviewResult(args,{consistent:false,selected_seat_id:null,revision_requests:[{seat_id:'technology_fit',action_ids:[3],reason:'核对此项独立必要性'}]}) : reviewResult(args)
 }
 const result=await runEnterpriseDecision({caseData,provider,outputDirectory:root})
 assert.equal(result.status,'approved');assert.equal(reviews,2)
 assert.equal(seen.filter(x=>x.round===1).length,5)
 assert.deepEqual(seen.filter(x=>x.round===2).map(x=>x.seat),['technology_fit'])
})

test('misplaced exchange metadata traverses adapter, reference gate, review and checkpoint resume',async()=>{
 const {root,caseData}=await fixture(),provider=fakeProvider(),original=provider.enterpriseDecision
 let exchangeCalls=0
 provider.enterpriseDecision=async args=>{
  if(!args.review)return original(args)
  const input=JSON.parse(args.prompt[1].content),candidate=structuredClone(input.own)
  exchangeCalls++
  candidate.revision_kind='wording_only';candidate.reason='只改善展示文字';candidate.seat_summary=candidate.reason
  const response=exchangeResult(input,candidate);delete response.revision_kind
  return response
 }
 const result=await runEnterpriseDecision({caseData,provider,outputDirectory:root})
 assert.equal(result.status,'approved')
 const events=result.metadata.graph_trace.filter(e=>e.type==='output_contract_reviewed'&&e.phase==='seat_self_review')
 for(const event of events){
  const audit=JSON.parse(await fs.readFile(event.audit_paths[0],'utf8'))
  assert.equal(audit.adapter_result.revision_kind,'wording_only');assert(!Object.hasOwn(audit.adapter_result.candidate,'revision_kind'))
  assert(audit.normalization_operations.some(op=>op.from==='candidate.revision_kind'))
  assert.equal(JSON.parse(audit.raw_model_response).candidate.revision_kind,'wording_only')
  assert.equal(audit.program_review.pass,true)
 }
 const beforeCalls=provider.calls.length,beforeExchanges=exchangeCalls
 const cached=await runEnterpriseDecision({caseData,provider,outputDirectory:root})
 assert.equal(cached.status,'approved');assert.equal(provider.calls.length,beforeCalls);assert.equal(exchangeCalls,beforeExchanges)
 assert(cached.metadata.graph_trace.filter(e=>e.type==='output_contract_reviewed').every(e=>e.checkpoint.status==='reused'))
})
test('a format-only review retry cannot silently change the selected complete candidate',async()=>{
 const {root,caseData}=await fixture(),provider=fakeProvider();let reviews=0
 provider.enterpriseReview=async args=>{
  if(args.stage==='direction')return reviewResult(args)
  if(reviews===2){const fresh=JSON.parse(args.prompt.at(-1).content);assert.equal(fresh.revision_mode,'fresh_reassessment');assert(!Object.hasOwn(fresh,'previous_output'))}
  reviews++;return reviews===1?{...reviewResult(args),unknown_format_field:'remove me'}:reviewResult(args,{selected_seat_id:'chain_risk'})
 }
 const result=await runEnterpriseDecision({caseData,provider,outputDirectory:root})
 assert.equal(result.status,'approved');assert.equal(reviews,3)
 const audits=await Promise.all((await fs.readdir(root)).filter(f=>f.includes('semantic_review-enterprise_semantic_reviewer')).map(async f=>JSON.parse(await fs.readFile(path.join(root,f),'utf8'))))
 const drift=audits.find(x=>x.verdict_drift);assert(drift);assert.equal(drift.program_review.pass,false);assert.equal(drift.revision_mode,'format_only');assert.equal(drift.verdict_drift.previous.selected_seat_id,'technology_fit');assert.equal(drift.verdict_drift.revised.selected_seat_id,'chain_risk')
 const fresh=audits.find(x=>x.revision_mode==='fresh_reassessment');assert(fresh);assert.equal(fresh.attempt,2);assert.equal(fresh.program_review.pass,true)
})
test('a fresh assessment still failing its gate stops after three review calls',async()=>{
 const {root,caseData}=await fixture(),provider=fakeProvider();let reviews=0
 provider.enterpriseReview=async args=>{
  if(args.stage==='direction')return reviewResult(args)
  reviews++
  if(reviews===1)return {...reviewResult(args),unknown_format_field:'remove'}
  if(reviews===2)return reviewResult(args,{selected_seat_id:'chain_risk'})
  return {...reviewResult(args),unknown_format_field:'still invalid'}
 }
 await assert.rejects(runEnterpriseDecision({caseData,provider,outputDirectory:root}),{code:'ENTERPRISE_MODEL_CONTRACT_INVALID'})
 assert.equal(reviews,3)
})


test('v68 retains structured direction comparison without an extra reviewer return round',async()=>{
 const {root,caseData}=await fixture(),provider=fakeProvider({split:true,noProgress:true});let reviews=0;
 provider.enterpriseReview=async args=>{const input=JSON.parse(args.prompt[1].content);if(args.stage!=='direction')return reviewResult(args);reviews++;assert(input.direction_policy);assert(input.exchange_reviews.length);assert(input.candidate_selection_policy);return reviewResult(args,{selected_seat_id:'supply_competition'})};
 const result=await runEnterpriseDecision({caseData,question,provider,outputDirectory:root});assert.equal(result.status,'approved');assert.equal(reviews,1);assert.equal(result.metadata.stages.direction.loop_rounds.length,1);assert.equal(result.metadata.stages.direction.code,0);
});
test('v68 delivers the same counterfactual standard to condition initial, exchange and review',async()=>{
 const {root,caseData}=await fixture(),provider=fakeProvider();const original=provider.enterpriseDecision,policies=[];
 provider.enterpriseDecision=async args=>{if(args.stage==='condition')policies.push(JSON.parse(args.prompt[1].content).necessity_policy);return original(args)};
 provider.enterpriseReview=async args=>{if(args.stage==='condition')policies.push(JSON.parse(args.prompt[1].content).necessity_policy);return reviewResult(args)};
 await runEnterpriseDecision({caseData,question,provider,outputDirectory:root});assert.equal(policies.length,11);for(const p of policies){assert(p.countercheck);assert(p.deduplication);assert.deepEqual(p,policies[0])}
});

test('v69 production pipeline cannot approve unknown-only necessity after bounded reassessment',async()=>{
 const {root,caseData}=await fixture(),provider=fakeProvider();let attempts=0
 provider.enterpriseReview=async args=>{
  const result=reviewResult(args)
  if(args.stage==='condition'){
   attempts++
   result.candidate_reviews.find(r=>r.seat_id===result.selected_seat_id).action_reviews[0].basis_status='unknown_only'
  }
  return result
 }
 await assert.rejects(runEnterpriseDecision({caseData,provider,outputDirectory:root}),e=>e.code==='ENTERPRISE_MODEL_CONTRACT_INVALID'&&e.message.includes('仅由未知'))
 assert.equal(attempts,2)
});
test('v75 missing review fields are filled without silently changing source verdict; known unknown goes to business reassessment',async()=>{
 for(const scenario of ['missing','unknown']){
  const {root,caseData}=await fixture(),provider=fakeProvider();let conditionCalls=0
  provider.enterpriseReview=async args=>{
   if(args.stage==='direction')return reviewResult(args)
   conditionCalls++
   if(conditionCalls===2){const feedback=JSON.parse(args.prompt.at(-1).content);assert.equal(feedback.revision_mode,scenario==='missing'?'format_only':'business_reassessment')}
   const result=reviewResult(args)
   if(conditionCalls===1){
    const selected=result.candidate_reviews.find(r=>r.seat_id===result.selected_seat_id)
    if(scenario==='missing'){
     for(const r of result.candidate_reviews){for(const a of r.action_reviews)delete a.residual_risk_source;delete r.comparison_to_selected.alternative_object}
    }else selected.action_reviews[0].residual_risk_source='unknown_sufficiency'
   }
   return result
  }
  const result=await runEnterpriseDecision({caseData,provider,outputDirectory:root})
  assert.equal(result.status,'approved');assert.equal(conditionCalls,2)
  const review=result.metadata.stages.condition.semantic_review,selected=review.candidate_reviews.find(r=>r.seat_id===review.selected_seat_id)
  assert(selected.action_reviews.every(a=>a.residual_risk_source==='known_fact'))
  assert.equal(result.metadata.stages.condition.actions.length,result.metadata.stages.condition.candidates.find(c=>c.seat_id===review.selected_seat_id).actions.length)
  const audits=await Promise.all((await fs.readdir(root)).filter(f=>f.includes('semantic_review-enterprise_semantic_reviewer')).map(async f=>JSON.parse(await fs.readFile(path.join(root,f),'utf8'))))
  assert(audits.some(a=>a.revision_mode===(scenario==='missing'?'format_only':'business_reassessment')&&a.program_review.pass))
 }
})

function noMeasuresCandidate(value) {
 return {...value,recommendations:[13],actions:[],label_assessments:[],gaps:[],reason:'已公开安排足以执行冻结方向，无需新增措施',seat_summary:'已有安排经证据核对，当前无需新增措施',no_action_basis:{existing_arrangements:[{arrangement:'已公开批准并实施的经营安排',evidence_refs:[...value.evidence_refs]}],why_sufficient:'现有安排已处理本席位有证据的关键问题，不需要独立新增动作',direction_relation:'沿用已有安排执行冻结的整体经营方向'}}
}
for(const direction of [-1,0,1]) test(`explicit no-new-measures code delivers under direction ${direction} only after evidence binding and review`,async()=>{
 const {root,caseData}=await fixture(),provider=fakeProvider(),original=provider.enterpriseDecision
 provider.enterpriseDecision=async args=>{
  const c=await original(args)
  if(args.review)return c
  if(args.stage==='direction')return {...c,direction}
  const out=noMeasuresCandidate(c)
  const {transform}=require('../src/enterprise-reference-binding')
  // Real wire uses numeric selectors; program binds IDs, including arrangements.
  delete out.evidence_refs
  return transform(out,{entries:[{selector:1,id:'E1'},{selector:2,id:'E2'}]})
 }
 const result=await runEnterpriseDecision({caseData,provider,outputDirectory:root})
 assert.equal(result.status,'approved');assert.equal(result.report.方向,direction)
 assert.deepEqual(result.report.决策建议.map(a=>a.编号),[13])
 assert.deepEqual(result.metadata.stages.condition.code,[13]);assert.deepEqual(result.metadata.stages.condition.actions,[])
 assert.equal(result.metadata.action_options_version,'3.0.0-object-boundaries')
 const selected=result.metadata.stages.condition.candidates.find(c=>c.seat_id===result.metadata.stages.condition.selected_seat_id)
 assert.deepEqual(selected.no_action_basis,result.metadata.stages.condition.no_action_basis)
 assert(selected.no_action_basis.existing_arrangements[0].evidence_refs.every(id=>['E1','E2'].includes(id)))
 assert.equal(result.metadata.stages.condition.action_history.length,0,'13 is a verdict, not an added action')
 const run=JSON.parse(await fs.readFile(result.artifacts.run_json,'utf8'))
 assert.equal(run.status,'approved')
 const {buildReport}=require('../src/enterprise-decision')
 assert.throws(()=>buildReport(result.metadata.stages.direction,{...result.metadata.stages.condition,semantic_review:null}),/未经绑定候选/)
})
test('empty or missing model recommendations never become code13 during recovery, adapter or retry',async()=>{
 const {root,caseData}=await fixture(),provider=fakeProvider(),original=provider.enterpriseDecision;let attempts=0
 provider.enterpriseDecision=async args=>{
  const c=await original(args)
  if(args.stage==='condition'&&!args.review&&args.agent.agent_id==='technology_fit'){
   attempts++;if(attempts===1)return {...c,recommendations:[],actions:[],label_assessments:[]}
   assert(args.prompt.at(-1).content.includes('非空整数数组'))
   return noMeasuresCandidate(c)
  }
  return args.stage==='condition'&&!args.review?noMeasuresCandidate(c):c
 }
 const result=await runEnterpriseDecision({caseData,provider,outputDirectory:root})
 assert.equal(attempts,2);assert.equal(result.status,'approved')
 const event=result.metadata.graph_trace.find(e=>e.type==='output_contract_reviewed'&&e.agent_id==='technology_fit')
 const rejected=JSON.parse(await fs.readFile(event.audit_paths[0],'utf8'))
 assert.deepEqual(rejected.adapter_result.recommendations,[])
 assert.equal(rejected.program_review.pass,false)
})
test('unsupported no-new-measures review cannot silently approve, even with no action reviews',async()=>{
 const {root,caseData}=await fixture(),provider=fakeProvider(),original=provider.enterpriseDecision
 provider.enterpriseDecision=async args=>{const c=await original(args);return args.stage==='condition'&&!args.review?noMeasuresCandidate(c):c}
 provider.enterpriseReview=async args=>{
  const r=reviewResult(args)
  if(args.stage==='condition')for(const row of r.candidate_reviews)row.no_action_review.assessment='uncertain'
  return r
 }
 await assert.rejects(runEnterpriseDecision({caseData,provider,outputDirectory:root}),{code:'ENTERPRISE_MODEL_CONTRACT_INVALID'})
})
test('seat repair gets one extra bounded attempt only for changed errors, not a repeated failure',async()=>{
 for(const changed of [true,false]){
  const {root,caseData}=await fixture(),provider=fakeProvider(),original=provider.enterpriseDecision.bind(provider);let attempts=0
  provider.enterpriseDecision=async args=>{
   const v=await original(args)
   if(args.stage==='condition' && !args.review && args.agent.agent_id==='technology_fit'){
    attempts++
    if(attempts===1 || !changed)v.factors[0].counter_evidence_refs=['invalid-reference']
    else if(attempts===2)v.label_assessments[0].counter_evidence=[999]
   }
   return v
  }
  if(changed){const result=await runEnterpriseDecision({caseData,provider,outputDirectory:root});assert.equal(result.status,'approved');assert.equal(attempts,3)}
  else{await assert.rejects(runEnterpriseDecision({caseData,provider,outputDirectory:root}),e=>e.code==='ENTERPRISE_MODEL_CONTRACT_INVALID');assert.equal(attempts,2)}
 }
})
test('review action list returned as object is repaired through the contract loop, not an uncaught TypeError',async()=>{
 const {root,caseData}=await fixture(),provider=fakeProvider();let calls=0
 provider.enterpriseReview=async args=>{
  const result=reviewResult(args)
  if(args.stage==='condition'){
   calls++
   if(calls===1)result.candidate_reviews.find(r=>r.seat_id===result.selected_seat_id).action_reviews={id:3}
  }
  return result
 }
 const result=await runEnterpriseDecision({caseData,provider,outputDirectory:root})
 assert.equal(result.status,'approved');assert.equal(calls,2)
})
