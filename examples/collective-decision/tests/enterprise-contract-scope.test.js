const test=require('node:test'),assert=require('node:assert/strict')
const {createBinding,encodePrompt}=require('../src/enterprise-reference-binding')
const {recoverEnterpriseOutput,adaptEnterpriseOutput}=require('../src/enterprise-output-protocol')
const {buildSeatPrompt,buildReviewPrompt,validateExchange,reviewRules}=require('../src/enterprise-deliberation')
const {validateActionAuditReview}=require('../src/enterprise-action-audit')
const {assertRepairPreservesVerdict}=require('../src/enterprise-review-repair')
const basis=code=>({code,lens_gap:'known gap',why_existing_insufficient:'existing action has another function',evidence_refs:['e1']})
const candidate={seat_id:'a',recommendations:[2,3,4],actions:[]}
function seatPrompt(own){return buildSeatPrompt({agent:{label:'seat',lens:'own lens'},stage:'condition',review:true,question:{},company:{},own,evidence:[{id:'e1'}],peers:[],broadcastVersion:'b1',policy:'',stageInstruction:()=>''})}
function reviewPrompt(history=[]){return buildReviewPrompt({stage:'condition',policy:'',question:{},rules:[],arbitrationRules:reviewRules('condition'),candidates:[candidate],evidence:[{id:'e1'}],actionHistory:history})}
function exchange(ids,items){return {review_decision:'revise',revision_kind:'substantive',review_summary:'changed reasoning',candidate:{recommendations:ids,evidence_refs:['e1'],reason:'own evidence'},addition_basis:items}}
function adapt(raw,prompt){return adaptEnterpriseOutput(recoverEnterpriseOutput(JSON.stringify(raw)).value,{referenceBinding:createBinding(prompt)})}
function gate(out,own){return validateExchange(out,{stage:'condition',own,broadcastVersion:'b1',validate:()=>[]})}
test('existing-code refinements are outside addition scope; actual new-code evidence remains required',()=>{
 const own={recommendations:[2,3,4]},raw=exchange([2,3,4],[basis(2),basis(4)]),out=adapt(raw,seatPrompt(own))
 assert.deepEqual(out.value.addition_basis,[]);assert.deepEqual(gate(out.value,own),[])
 assert.deepEqual(raw.addition_basis.map(x=>x.code),[2,4])
 assert.equal(out.operations.filter(x=>x.operation==='exclude_existing_action_from_addition_scope').length,2)
 assert.deepEqual(out.value.candidate.recommendations,raw.candidate.recommendations)
 const previous={recommendations:[2,4]},p=seatPrompt(previous)
 const valid=adapt(exchange([2,3,4],[basis(2),basis(3)]),p).value
 assert.deepEqual(valid.addition_basis.map(x=>x.code),[3]);assert.deepEqual(gate(valid,previous),[])
 for(const items of [[],[basis(3),basis(3)],[basis(99)],[{...basis(3),evidence_refs:['unknown']}],[{...basis(2),evidence_refs:['unknown']},basis(3)],[{...basis(2),lens_gap:null},basis(3)]])
   assert(gate(adapt(exchange([2,3,4],items),p).value,previous).length)
})
function audit(){return {consistent:true,selected_seat_id:'a',candidate_reviews:[{seat_id:'a',action_reviews:[],boundary_reviews:[[2,3],[2,4],[3,4]].map(action_ids=>({action_ids,relationship:'independent',reason:'separate remaining executable actions'})),timing_reviews:[]}]}}
const history=[{seat_id:'a',code:3,kind:'added',round:1,received_same_code:[{seat_id:'b'}]}]
test('timing scope is copied from trusted flagged history, not all new or retained codes',()=>{
 const raw=audit();raw.candidate_reviews[0].timing_reviews=[{code:3,assessment:'independent',reason:'own known fact'}]
 const out=adapt(raw,reviewPrompt());assert.deepEqual(out.value.candidate_reviews[0].timing_reviews,[])
 assert.deepEqual(validateActionAuditReview(out.value,[candidate]),[])
 assert.equal(out.operations[0].operation,'exclude_unflagged_action_from_timing_scope')
 assert.equal(raw.candidate_reviews[0].timing_reviews.length,1)
 const prompt=reviewPrompt(history),binding=createBinding(prompt),wire=JSON.parse(encodePrompt(prompt,binding)[1].content)
 assert.deepEqual(wire.review_output_contract.timing_reviews.targets,[{seat_id:'candidate_1',codes:[3]}])
 for(const items of [[],[{code:3,assessment:'peer_only',reason:'peer endorsement'}],[{code:99,assessment:'independent',reason:'unknown code'}],[{code:3,assessment:'independent',reason:'own fact'},{code:3,assessment:'independent',reason:'duplicate'}],[{code:2,assessment:'invalid',reason:'bad enum'}]]){
   const bad=audit();bad.candidate_reviews[0].timing_reviews=items
   assert(validateActionAuditReview(adapt(bad,prompt).value,[candidate],history).length)
 }
 const accepted=adapt(raw,prompt).value;assert.deepEqual(validateActionAuditReview(accepted,[candidate],history),[])
 assert.deepEqual(accepted.candidate_reviews[0].timing_reviews,raw.candidate_reviews[0].timing_reviews)
})
test('same object independent functions is an explicit LLM verdict; overlap never auto-converts from prose',()=>{
 const raw=audit();raw.candidate_reviews[0].boundary_reviews[1].relationship='shared_object_independent'
 const out=adapt(raw,reviewPrompt()).value
 assert.deepEqual(validateActionAuditReview(out,[candidate]),[])
 assertRepairPreservesVerdict(raw,out,{stage:'condition',candidates:[candidate],actionHistory:[]})
 const changed=structuredClone(out);changed.candidate_reviews[0].boundary_reviews[1].relationship='independent'
 assert.throws(()=>assertRepairPreservesVerdict(out,changed,{stage:'condition',candidates:[candidate]}),{code:'ENTERPRISE_REVIEW_VERDICT_DRIFT'})
 for(const relationship of ['overlapping','uncertain']){
   raw.candidate_reviews[0].boundary_reviews[1].relationship=relationship
   const blocked=adapt(raw,reviewPrompt()).value
   assert.equal(blocked.candidate_reviews[0].boundary_reviews[1].relationship,relationship)
   assert(validateActionAuditReview(blocked,[candidate]).includes('不得批准边界重叠或独立作用未决的组合'))
 }
})
test('exchange schema explicitly requires seat summary and review schema distinguishes shared object from duplicate',()=>{
 const input=JSON.parse(seatPrompt({recommendations:[4]})[1].content)
 assert.equal(input.output_contract.field_types.seat_summary,'required nonempty string, 1-1200 characters')
 const p=reviewPrompt(),schema=JSON.parse(p[1].content).review_output_contract
 assert(schema.boundary_reviews.relationships.includes('shared_object_independent'))
 assert(p[0].content.includes('overlapping仅表示执行动作存在替代、重复或需收窄'))
})
