const test=require('node:test'),assert=require('node:assert/strict'),d=require('../src/enterprise-deliberation')
const {createBinding}=require('../src/enterprise-reference-binding'),{adaptEnterpriseOutput}=require('../src/enterprise-output-protocol')
const candidate={seat_id:'a',recommendations:[3],actions:[{id:3}],label_assessments:[{code:3,necessary:true,evidence_refs:['e'],counter_evidence_refs:['e']}]}
function review(){return {consistent:true,selected_seat_id:'a',unresolved_gaps:[],authority:'within_rules',applied_rule_ids:['SUPPORTED_WHOLE_CANDIDATE'],review_reason:'完整候选',candidate_reviews:[{seat_id:'a',assessment:'supported',independence:'independent',reason:'已知依据',task_coverage:'sufficient',combination_assessment:'compatible',combination_reason:'完整相容',action_reviews:[{id:3,assessment:'supported',necessity:'required',omission_impact:'已知风险',direction_assessment:'compatible',reason:'证据'}],issues:[]}]}}
test('malformed review fields reach contract rejection instead of throwing TypeError',()=>{
 for(const field of ['action_reviews','issues','boundary_reviews','timing_reviews','no_action_review'])for(const value of [null,{},'wrong',42,[null]]){
  const r=review();r.candidate_reviews[0][field]=value
  assert.doesNotThrow(()=>d.validateReview(r,[candidate],'condition',d.reviewRules('condition'),{requireActionAudit:true}),field+' '+JSON.stringify(value))
 }
 for(const field of ['candidate_reviews','revision_requests','applied_rule_ids','unresolved_gaps'])for(const value of [null,{},'wrong',42,[null]]){
  const r=review();r[field]=value
  assert.doesNotThrow(()=>d.validateReview(r,[candidate],'condition',d.reviewRules('condition'),{requireActionAudit:true}),field+' '+JSON.stringify(value))
 }
})
test('counter-evidence references are substantive, not wording-only payload changes',()=>{
 const changed=structuredClone(candidate);changed.label_assessments[0].counter_evidence_refs=['other']
 const errors=d.validateExchange({review_decision:'revise',revision_kind:'wording_only',review_summary:'只润色',broadcast_version:'b',candidate:changed,addition_basis:[]},{stage:'condition',own:candidate,broadcastVersion:'b',validate:()=>[]})
 assert(errors.some(e=>e.includes('wording_only')))
})
test('empty no_action_review is out of scope for actual/10, never for13 or unknown candidates',()=>{
 for(const codes of [[3],[10],[13],[],[3,13]]){
  const input={stage:'condition',evidence:[{id:'e'}],candidates:[{seat_id:'a',recommendations:codes}]}
  const binding=createBinding([{role:'user',content:JSON.stringify(input)}]),r=review();r.candidate_reviews[0].no_action_review={}
  const adapted=adaptEnterpriseOutput(r,{referenceBinding:binding})
  if(codes.length===1&&[3,10].includes(codes[0])){assert.equal(adapted.value.candidate_reviews[0].no_action_review,undefined);assert(adapted.operations.some(o=>o.operation==='exclude_empty_no_action_review'))}
  else assert.deepEqual(adapted.value.candidate_reviews[0].no_action_review,{})
 }
 const binding=createBinding([{role:'user',content:JSON.stringify({stage:'condition',evidence:[{id:'e'}],candidates:[candidate]})}]),r=review();r.candidate_reviews[0].no_action_review={assessment:'unsupported'}
 assert.deepEqual(adaptEnterpriseOutput(r,{referenceBinding:binding}).value.candidate_reviews[0].no_action_review,r.candidate_reviews[0].no_action_review)
})
test('action wire enum choices derive from the same definitions used by the gate',()=>{
 const {ACTION_FIELD_ENUMS,stageInstruction}=require('../src/enterprise-action-contract')
 const input=JSON.parse(d.buildSeatPrompt({agent:{label:'本席',lens:'经营'},stage:'condition',policy:'',stageInstruction,evidence:[]})[1].content)
 for(const [field,values] of Object.entries(ACTION_FIELD_ENUMS))assert.deepEqual(input.output_contract.actions[field],values)
 const r=review();r.candidate_reviews[0].action_reviews={id:3}
 const errors=d.validateReview(r,[candidate],'condition',d.reviewRules('condition'))
 assert(errors.some(e=>e.includes('逐项覆盖')))
})
