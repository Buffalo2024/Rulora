const { ProviderSupervisor } = require('../src/provider-supervisor')
const test = require('node:test'), assert = require('node:assert/strict')
const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path')
const { recoverEnterpriseOutput: recover, adaptEnterpriseOutput: adapt, usesEnterpriseProtocol } = require('../src/enterprise-output-protocol')
const { MultiModelProvider } = require('../src/providers/multi-model-provider')
test('identical action copies normalize once in initial and exchange outputs, preserving raw decisions', () => {
 const action={id:1,target:'对象',action:'措施',evidence_refs:[1]}
 for(const wrapped of [false,true]) {
  const candidate={recommendations:[1],actions:[action,structuredClone(action)]}
  const raw=wrapped?{review_decision:'revise',candidate}:candidate
  const out=adapt(raw,{operation:wrapped?'enterpriseDecisionReview':'enterpriseDecision'})
  const value=wrapped?out.value.candidate:out.value
  assert.equal(value.actions.length,1);assert.equal(candidate.actions.length,2)
  assert.deepEqual(value.recommendations,[1]);assert.equal(out.operations.filter(x=>x.operation==='remove_exact_duplicate_action').length,1)
  assert.equal(adapt(out.value).operations.filter(x=>x.operation==='remove_exact_duplicate_action').length,0)
 }
})
test('different same-id actions remain conflicts, including references that decode to the same value',()=>{
 const binding={entries:[{selector:1,id:'registered'}]}
 for(const second of [{id:1,action:'different',evidence_refs:[1]},{id:1,action:'same',evidence_refs:['registered']}]) {
  const out=adapt({recommendations:[1],actions:[{id:1,action:'same',evidence_refs:[1]},second]},{referenceBinding:binding})
  assert.equal(out.value.actions.length,2);assert(!out.operations.some(x=>x.operation==='remove_exact_duplicate_action'))
 }
})
test('recovery and identity adapter preserve negative verdicts, unknown enums and missing fields', () => {
 const original = { consistent: false, unresolved_gaps: ['内部订单未披露'], direction: '拓展' }
 assert.deepEqual(adapt(recover('```json\n'+JSON.stringify(original)+'\n```').value).value,original)
 assert.equal(Object.hasOwn(adapt({}).value,'direction'),false)
})
test('recovery rejects ambiguous, truncated, duplicate-key and non-object outputs',()=>{
 for(const raw of ['{} {}','说明：{}','{"direction":1','[]','null','{"consistent":false,"consistent":true}','{"x":{"a":1,"a":2}}']) assert.throws(()=>recover(raw),{code:'MODEL_SCHEMA_FAILURE'})
 assert.deepEqual(recover('{"a":{"x":1},"b":{"x":2},"c":[1,2]}').value,{a:{x:1},b:{x:2},c:[1,2]})
})
for(const operation of ['enterpriseDecision','enterpriseDecisionReview','enterpriseSemanticReview','enterpriseEvidenceScreen','planIndustry','proposeImprovement']) test(`${operation} records raw/recovery/adapter and awaits caller review`,async()=>{
 assert.equal(usesEnterpriseProtocol(operation),true)
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'protocol-'))
 let calls=0
 const provider=new MultiModelProvider({config:{contract_version:'1.0.0',profiles:{test:{provider:'openai_compatible',base_url:'https://model.example/v1',api_key:'test',model:'test',max_retries:0}}},environment:{LLM_OUTPUT_TRACE_ROOT:root},fetchImpl:async()=>{calls++;return {ok:true,status:200,json:async()=>({choices:[{message:{content:'```json\n{"consistent":false}\n```'}}]})}}})
 const out=await provider.callForJson({operation,agent:{agent_id:'test',model_profile:'test'},prompt:[],outputInstruction:'JSON'})
 assert.equal(calls,1); assert.equal(out.consistent,false)
 const traces=await Promise.all((await fs.readdir(root)).map(x=>fs.readFile(path.join(root,x),'utf8').then(JSON.parse)))
 assert.equal(traces[0].status,'PARSED_AWAITING_CONTRACT_REVIEW')
 assert.equal(traces[0].adapter_result.consistent,false)
 assert.equal(traces[0].recovery_result.operations[0],'strip_complete_json_fence')
 assert.equal(out.model_provenance.call_id,traces[0].call_id)
})
test('enterprise parser cannot invoke the legacy format repair model behind the gate',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'protocol-'))
 let calls=0
 const p=new MultiModelProvider({config:{contract_version:'1.0.0',profiles:{test:{provider:'openai_compatible',base_url:'https://model.example/v1',api_key:'test',model:'test',max_retries:0}}},environment:{LLM_OUTPUT_TRACE_ROOT:root},fetchImpl:async()=>{calls++;return {ok:true,status:200,json:async()=>({choices:[{message:{content:'{} {}'}}]})}}})
 await assert.rejects(p.callForJson({operation:'enterpriseDecision',agent:{agent_id:'test',model_profile:'test'},prompt:[],outputInstruction:'JSON'}),e=>e.code==='MODEL_SCHEMA_FAILURE'&&e.raw_model_response==='{} {}')
 assert.equal(calls,1)
 const trace=JSON.parse(await fs.readFile(path.join(root,(await fs.readdir(root))[0]),'utf8'))
 assert.equal(trace.status,'FAILED');assert.equal(trace.core_validation_result.pass,false)
})
test('auxiliary production failure preserves API cause and never emits a baseline decision',async()=>{
 const {ProviderSupervisor}=require('../src/provider-supervisor')
 let baseline=0
 const error=Object.assign(new Error('model timeout'),{code:'MODEL_API_TIMEOUT',is_model_transport_failure:true,model:'test'})
 const p=new ProviderSupervisor({primary:{planIndustry:async()=>{throw error}},fallback:{planIndustry:async()=>{baseline++;return {}}},config:{maximum_primary_protocol_retries:1},validateOutput:()=>{},failClosed:true,failureDomain:'enterprise'})
 await assert.rejects(p.planIndustry({agent:{agent_id:'planner'},prompt:[]}),e=>e===error&&e.code==='MODEL_API_TIMEOUT')
 assert.equal(baseline,0)
})

