const test=require('node:test'),assert=require('node:assert/strict')
const {ACTIONS,OBJECT_BOUNDARIES,validateActions,isActualAction,candidateSignature}=require('../src/enterprise-action-contract')
const {validateCandidate,buildReport}=require('../src/enterprise-decision')
const d=require('../src/enterprise-deliberation')
const {recoverEnterpriseOutput,adaptEnterpriseOutput}=require('../src/enterprise-output-protocol')
const {createBinding}=require('../src/enterprise-reference-binding')
const {assertRepairPreservesVerdict}=require('../src/enterprise-review-repair')
const prior={code:0,version:'frozen-v',time_range:'未来12个月'},evidence=new Set(['e'])
const none=()=>({recommendations:[13],actions:[],label_assessments:[],evidence_refs:['e'],factors:[{name:'现行安排',mechanism:'已实施',effect:'neutral',evidence_refs:['e']}],gaps:[],assumptions:[],reason:'已有安排足够',seat_summary:'无需新增',direction_version:'frozen-v',no_action_basis:{existing_arrangements:[{arrangement:'已核验安排',evidence_refs:['e']}],why_sufficient:'无独立剩余动作',direction_relation:'支持冻结方向'}})
const action=id=>({id,...(OBJECT_BOUNDARIES[id]||{}),target:'项目',scope:'partial',time_range:'未来12个月',action:`独立操作${id}`,effect:'protect',readiness:'ready',prerequisites:[],evidence_refs:['e'],direction_relation:'相容'})
function review(c){return {consistent:true,selected_seat_id:c.seat_id,authority:'within_rules',unresolved_gaps:[],applied_rule_ids:['SUPPORTED_WHOLE_CANDIDATE'],review_reason:'已有安排足够',selection_mode:'equivalent_choice',candidate_reviews:[{seat_id:c.seat_id,assessment:'supported',independence:'independent',reason:'证据支持',task_coverage:'not_applicable',combination_assessment:'not_applicable',combination_reason:'无新增操作',action_reviews:[],boundary_reviews:[],timing_reviews:[],issues:[],no_action_review:{assessment:'supported',direction_assessment:'compatible',reason:'已有安排支持方向'},comparison_to_selected:{relation:'selected',reason:'完整候选'}}]}}
test('empty, null, missing and malformed recommendations fail closed under all directions',()=>{
 for(const code of [-1,0,1])for(const recommendations of [undefined,null,[],{},[null],['13'],[14]]){
  const c={...none(),recommendations};assert(validateCandidate(c,'condition',evidence,{...prior,code}).length)
  const raw=recoverEnterpriseOutput(JSON.stringify(c)),adapted=adaptEnterpriseOutput(raw.value).value
  assert.deepEqual(adapted.recommendations,recommendations)
  if(recommendations===null)assert.deepEqual(buildReport({...prior,reason:'方向'}, {code:null,actions:[],evidence_refs:['e'],gaps:['未决'],reason:'未决'}).决策建议.map(a=>a.编号),[10])
  else assert.throws(()=>buildReport({...prior,reason:'方向'}, {code:recommendations,actions:[],evidence_refs:['e'],gaps:[]}),/门禁拒绝|校验/)
 }
})
test('explicit13 requires registered existing arrangements, determined direction and no blocking gaps',()=>{
 assert.deepEqual(validateCandidate(none(),'condition',evidence,prior),[])
 for(const change of [c=>delete c.no_action_basis,c=>c.no_action_basis.existing_arrangements=[],c=>c.no_action_basis.existing_arrangements[0].evidence_refs=['missing'],c=>c.no_action_basis.why_sufficient='',c=>c.gaps=['关键冲突'],c=>c.recommendations=[13,3],c=>c.recommendations=[10,13],c=>c.actions=[action(3)],c=>c.label_assessments=[{code:13}],c=>c.evidence_refs={},c=>c.no_action_basis.existing_arrangements=[null]]){
  const c=none();change(c);assert.doesNotThrow(()=>validateCandidate(c,'condition',evidence,prior));assert(validateCandidate(c,'condition',evidence,prior).length)
 }
 assert(validateCandidate(none(),'condition',evidence,{...prior,code:null}).length)
 const unable={...none(),recommendations:[10],gaps:['重大冲突'],factors:[],evidence_refs:[]};delete unable.no_action_basis
 assert.deepEqual(validateCandidate(unable,'condition',new Set(),prior),[])
})
test('split codes require declared object and commitment status without prose interpretation or pair bans',()=>{
 for(const id of [2,4,11,12]){
  const c={recommendations:[id],actions:[action(id)],evidence_refs:['e']}
  assert.deepEqual(validateActions(c,evidence,prior),[])
  delete c.actions[0].commitment_status;assert(validateActions(c,evidence,prior).length)
 }
 const c={recommendations:[2,4,11,12],actions:[2,4,11,12].map(action),evidence_refs:['e']}
 assert.deepEqual(validateActions(c,evidence,{...prior,code:-1}),[],'semantic compatibility remains an LLM judgment')
 c.actions[3].action=c.actions[0].action;assert(validateActions(c,evidence,prior).some(e=>e.includes('重复列项')))
})
test('13 review is independent of empty action applicability and is protected from format verdict drift',()=>{
 const c={...none(),seat_id:'a'},r=review(c),context={stage:'condition',candidates:[c],actionHistory:[]}
 assert.deepEqual(d.validateReview(r,[c],'condition',d.reviewRules('condition'),{requireActionAudit:true,requireSelectionComparison:true}),[])
 for(const field of ['assessment','direction_assessment']){
  const bad=structuredClone(r);bad.candidate_reviews[0].no_action_review[field]='uncertain'
  assert(d.validateReview(bad,[c],'condition',d.reviewRules('condition'),{requireActionAudit:true}).length)
  assert.throws(()=>assertRepairPreservesVerdict(bad,r,context),{code:'ENTERPRISE_REVIEW_VERDICT_DRIFT'})
 }
 const bad=structuredClone(r);delete bad.candidate_reviews[0].no_action_review
 assert(d.validateReview(bad,[c],'condition',d.reviewRules('condition')).length)
 const empty={...c,recommendations:[]};assert(d.validateReview(r,[empty],'condition',d.reviewRules('condition')).length)
 const binding=createBinding([{role:'user',content:JSON.stringify({stage:'condition',evidence:[{id:'e'}],candidates:[empty]})}])
 const adapted=adaptEnterpriseOutput(r,{referenceBinding:binding}).value
 assert(d.validateReview(adapted,[empty],'condition',d.reviewRules('condition')).length)
})
test('changes to existing arrangements reactivate peers and cannot hide in wording-only changes',()=>{
 const c={...none(),seat_id:'a'},next=structuredClone(c);next.no_action_basis.existing_arrangements[0].arrangement='不同安排'
 assert.notEqual(d.discussionVersion(c,'condition'),d.discussionVersion(next,'condition'))
 assert.notEqual(candidateSignature(c,'condition'),candidateSignature(next,'condition'))
 assert(d.conditionChanges(c,next).no_action_basis)
 const errors=d.validateExchange({review_decision:'revise',revision_kind:'wording_only',review_summary:'仅润色',broadcast_version:'b',candidate:next,addition_basis:[]},{stage:'condition',own:c,broadcastVersion:'b',validate:v=>validateCandidate(v,'condition',evidence,prior)})
 assert(errors.some(e=>e.includes('wording_only')))
})
test('13 to a real action uses ordinary addition controls; verdict13 is not an action addition',()=>{
 const own=none(),next={...none(),recommendations:[11],actions:[action(11)],label_assessments:[]};delete next.no_action_basis
 const exchange={review_decision:'revise',revision_kind:'substantive',review_summary:'已有安排有已知遗漏',broadcast_version:'b',candidate:next,addition_basis:[]},args={stage:'condition',own,broadcastVersion:'b',validate:()=>[]}
 assert(d.validateExchange(exchange,args).some(e=>e.includes('addition_basis')))
 exchange.addition_basis=[{code:11,lens_gap:'战略方向',why_existing_insufficient:'已知市场变化',evidence_refs:['e']}]
 assert.deepEqual(d.validateExchange(exchange,args),[])
 exchange.candidate=none();exchange.addition_basis=[];args.own=next
 assert.deepEqual(d.validateExchange(exchange,args),[])
 assert.equal(isActualAction(13),false);assert.equal(isActualAction(11),true);assert.equal(ACTIONS.length,13)
})

