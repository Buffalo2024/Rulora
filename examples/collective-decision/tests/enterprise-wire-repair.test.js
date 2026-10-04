const test=require('node:test'),assert=require('node:assert/strict')
const {createBinding}=require('../src/enterprise-reference-binding')
const {adaptEnterpriseOutput}=require('../src/enterprise-output-protocol')
const {validateActions,OBJECT_BOUNDARIES,stageInstruction}=require('../src/enterprise-action-contract')
const d=require('../src/enterprise-deliberation')
const prompt=[{role:'user',content:JSON.stringify({stage:'condition',evidence:[{id:'E1'},{id:'E2'}],frozen_direction:{version:'v'}})}],binding=createBinding(prompt)
const candidate=()=>({recommendations:[3],actions:[{id:3,target:'目标',scope:'overall',time_range:'本期',action:'核对现金预算',effect:'protect',readiness:'ready',prerequisites:[],evidence_refs:[1],direction_relation:'相容',decision_object:'cash_management',commitment_status:'existing'}],reason:'已知风险',evidence_refs:[1],seat_summary:'核对预算',gaps:[],factors:[],label_assessments:[{code:3,necessary:true,why_required:['已知风险'],evidence_refs:[1],counter_evidence:[2,'已有安排']}],no_action_basis:{}})
test('case14/17 structural shapes normalize without changing actions or necessity',()=>{
 const raw=candidate(),result=adaptEnterpriseOutput(raw,{referenceBinding:binding}),c=result.value
 assert.deepEqual(c.recommendations,[3]);assert.equal(c.actions[0].action,raw.actions[0].action);assert.equal(c.label_assessments[0].necessary,true)
 assert.equal(c.actions[0].decision_object,undefined);assert.equal(c.no_action_basis,undefined)
 assert.deepEqual(c.label_assessments[0].counter_evidence,['已有安排']);assert.deepEqual(c.label_assessments[0].counter_evidence_refs,['E2']);assert.deepEqual(c.evidence_refs,['E1','E2'])
 assert.deepEqual(validateActions(c,new Set(['E1','E2']),{code:0,version:'v'}),[])
 assert.deepEqual(d.validateAnalysis(c,'condition',new Set(['E1','E2'])),[])
 assert.equal(raw.actions[0].decision_object,'cash_management');assert.deepEqual(raw.no_action_basis,{})
 assert(result.operations.some(o=>o.operation==='relocate_registered_counter_evidence_refs'))
})
test('empty13, substantive non13 basis, wrong controlled enum and unknown counter refs still fail closed',()=>{
 let raw=candidate();raw.recommendations=[13];raw.actions=[];raw.label_assessments=[]
 assert(validateActions(adaptEnterpriseOutput(raw,{referenceBinding:binding}).value,new Set(['E1','E2']),{code:0,version:'v'}).length)
 raw=candidate();raw.no_action_basis={why_sufficient:'有实质声明'}
 assert(validateActions(adaptEnterpriseOutput(raw,{referenceBinding:binding}).value,new Set(['E1','E2']),{code:0,version:'v'}).some(e=>e.includes('no_action_basis')))
 raw=candidate();raw.recommendations=[4];raw.actions[0].id=4;raw.actions[0].decision_object='cash_management'
 const c=adaptEnterpriseOutput(raw,{referenceBinding:binding}).value
 assert.equal(c.actions[0].decision_object,'cash_management');assert(validateActions(c,new Set(['E1','E2']),{code:0,version:'v'}).some(e=>e.includes('new_investment')))
 raw=candidate();raw.label_assessments[0].counter_evidence=[999]
 assert(d.validateAnalysis(adaptEnterpriseOutput(raw,{referenceBinding:binding}).value,'condition',new Set(['E1','E2'])).some(e=>e.includes('counter_evidence')))
 raw=candidate();raw.factors=[{counter_evidence_refs:['不能代替证据编号的说明文字']}]
 assert.deepEqual(adaptEnterpriseOutput(raw,{referenceBinding:binding}).value.factors[0].counter_evidence_refs,raw.factors[0].counter_evidence_refs)
})
test('initial and exchange receive identical field schemas and explicit enum choices',()=>{
 const base={agent:{label:'测试',lens:'本席视角'},stage:'condition',policy:'',stageInstruction,evidence:[]}
 const initial=JSON.parse(d.buildSeatPrompt(base)[1].content),exchange=JSON.parse(d.buildSeatPrompt({...base,review:true,own:{recommendations:[3]},peers:[]})[1].content)
 assert.deepEqual(initial.output_contract,exchange.output_contract);assert.deepEqual(initial.object_boundaries,OBJECT_BOUNDARIES)
 assert.deepEqual(initial.output_contract.actions.decision_object,['existing_tasks','new_investment','strategy','ongoing_investment','other'])
 assert.match(initial.output_contract.constraints,/counter_evidence_refs/)
})