test('planner identity comes from trusted routing and preserves original value in audit', async () => {
 const original={执行员:{执行员ID:'model-claimed-id'},产业链:{nodes:[],edges:[]},传导逻辑:[],证据需求:[]}
 const traces=[];let calls=0
 const p=new ProviderSupervisor({primary:{planIndustry:async()=>{calls++;return structuredClone(original)},recordOutputTrace:async t=>traces.push(t)},fallback:{},config:{maximum_primary_protocol_retries:0},validateOutput:(_,v)=>{assert.equal(v.执行员,'industry_research_planner');assert.deepEqual(v.产业链,original.产业链)},failClosed:true,failureDomain:'enterprise'})
 const output=await p.planIndustry({agent:{agent_id:'industry_research_planner'},prompt:[]})
 assert.equal(calls,1);assert.equal(output.执行员,'industry_research_planner')
 assert.deepEqual(traces[0].routing_derivation.model_reported_value,original.执行员)
 assert.equal(traces[0].routing_derivation.rule,'trusted_route_agent_id')
})

test('planner routing derivation does not relax business validation', async () => {
 const p=new ProviderSupervisor({primary:{planIndustry:async()=>({执行员:{},产业链:{nodes:[]}})},fallback:{},config:{maximum_primary_protocol_retries:0},validateOutput:()=>{throw new Error('missing evidence requirements')},failClosed:true,failureDomain:'enterprise'})
 await assert.rejects(p.planIndustry({agent:{agent_id:'industry_research_planner'},prompt:[]}),/missing evidence requirements/)
})