test('overall combination direction conflict blocks delivery even when every action individually passes',()=>{
 const c={seat_id:'a',recommendations:[11,12],actions:[action(11),action(12)],label_assessments:[{code:11,necessary:true},{code:12,necessary:true}]},r=review(c),row=r.candidate_reviews[0]
 delete row.no_action_review;Object.assign(row,{task_coverage:'sufficient',combination_assessment:'compatible',combination_direction_assessment:'conflicting',action_reviews:c.recommendations.map(id=>({id,assessment:'supported',necessity:'required',omission_impact:'独立剩余风险',direction_assessment:'compatible',reason:'证据',basis_status:'established',known_basis:'已知风险',countercheck_status:'adequate',deletion_case:'已有安排',retention_response:'仍有剩余风险',residual_risk_source:'known_fact'})),boundary_reviews:[{action_ids:[11,12],relationship:'shared_object_independent',reason:'不同必要操作'}]})
 assert(d.validateReview(r,[c],'condition',d.reviewRules('condition'),{requireActionAudit:true}).some(e=>e.includes('整体组合')))
 const before=structuredClone(r);row.combination_direction_assessment='compatible'
 assert.deepEqual(d.validateReview(r,[c],'condition',d.reviewRules('condition'),{requireActionAudit:true}),[])
 assert.throws(()=>assertRepairPreservesVerdict(before,r,{stage:'condition',candidates:[c]}),{code:'ENTERPRISE_REVIEW_VERDICT_DRIFT'})
})
test('old option checkpoints cannot be reused under new semantic version and remain intact',async()=>{
 const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path')
 const {ModelCallCheckpointStore}=require('../src/model-call-checkpoint-store')
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'option-version-checkpoint-'))
 const store=new ModelCallCheckpointStore({rootDirectory:root,enabled:true}),base={contract_version:'1.0.0',operation:'seat_initial',mode:'enterprise_decision_v2',agent:{agent_id:'a'},evidence_version:'same',prompt_sha256:'same'}
 let calls=0
 const old=await store.execute({identity:{...base,output_protocol_version:'5.2.8-residual-risk-source'},validate:()=>{},run:async()=>{calls++;return {output:{recommendations:[2,4],reason:'旧含义'},events:[]}}})
 const saved=await fs.readFile(old.checkpoint.record_path,'utf8')
 const next=await store.execute({identity:{...base,output_protocol_version:d.VERSION,action_options_version:'3.0.0-object-boundaries'},validate:()=>{},run:async()=>{calls++;return {output:{recommendations:[11,12],reason:'新含义'},events:[]}}})
 assert.equal(calls,2);assert.equal(next.checkpoint.status,'completed');assert.notEqual(next.checkpoint.record_path,old.checkpoint.record_path)
 assert.equal(await fs.readFile(old.checkpoint.record_path,'utf8'),saved)
 await fs.rm(root,{recursive:true,force:true})
})

test('optional null no-action fields do not change an actual verdict;13 still requires a real basis',()=>{
 const c={recommendations:[11],actions:[action(11)],evidence_refs:['e'],no_action_basis:null}
 assert.deepEqual(validateActions(c,evidence,prior),[])
 const n=none();n.no_action_basis=null;assert(validateActions(n,evidence,prior).length)
 const unable={...none(),seat_id:'a',recommendations:[10],gaps:['重大冲突'],no_action_basis:null},r=review(unable)
 r.consistent=false;r.selected_seat_id=null;r.candidate_reviews[0].no_action_review=null
 assert(!d.validateReview(r,[unable],'condition',d.reviewRules('condition')).some(e=>e.includes('no_action_review')))
})
