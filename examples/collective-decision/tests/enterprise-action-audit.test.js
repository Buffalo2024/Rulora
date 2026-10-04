const test=require('node:test'),assert=require('node:assert/strict')
const {recordActionHistory,flaggedAdditions,validateActionAuditReview}=require('../src/enterprise-action-audit')
const {validateReview,reviewRules,buildReviewPrompt}=require('../src/enterprise-deliberation')
const {assertRepairPreservesVerdict,repairMode}=require('../src/enterprise-review-repair')
const candidate=(seat_id,ids)=>({seat_id,recommendations:ids,actions:ids.map(id=>({id,action:`action ${seat_id} ${id}`})),label_assessments:ids.map(code=>({code,necessary:true}))})
function review(c){return {consistent:true,selected_seat_id:c.seat_id,unresolved_gaps:[],authority:'within_rules',applied_rule_ids:['SUPPORTED_WHOLE_CANDIDATE'],review_reason:'own evidence',candidate_reviews:[{seat_id:c.seat_id,assessment:'supported',independence:'independent',reason:'known facts',task_coverage:'sufficient',combination_assessment:'compatible',combination_reason:'distinct functions',combination_direction_assessment:'compatible',issues:[],action_reviews:c.recommendations.map(id=>({id,assessment:'supported',necessity:'required',omission_impact:'residual gap',direction_assessment:'compatible',reason:'evidence',basis_status:'established',residual_risk_source:'known_fact',known_basis:'publicly disclosed payment dispute',countercheck_status:'adequate',deletion_case:'Known collection work may already suffice',retention_response:'Disclosed outstanding dispute remains'})),boundary_reviews:c.recommendations.flatMap((id,i,ids)=>ids.slice(i+1).map(other=>({action_ids:[id,other],relationship:'independent',reason:'A does not address B residual gap; B does not address A gap'}))),timing_reviews:[]}]}}
test('format repair removes unauthorized scopes while preserving valid business judgments',()=>{
 const c=candidate('a',[2,4]),good=review(c),context={stage:'condition',candidates:[c],actionHistory:[],arbitrationRules:reviewRules('condition')}
 for(const change of [r=>r.candidate_reviews.push({...structuredClone(r.candidate_reviews[0]),seat_id:'ghost'}),r=>r.candidate_reviews[0].action_reviews.push({...structuredClone(r.candidate_reviews[0].action_reviews[0]),id:99}),r=>r.candidate_reviews[0].boundary_reviews.push({action_ids:[2,2],relationship:'independent',reason:'bad pair'})]) {
  const bad=structuredClone(good);change(bad)
  assert(validateReview(bad,[c],'condition',reviewRules('condition'),{requireActionAudit:true}).length)
  assert.equal(repairMode(validateReview(bad,[c],'condition',reviewRules('condition'),{requireActionAudit:true})),'format_only')
  assert.doesNotThrow(()=>assertRepairPreservesVerdict(bad,good,context))
 }
 for(const [field,value] of [['task_coverage','uncertain'],['combination_assessment','conflicting']]) {
  const bad=structuredClone(good);bad.candidate_reviews[0][field]=value
  assert.throws(()=>assertRepairPreservesVerdict(bad,good,context),{code:'ENTERPRISE_REVIEW_VERDICT_DRIFT'})
 }
 const changed=structuredClone(good);changed.candidate_reviews[0].issues=[{kind:'redundant',action_ids:[2,4],reason:'overlap'}]
 assert.throws(()=>assertRepairPreservesVerdict(good,changed,context),{code:'ENTERPRISE_REVIEW_VERDICT_DRIFT'})
 assert.equal(repairMode(['逐席复核须声明独立依据状态']),'format_only')
})

