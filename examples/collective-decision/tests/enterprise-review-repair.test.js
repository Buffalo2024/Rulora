const test=require('node:test'),assert=require('node:assert/strict')
const {repairMode,assertRepairPreservesVerdict,nextReviewRepair}=require('../src/enterprise-review-repair')
const {adaptEnterpriseOutput}=require('../src/enterprise-output-protocol')
const {createBinding}=require('../src/enterprise-reference-binding')
const {validateReview,REVIEW_RULES}=require('../src/enterprise-deliberation')
function review(){return {consistent:true,selected_seat_id:'empty',authority:'within_rules',unresolved_gaps:[],applied_rule_ids:['SUPPORTED_WHOLE_CANDIDATE'],review_reason:'无新增行动',candidate_reviews:[{seat_id:'empty',assessment:'supported',independence:'independent',reason:'维持现状',no_action_review:{assessment:'supported',direction_assessment:'compatible',reason:'已有公开安排足够'},task_coverage:'sufficient',action_reviews:[],issues:[],combination_assessment:'not_applicable',combination_reason:'没有行动'}]}}
test('verdict drift triggers one fresh assessment without adopting the repaired answer',()=>{
 const next=nextReviewRepair({attempt:1,errors:['drift'],value:review(),verdictDrift:true})
 assert.equal(next.mode,'fresh_reassessment');assert.equal(next.previous_output,null)
 assert.equal(nextReviewRepair({attempt:2,errors:['drift'],value:review(),verdictDrift:true}),null)
 assert.equal(nextReviewRepair({attempt:1,errors:['format'],value:review(),verdictDrift:false}),null)
})
test('repair may remove inapplicable timing rows but preserves real flagged-addition judgments',()=>{
 const before=review();before.candidate_reviews[0].timing_reviews=[{code:3,assessment:'independent',reason:'wrong timing scope'}]
 const after=structuredClone(before);after.candidate_reviews[0].timing_reviews=[]
 const context={candidates:[{seat_id:'empty',recommendations:[3]}],actionHistory:[{seat_id:'empty',code:3,kind:'initial',received_same_code:[]}]}
 assert.doesNotThrow(()=>assertRepairPreservesVerdict(before,after,context))
 assert.throws(()=>assertRepairPreservesVerdict(before,after),{code:'ENTERPRISE_REVIEW_VERDICT_DRIFT'})
 context.actionHistory.push({seat_id:'empty',code:3,kind:'added',received_same_code:[{seat_id:'peer'}]})
 assert.throws(()=>assertRepairPreservesVerdict(before,after,context),{code:'ENTERPRISE_REVIEW_VERDICT_DRIFT'})
 after.candidate_reviews[0].timing_reviews=[{code:3,assessment:'peer_only',reason:'changed verdict'}]
 assert.throws(()=>assertRepairPreservesVerdict(before,after,context),{code:'ENTERPRISE_REVIEW_VERDICT_DRIFT'})
 context.actionHistory=[];after.selected_seat_id='other'
 assert.throws(()=>assertRepairPreservesVerdict(before,after,context),{code:'ENTERPRISE_REVIEW_VERDICT_DRIFT'})
})
test('empty action applicability is derived without a new business review or action',()=>{
 const candidates=[{seat_id:'empty',recommendations:[13],label_assessments:[]}],binding=createBinding([{role:'user',content:JSON.stringify({stage:'condition',evidence:[],candidates})}]),raw=review()
 assert(validateReview(raw,candidates,'condition',REVIEW_RULES).length)
 const adapted=adaptEnterpriseOutput(raw,{referenceBinding:binding})
 assert.deepEqual(validateReview(adapted.value,candidates,'condition',REVIEW_RULES),[])
 assert.equal(adapted.value.selected_seat_id,'empty');assert.equal(adapted.value.candidate_reviews[0].task_coverage,'not_applicable');assert.equal(raw.candidate_reviews[0].task_coverage,'sufficient')
 assertRepairPreservesVerdict(raw,adapted.value,{stage:'condition',candidates,actionHistory:[]})
 assert(adapted.operations.some(x=>x.operation==='derive_empty_action_applicability'))
})
test('unknown or contradictory judgments are not normalized',()=>{
 for(const [recommendations,coverage,combination] of [[[3],'sufficient','not_applicable'],[[],'uncertain','not_applicable'],[[],'sufficient','conflicting']]) {
  const raw=review();Object.assign(raw.candidate_reviews[0],{task_coverage:coverage,combination_assessment:combination})
  const value=adaptEnterpriseOutput(raw,{referenceBinding:{entries:[],review_candidates:[{seat_id:'empty',recommendations}]}}).value
  assert.equal(value.candidate_reviews[0].task_coverage,coverage)
 }
})
test('format repairs preserve selection, verdict and declared necessity; filling missing fields is allowed',()=>{
 const before=review(),after=structuredClone(before);after.candidate_reviews.reverse();assert.doesNotThrow(()=>assertRepairPreservesVerdict(before,after))
 after.selected_seat_id='other';assert.throws(()=>assertRepairPreservesVerdict(before,after),{code:'ENTERPRISE_REVIEW_VERDICT_DRIFT'})
 after.selected_seat_id='empty';after.consistent=false;assert.throws(()=>assertRepairPreservesVerdict(before,after),{code:'ENTERPRISE_REVIEW_VERDICT_DRIFT'})
 before.candidate_reviews[0].action_reviews=[{id:3,necessity:'uncertain'}];after.consistent=true;after.candidate_reviews[0].action_reviews=[{id:3,necessity:'required'}];assert.throws(()=>assertRepairPreservesVerdict(before,after),{code:'ENTERPRISE_REVIEW_VERDICT_DRIFT'})
 delete before.candidate_reviews[0].action_reviews[0].necessity;assert.doesNotThrow(()=>assertRepairPreservesVerdict(before,after))
 assert.equal(repairMode(['语义复核含未授权字段']),'format_only');assert.equal(repairMode(['不得批准仍有方向冲突、行动冲突或重复问题的候选']),'business_reassessment')
})