test('synthetic planner response traverses raw recovery adapter review with consistent normalized JSON', async t => {
 const {loadSchemaValidators,assertSchema}=require('../src/schema-validator')
 const {validateIndustryPlan}=require('../src/contracts')
 const raw=await fs.readFile(path.join(__dirname,'fixtures/planner-object-executor.json'),'utf8')
 const before=JSON.parse(raw)
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'planner-chain-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}))
 const provider=new MultiModelProvider({config:{contract_version:'1.0.0',profiles:{test:{provider:'openai_compatible',base_url:'https://test.example',api_key:'test',model:'test',max_retries:0}}},environment:{LLM_OUTPUT_TRACE_ROOT:dir},fetchImpl:async()=>new Response(JSON.stringify({choices:[{message:{content:raw}}]}))})
 const validators=await loadSchemaValidators(path.resolve(__dirname,'..'));const agent={agent_id:'industry_research_planner',model_profile:'test'}
 const supervisor=new ProviderSupervisor({primary:provider,fallback:{},config:{maximum_primary_protocol_retries:0},failClosed:true,failureDomain:'enterprise',validateOutput:(_,v)=>{assertSchema(validators.industryPlan,v,'plan');assert.deepEqual(validateIndustryPlan(v,agent),[])}})
 const result=await supervisor.planIndustry({agent,prompt:[]})
 assert.equal(result.执行员,agent.agent_id)
 for(const key of ['产业链','传导逻辑','证据需求'])assert.deepEqual(result[key],before[key])
 const normalized=JSON.parse(result.normalized_model_response)
 assert.equal(normalized.执行员,agent.agent_id)
 const traces=await Promise.all((await fs.readdir(dir)).map(f=>fs.readFile(path.join(dir,f),'utf8').then(JSON.parse)))
 const parsed=traces.find(x=>x.status==='PARSED_AWAITING_CONTRACT_REVIEW')
 const reviewed=traces.find(x=>x.status==='CONTRACT_REVIEWED')
 assert.equal(parsed.raw_model_response,raw)
 assert.deepEqual(parsed.adapter_result,normalized)
 assert.equal(reviewed.parent_call_id,parsed.call_id)
 assert.deepEqual(reviewed.routing_derivation.model_reported_value,before.执行员)
 assert.equal(reviewed.core_validation_result.pass,true)
})

test('planner adapter never trusts self-reported identity and requires trusted route',()=>{
 for(const identity of [undefined,'other-seat',{},123]){
  const input={执行员:identity,产业链:{nodes:[]}}
  const result=adapt(input,{operation:'planIndustry',expectedAgentId:'planner'})
  assert.equal(result.value.执行员,'planner');assert.deepEqual(result.value.产业链,input.产业链)
 }
 assert.throws(()=>adapt({},{operation:'planIndustry'}),{code:'MODEL_SCHEMA_FAILURE'})
})

test('planning canonicalization happens before normalized JSON and audit',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'canonical-plan-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}))
 const raw={执行员:{id:'wrong'},产业链:{nodes:[],edges:[]},传导逻辑:[],证据需求:[{query_terms:'检索',preferred_source_types:['公司公告','unknown-value']}]}
 const p=new MultiModelProvider({config:{contract_version:'1.0.0',profiles:{test:{provider:'openai_compatible',base_url:'https://test.invalid',api_key:'test',model:'test'}}},environment:{LLM_OUTPUT_TRACE_ROOT:dir},fetchImpl:async()=>new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(raw)}}]}))})
 const r=await p.planIndustry({agent:{agent_id:'planner',model_profile:'test'},prompt:[]})
 assert.deepEqual(JSON.parse(r.normalized_model_response),JSON.parse(JSON.stringify(r)))
 assert.deepEqual(r.证据需求[0].query_terms,['检索'])
 assert.deepEqual(r.证据需求[0].preferred_source_types,['company_disclosure','unknown-value'])
 const trace=JSON.parse(await fs.readFile(path.join(dir,(await fs.readdir(dir))[0]),'utf8'))
 assert.deepEqual(trace.adapter_result,JSON.parse(r.normalized_model_response))
 assert.ok(r.normalization_operations.some(x=>x.operation==='canonicalize_evidence_requirement'))
})