test('unknown wording is not a prose gate; only semantic declarations control approval',()=>{
 const c=candidate('a',[3]),r=review(c);r.candidate_reviews[0].action_reviews[0].known_basis='已披露现金压力，未知内部预算，仅作为执行前提'
 assert.deepEqual(validateActionAuditReview(r,[c]),[])
 r.candidate_reviews[0].action_reviews[0].basis_status='unknown_only'
 assert(validateActionAuditReview(r,[c]).some(x=>x.includes('仅由未知')))
 r.consistent=false;r.selected_seat_id=null
 assert.deepEqual(validateActionAuditReview(r,[c]),[])
})
test('invalid counterargument cannot be delivered even if all old declarations approve',()=>{
 const c=candidate('a',[3]),r=review(c);r.candidate_reviews[0].action_reviews[0].countercheck_status='invalid'
 assert(validateReview(r,[c],'condition',reviewRules('condition'),{requireActionAudit:true}).some(x=>x.includes('反证未通过')))
 r.candidate_reviews[0].action_reviews[0].countercheck_status='no_plausible_alternative'
 assert.deepEqual(validateReview(r,[c],'condition',reviewRules('condition'),{requireActionAudit:true}),[])
})
test('pairwise coverage gates retained overlap without program deletion or code bans',()=>{
 const c=candidate('a',[3,4,8]),r=review(c)
 assert.deepEqual(validateActionAuditReview(r,[c]),[])
 r.candidate_reviews[0].boundary_reviews.pop()
 assert(validateActionAuditReview(r,[c]).some(x=>x.includes('逐对覆盖')))
 r.candidate_reviews[0].boundary_reviews.push({action_ids:[4,8],relationship:'overlapping',reason:'Both release investment at payment milestones'})
 assert(validateActionAuditReview(r,[c]).some(x=>x.includes('边界重叠')))
 assert.deepEqual(c.recommendations,[3,4,8])
 r.consistent=false;r.selected_seat_id=null
 assert.deepEqual(validateActionAuditReview(r,[c]),[])
})
test('temporal record uses delivered input, not simultaneous peer output or unchanged placeholders',()=>{
 const history=[],receipts={},before=[candidate('a',[3]),candidate('b',[3])];recordActionHistory(history,[],before,0)
 const first=[candidate('a',[3,8]),candidate('b',[3,8])]
 recordActionHistory(history,before,first,1,{a:[{...before[1],candidate_version:'b0'}],b:[{...before[0],candidate_version:'a0'}]},receipts)
 assert.equal(flaggedAdditions(history,first[0]).length,0)
 const second=[candidate('a',[3,8]),candidate('b',[3])];recordActionHistory(history,first,second,2,{b:[{...first[0],candidate_version:'a1'}]},receipts)
 const third=[candidate('a',[3,8]),candidate('b',[3,8])];recordActionHistory(history,second,third,3,{b:[{seat_id:'a',candidate_version:'a1',unchanged:true}]},receipts)
 const flag=flaggedAdditions(history,third[1])[0];assert.equal(flag.round,3);assert.equal(flag.received_same_code[0].candidate_version,'a1');assert.deepEqual(flag.received_same_code[0].action_snapshot,first[0].actions[1])
})
test('flagged additions require review but legitimate independent additions remain allowed',()=>{
 const c=candidate('a',[3,8]),r=review(c),history=[{seat_id:'a',code:8,kind:'added',round:2,received_same_code:[{seat_id:'b'}]}]
 assert(validateActionAuditReview(r,[c],history).some(x=>x.includes('时序标记')))
 r.candidate_reviews[0].timing_reviews=[{code:8,assessment:'independent',reason:'Own disclosed delivery gap remains after action3'}]
 assert.deepEqual(validateActionAuditReview(r,[c],history),[])
 r.candidate_reviews[0].timing_reviews[0].assessment='peer_only'
 assert(validateActionAuditReview(r,[c],history).some(x=>x.includes('仅来自同行')))
})
test('format-only repairs cannot silently change new semantic verdicts',()=>{
 const c=candidate('a',[3,8]),r=review(c),copy=structuredClone(r)
 copy.candidate_reviews[0].action_reviews[0].basis_status='unknown_only'
 assert.throws(()=>assertRepairPreservesVerdict(r,copy),{code:'ENTERPRISE_REVIEW_VERDICT_DRIFT'})
 copy.candidate_reviews[0].action_reviews[0].basis_status='established';copy.candidate_reviews[0].boundary_reviews[0].relationship='overlapping'
 assert.throws(()=>assertRepairPreservesVerdict(r,copy),{code:'ENTERPRISE_REVIEW_VERDICT_DRIFT'})
 assert.equal(repairMode(['行动审查须声明已知依据、删除解释及保留回应']),'format_only')
 assert.equal(repairMode(['不得批准边界重叠或独立作用未决的组合']),'business_reassessment')
})
test('review gets objections and history without adding them to seat broadcasts',()=>{
 const history=[{seat_id:'a',code:8,kind:'added',round:2,received_same_code:[{seat_id:'b'}]}],exchangeReviews=[{round:1,responses:[{seat_id:'b',review_summary:'Action4 covers action8'}]}]
 const prompt=buildReviewPrompt({stage:'condition',policy:'',question:{},rules:[],arbitrationRules:reviewRules('condition'),candidates:[candidate('a',[3,8])],evidence:[],actionHistory:history,exchangeReviews})
 const input=JSON.parse(prompt[1].content);assert.deepEqual(input.action_history,[{seat_id:'a',code:8,round:2,kind:'added',received_same_code:[{received:true}]}]);assert.equal(input.exchange_reviews[0].responses[0].review_summary,undefined)
 assert(input.review_output_contract.action_reviews.fields.includes('basis_status'))
})

test('condition review gets one latest response per seat instead of repeated endorsements',()=>{
 const responses=[{round:1,responses:[{seat_id:'a',review_summary:'old opinion'},{seat_id:'b',review_summary:'coverage objection'}]},{round:2,responses:[{seat_id:'a',review_summary:'latest opinion'}]}]
 const input=JSON.parse(buildReviewPrompt({stage:'condition',policy:'',question:{},rules:[],arbitrationRules:reviewRules('condition'),candidates:[],evidence:[],exchangeReviews:responses})[1].content)
 assert.equal(input.exchange_reviews.length,2)
 assert.equal(input.exchange_reviews.find(x=>x.responses[0].seat_id==='a').round,2)
 assert.equal(input.exchange_reviews.find(x=>x.responses[0].seat_id==='a').responses[0].review_summary,undefined)
 assert.equal(input.exchange_reviews.find(x=>x.responses[0].seat_id==='b').responses[0].review_summary,undefined)
})

test('risk-response standard reaches initial, exchange and review without changing scope or contract',()=>{
 const {buildSeatPrompt,NECESSITY_POLICY,VERSION}=require('../src/enterprise-deliberation')
 const {stageInstruction}=require('../src/enterprise-action-contract')
 const base={agent:{agent_id:'chain_risk',label:'产业链风险席',lens:'供应与回款传导'},stage:'condition',question:{},company:{},rules:[],experience:[],evidence:[],prior:{code:0,version:'frozen'},policy:'',stageInstruction}
 const initial=JSON.parse(buildSeatPrompt(base)[1].content)
 const exchange=JSON.parse(buildSeatPrompt({...base,review:true,own:candidate('chain_risk',[3]),peers:[],broadcastVersion:'b'})[1].content)
 const reviewed=JSON.parse(buildReviewPrompt({stage:'condition',policy:'',question:{},rules:[],arbitrationRules:reviewRules('condition'),candidates:[candidate('chain_risk',[3])],evidence:[]})[1].content)
 for(const input of [initial,exchange,reviewed])assert.deepEqual(input.necessity_policy,NECESSITY_POLICY)
 assert.equal(initial.differences,undefined);assert.equal(exchange.broadcast_version,'b');assert.equal(reviewed.review_method_version,VERSION)
 assert.equal(reviewed.review_output_contract.outer_fields[0],'candidate_reviews')
 assert.equal(exchange.output_contract.recommendations.max_items,undefined)
 assert(reviewed.review_output_contract.candidate_reviews.task_coverage_meaning.includes('仅本席位'))
})
test('program does not rank smaller or wider candidates and does not interpret arrangement prose',()=>{
 const small=candidate('small',[3]),wide=candidate('wide',[2,3,4]);const r=review(small)
 r.candidate_reviews.push(review(wide).candidate_reviews[0])
 r.candidate_reviews[0].action_reviews[0].retention_response='未披露内部安排，不能假定不足；已披露逾期争议仍需核对处置'
 for(const id of ['small','wide']){
  r.selected_seat_id=id
  assert.deepEqual(validateReview(r,[small,wide],'condition',reviewRules('condition'),{requireActionAudit:true}),[])
 }
 r.candidate_reviews[1].action_reviews[0].basis_status='unknown_only'
 assert(validateReview(r,[small,wide],'condition',reviewRules('condition'),{requireActionAudit:true}).some(e=>e.includes('仅由未知')))
 assert.deepEqual(wide.recommendations,[2,3,4])
})
test('a debt-maturity addition remains open through exchange and candidate gates',()=>{
 const {validateExchange,validateAnalysis,candidatePayload}=require('../src/enterprise-deliberation')
 const {validateCandidate}=require('../src/enterprise-decision')
 const prior={code:0,version:'frozen'},ids=new Set(['bond'])
 function make(codes){return {seat_id:'seat',recommendations:codes,reason:'债券到期与已提出偿付预案需要落实',seat_summary:'核对既有预案和到期时点',evidence_refs:['bond'],gaps:[],assumptions:[],direction_version:prior.version,
  factors:[{name:'到期义务',mechanism:'固定到期日要求明确兑现安排',effect:'negative',evidence_refs:['bond']}],
  actions:codes.map(id=>({id,target:id===3?'存量应收':'债务到期与预案',scope:'partial',time_range:'未来12个月',action:id===3?'催收已形成的应收账款':'按到期日落实已提出的偿付来源与未转股时的备选安排',effect:'protect',readiness:'conditional',prerequisites:['核对经营是否落实及实际转股余额'],evidence_refs:['bond'],direction_relation:'保障维持经营规模'})),
  label_assessments:codes.map(code=>({code,necessary:true,why_required:['已知到期义务具有明确时间要求'],why_deletable:[],evidence_refs:['bond']}))}}
 const own=make([3]),added=make([3,7])
 const value={review_decision:'revise',revision_kind:'substantive',broadcast_version:'seen',review_summary:'既有催收不解决十一月到期债券的落实偿付来源问题',candidate:candidatePayload(added,'condition'),addition_basis:[{code:7,lens_gap:'到期兑付时点与实际转股余额',why_existing_insufficient:'存量催收不能落实已提出的偿债预案与备选触发安排',evidence_refs:['bond']}]}
 const args={stage:'condition',own,peers:[],broadcastVersion:'seen',validate:c=>[...validateCandidate(c,'condition',ids,prior),...validateAnalysis(c,'condition',ids)]}
 assert.deepEqual(validateExchange(value,args),[])
 value.addition_basis=[]
 assert(validateExchange(value,args).some(e=>e.includes('新增行动')))
})
test('v75 missing source is format-only; acknowledged unknown or absent residual cannot be approved',()=>{
 const c=candidate('a',[3]),r=review(c),a=r.candidate_reviews[0].action_reviews[0]
 delete a.residual_risk_source
 let errors=validateActionAuditReview(r,[c]);assert.equal(repairMode(errors),'format_only')
 a.residual_risk_source='known_fact';assert.deepEqual(validateActionAuditReview(r,[c]),[])
 for(const source of ['unknown_sufficiency','no_residual_risk']){
  a.residual_risk_source=source;errors=validateActionAuditReview(r,[c]);assert(errors.includes('被选行动须有已知剩余风险，不能以未知充分性或无剩余风险支撑保留'));assert.equal(repairMode(errors),'business_reassessment')
 }
 r.consistent=false;r.selected_seat_id=null
 assert(validateActionAuditReview(r,[c]).includes('无剩余风险不得同时声明行动必要'))
 a.necessity='optional';assert.deepEqual(validateActionAuditReview(r,[c]),[])
 a.residual_risk_source='unknown_sufficiency';a.necessity='uncertain';assert.deepEqual(validateActionAuditReview(r,[c]),[])
})
test('v75 source and alternative object survive raw recovery, adapter and verdict protection',()=>{
 const {recoverEnterpriseOutput,adaptEnterpriseOutput}=require('../src/enterprise-output-protocol')
 const c=candidate('a',[3]),before=review(c)
 before.candidate_reviews[0].comparison_to_selected={relation:'not_comparable',alternative_object:'existing disputed receivable',reason:'specific object'}
 const recovered=recoverEnterpriseOutput('```json\n'+JSON.stringify(before)+'\n```')
 const adapted=adaptEnterpriseOutput(recovered.value,{operation:'semantic_review'}).value
 assert.equal(adapted.candidate_reviews[0].action_reviews[0].residual_risk_source,'known_fact')
 assert.equal(adapted.candidate_reviews[0].comparison_to_selected.alternative_object,'existing disputed receivable')
 const context={stage:'condition',candidates:[c]};assertRepairPreservesVerdict(before,adapted,context)
 const changed=structuredClone(adapted);changed.candidate_reviews[0].action_reviews[0].residual_risk_source='unknown_sufficiency'
 assert.throws(()=>assertRepairPreservesVerdict(before,changed,context),{code:'ENTERPRISE_REVIEW_VERDICT_DRIFT'})
 changed.candidate_reviews[0].action_reviews[0].residual_risk_source='known_fact';delete changed.candidate_reviews[0].comparison_to_selected.alternative_object
 assert.throws(()=>assertRepairPreservesVerdict(before,changed,context),{code:'ENTERPRISE_REVIEW_VERDICT_DRIFT'})
})