test('improvement executor is routing metadata while selected mutation remains model output',()=>{
 const r=adapt({执行员:{id:'wrong'},选择因子:'unknown'}, {operation:'proposeImprovement',expectedAgentId:'improvement_supervisor'})
 assert.equal(r.value.执行员,'improvement_supervisor');assert.equal(r.value.选择因子,'unknown')
})

test('legacy live entry points refuse execution before reading cases or calling providers',async()=>{
 await assert.rejects(require('../src/orchestrator').runCase({inputPath:'/missing'}),{code:'LEGACY_EXECUTION_DISABLED'})
 await assert.rejects(require('../src/batch-runner').runFormalBatch({configPath:'/missing'}),{code:'LEGACY_EXECUTION_DISABLED'})
})

test('supervisor rejects post-adapter data drift before business gate',async()=>{
 const output={执行员:'planner',产业链:{}};Object.defineProperty(output,'normalized_model_response',{value:'{}'})
 let gateCalled=false
 const p=new ProviderSupervisor({primary:{planIndustry:async()=>output},fallback:{},config:{maximum_primary_protocol_retries:0},failClosed:true,failureDomain:'enterprise',validateOutput:()=>{gateCalled=true}})
 await assert.rejects(p.planIndustry({agent:{agent_id:'planner'},prompt:[]}),{code:'OUTPUT_PIPELINE_DRIFT'})
 assert.equal(gateCalled,false)
})

test('exchange adapter relocates unique metadata without changing business output',()=>{
 const original={review_decision:'revise',review_summary:'基于反证修订',candidate:{revision_kind:'substantive',addition_basis:[{code:4,lens_gap:'gap',why_existing_insufficient:'reason',evidence_refs:[1]}],direction:0,reason:'保持判断',evidence_refs:[1]}}
 const result=adapt(original,{operation:'enterpriseDecisionReview',referenceBinding:{entries:[{selector:1,id:'source:exact'}],broadcast_version:'trusted'}})
 assert.equal(result.value.revision_kind,'substantive');assert(!Object.hasOwn(result.value.candidate,'revision_kind'))
 assert(!Object.hasOwn(result.value.candidate,'addition_basis'));assert.deepEqual(result.value.addition_basis[0].evidence_refs,['source:exact'])
 assert.equal(result.value.candidate.direction,0);assert.equal(original.candidate.revision_kind,'substantive')
 assert(result.operations.some(x=>x.from==='candidate.revision_kind'&&x.to==='exchange.revision_kind'))
 assert.deepEqual(JSON.parse(result.normalized_response),result.value)
})
test('exchange field conflicts fail closed; identical duplicates may be collapsed',()=>{
 const value={review_decision:'revise',revision_kind:'wording_only',candidate:{revision_kind:'substantive',direction:0}}
 assert.throws(()=>adapt(value,{operation:'enterpriseDecisionReview'}),e=>e.code==='MODEL_SCHEMA_FAILURE'&&e.message.includes('层级冲突'))
 value.revision_kind='substantive'
 assert.equal(adapt(value,{operation:'enterpriseDecisionReview'}).value.candidate.revision_kind,undefined)
})
test('flat exchange business fields are wrapped by exact field ownership; maintain/null is never changed into revise',()=>{
 const flat={review_decision:'revise',review_summary:'修订',direction:0,reason:'依据',evidence_refs:['e']}
 const result=adapt(flat,{operation:'enterpriseDecisionReview'})
 assert.deepEqual(result.value.candidate,{direction:0,reason:'依据',evidence_refs:['e']})
 assert.equal(result.value.revision_kind,'substantive')
 const maintain={review_decision:'maintain',candidate:null,direction:1}
 assert.deepEqual(adapt(maintain,{operation:'enterpriseDecisionReview'}).value,maintain)
 assert.deepEqual(adapt(flat,{operation:'enterpriseDecision'}).value,flat,'initial analysis does not inherit exchange interpretation')
})
test('missing revision kind uses a conservative control default; supplied invalid values are not rewritten',()=>{
 const missing={review_decision:'revise',candidate:{direction:0}}
 const result=adapt(missing,{operation:'enterpriseDecisionReview'})
 assert.equal(result.value.revision_kind,'substantive');assert(result.operations.some(x=>x.type==='PROGRAM_CONTROL_DEFAULT'))
 assert.equal(adapt({...missing,revision_kind:'unknown'},{operation:'enterpriseDecisionReview'}).value.revision_kind,'unknown')
})

test('HTTP provider traces raw misplaced metadata and canonical relocated output before caller gate',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'envelope-http-'))
 const raw=JSON.stringify({review_decision:'revise',review_summary:'修订',candidate:{direction:0,revision_kind:'substantive',reason:'事实',evidence_refs:[1]}})
 const provider=new MultiModelProvider({config:{contract_version:'1.0.0',profiles:{test:{provider:'openai_compatible',base_url:'https://model.example/v1',api_key:'test',model:'test',max_retries:0}}},environment:{LLM_OUTPUT_TRACE_ROOT:root},fetchImpl:async()=>({ok:true,status:200,json:async()=>({choices:[{message:{content:raw}}]})})})
 const result=await provider.callForJson({operation:'enterpriseDecisionReview',agent:{agent_id:'test',model_profile:'test'},prompt:[],adapterContext:{referenceBinding:{entries:[{selector:1,id:'original:id'}],broadcast_version:'trusted'}},outputInstruction:'JSON'})
 assert.equal(result.revision_kind,'substantive');assert.equal(result.candidate.revision_kind,undefined)
 const trace=JSON.parse(await fs.readFile(path.join(root,(await fs.readdir(root))[0]),'utf8'))
 assert.equal(trace.raw_model_response,raw);assert.equal(trace.adapter_result.revision_kind,'substantive')
 assert.deepEqual(trace.adapter_result.candidate.evidence_refs,['original:id'])
 assert(trace.normalization_operations.some(x=>x.from==='candidate.revision_kind'))
})

test('adapter failure preserves successful recovery instead of reporting it as a JSON syntax failure',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'envelope-conflict-'))
 const raw=JSON.stringify({review_decision:'revise',revision_kind:'wording_only',candidate:{revision_kind:'substantive',direction:0}})
 const provider=new MultiModelProvider({config:{contract_version:'1.0.0',profiles:{test:{provider:'openai_compatible',base_url:'https://model.example/v1',api_key:'test',model:'test',max_retries:0}}},environment:{LLM_OUTPUT_TRACE_ROOT:root},fetchImpl:async()=>({ok:true,status:200,json:async()=>({choices:[{message:{content:raw}}]})})})
 await assert.rejects(provider.callForJson({operation:'enterpriseDecisionReview',agent:{agent_id:'test',model_profile:'test'},prompt:[],outputInstruction:'JSON'}),e=>e.code==='MODEL_SCHEMA_FAILURE'&&e.output_recovery.status==='RECOVERED'&&e.raw_model_response===raw)
 const trace=JSON.parse(await fs.readFile(path.join(root,(await fs.readdir(root))[0]),'utf8'))
 assert.equal(trace.status,'FAILED');assert.equal(trace.recovery_result.status,'RECOVERED');assert.equal(trace.adapter_result,null)
 assert.match(trace.core_validation_result.reason,/层级冲突/)
})
