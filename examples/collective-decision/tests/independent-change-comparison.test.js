const test=require('node:test'),assert=require('node:assert/strict')
const d=require('../src/enterprise-deliberation')
test('noncomparable supported scopes require equivalent choice, not a unique quality winner',()=>{
 const candidates=[{seat_id:'a',recommendations:[4]},{seat_id:'b',recommendations:[2]}]
 const value={consistent:true,selected_seat_id:'a',selection_mode:'quality_difference',candidate_reviews:[{seat_id:'a',assessment:'supported',comparison_to_selected:{relation:'selected',reason:'chosen whole candidate'}},{seat_id:'b',assessment:'supported',comparison_to_selected:{relation:'not_comparable',alternative_object:'separate existing contract exposure',reason:'different known objects; no cross-scope ranking'}}]}
 assert(d.validateSelectionComparison(value,candidates).some(e=>e.includes('不得将等效')))
 value.selection_mode='equivalent_choice';assert.deepEqual(d.validateSelectionComparison(value,candidates),[])
 value.selection_mode='quality_difference';value.candidate_reviews[1].comparison_to_selected={relation:'weaker',shared_object:'same purchase commitment',quality_basis:'execution_boundary',reason:'LLM assesses the concrete execution distinction',candidate_action_ids:[2],selected_action_ids:[4]}
 assert.deepEqual(d.validateSelectionComparison(value,candidates),[])
 value.candidate_reviews[1].comparison_to_selected.shared_object=null
 assert(d.validateSelectionComparison(value,candidates).some(e=>e.includes('共同具体对象')))
 assert.doesNotThrow(()=>d.validateSelectionComparison({...value,candidate_reviews:[null]}))
})
test('format repairs cannot change declared comparison relations or selection modes',()=>{
 const {assertRepairPreservesVerdict}=require('../src/enterprise-review-repair')
 const old={selection_mode:'equivalent_choice',candidate_reviews:[{seat_id:'a',comparison_to_selected:{relation:'not_comparable',shared_object:null}}]}
 const updated=structuredClone(old);updated.selection_mode='quality_difference'
 assert.throws(()=>assertRepairPreservesVerdict(old,updated,{stage:'condition',candidates:[{seat_id:'a',recommendations:[4]}]}),{code:'ENTERPRISE_REVIEW_VERDICT_DRIFT'})
 updated.selection_mode=old.selection_mode;updated.candidate_reviews[0].comparison_to_selected.relation='weaker'
 assert.throws(()=>assertRepairPreservesVerdict(old,updated,{stage:'condition',candidates:[{seat_id:'a',recommendations:[4]}]}),{code:'ENTERPRISE_REVIEW_VERDICT_DRIFT'})
})
test('changed peer delivers only changed assertions without action codes or necessity endorsements',()=>{
 const prior={recommendations:[2,4],actions:[{id:2,action:'priority',evidence_refs:['e']},{id:4,action:'investment',evidence_refs:['e']}],label_assessments:[{code:2,necessary:true}],evidence_refs:['e'],seat_summary:'initial'}
 const next={...structuredClone(prior),seat_id:'peer',recommendations:[2,4,7],actions:[...prior.actions,{id:7,action:'repayment',evidence_refs:['bond']}],evidence_refs:['e','bond'],seat_summary:'expanded'}
 const delivery=d.peerDelivery([next],'condition',{peer:d.discussionVersion(prior,'condition')},{peer:prior})[0]
 const view=d.peerChangeView(delivery,'condition')
 assert.deepEqual(view.action_statements,[{action:'repayment',evidence_refs:['bond']}])
 assert.deepEqual(view.evidence_refs,['bond'])
 assert.equal(view.label_assessments,undefined);assert.equal(view.recommendations,undefined);assert.equal(view.seat_summary,'expanded')
 assert.deepEqual(delivery.actions,next.actions) // audit retains exact full input
 assert.deepEqual(prior.recommendations,[2,4])
})
test('withdrawals are explicit and previously unseen peers receive their full substantive opinion',()=>{
 const previous={actions:[{id:4,action:'old'}],recommendations:[4]}
 const peer={seat_id:'peer',recommendations:[2],actions:[{id:2,action:'new'}],seat_summary:'scope judgment'}
 const first=d.peerChangeView(d.peerDelivery([peer],'condition')[0],'condition')
 assert.equal(first.seat_summary,'scope judgment');assert.deepEqual(first.action_statements,[{action:'new'}])
 const delta=d.peerChangeView(d.peerDelivery([peer],'condition',{peer:'old'},{peer:previous})[0],'condition')
 assert.deepEqual(delta.withdrawn_actions,[{action:'old'}])
 const unchanged=d.peerDelivery([peer],'condition',{peer:d.discussionVersion(peer,'condition')},{peer:previous})[0]
 assert.equal(d.peerChangeView(unchanged,'condition').unchanged,true)
})
test('changed arguments remain available while pure necessity endorsements are not repeated',()=>{
 const old={actions:[{id:4,target:'equipment',action:'staged purchase'}],recommendations:[4],label_assessments:[{code:4,necessary:true,why_required:['known payment'],why_deletable:['existing arrangement']}],seat_summary:'original'}
 const updated={...structuredClone(old),seat_id:'peer'}
 updated.label_assessments[0].necessary=false
 assert.equal(d.conditionChanges(old,updated).label_assessments.length,0)
 updated.label_assessments[0].why_deletable=['signed obligation already covers the risk'];updated.seat_summary='new counterargument'
 const view=d.peerChangeView({...updated,change_set:d.conditionChanges(old,updated)},'condition')
 assert.equal(view.seat_summary,'new counterargument')
 assert.deepEqual(view.argument_statements[0].why_deletable,['signed obligation already covers the risk'])
 assert.equal(view.argument_statements[0].necessary,undefined);assert.equal(view.argument_statements[0].code,undefined)
 assert.equal(view.action_statements.length,0)
})
test('review keeps current candidate and timing facts without replaying peer persuasion',()=>{
 const c={seat_id:'a',recommendations:[7],actions:[{id:7}],seat_summary:'current'}
 const h=[{seat_id:'a',code:7,kind:'added',round:1,received_same_code:[{seat_id:'b',action_snapshot:{action:'PEER_PERSUASION'}}]}]
 const p=d.buildReviewPrompt({stage:'condition',policy:'',question:{},rules:[],arbitrationRules:d.reviewRules('condition'),candidates:[c],evidence:[],actionHistory:h,exchangeReviews:[{round:1,responses:[{seat_id:'a',review_decision:'revise',review_summary:'HISTORICAL_PERSUASION'}]}]})
 const input=JSON.parse(p[1].content)
 assert.equal(input.candidates[0].recommendations[0],7)
 assert.equal(input.action_history[0].code,7)
 assert(!JSON.stringify(input).includes('PEER_PERSUASION'));assert(!JSON.stringify(input).includes('HISTORICAL_PERSUASION'))
})

test('quality comparison binds actual candidates and rejects foreign, empty or no-advice locators',()=>{
 const candidates=[{seat_id:'a',recommendations:[4]},{seat_id:'b',recommendations:[2]}]
 const value={consistent:true,selected_seat_id:'a',selection_mode:'quality_difference',candidate_reviews:[{seat_id:'a',assessment:'supported',comparison_to_selected:{relation:'selected',reason:'selected'}},{seat_id:'b',assessment:'supported',comparison_to_selected:{relation:'weaker',shared_object:'same equipment purchase',quality_basis:'execution_boundary',reason:'concrete difference',candidate_action_ids:[2],selected_action_ids:[4]}}]}
 assert.deepEqual(d.validateSelectionComparison(value,candidates),[])
 for(const ids of [[],[10],[4],[2,2]]){value.candidate_reviews[1].comparison_to_selected.candidate_action_ids=ids;assert(d.validateSelectionComparison(value,candidates).includes('质量比较须绑定双方候选中已有的实际行动'))}
})
test('format repair cannot rewrite judgment prose under unchanged enums; missing prose may be filled',()=>{
 const {assertRepairPreservesVerdict}=require('../src/enterprise-review-repair')
 const before={consistent:true,review_reason:'existing action has known residual risk',candidate_reviews:[{seat_id:'a',assessment:'supported',comparison_to_selected:{relation:'selected',reason:'same object comparison'},action_reviews:[{id:4,necessity:'required',retention_response:'known obligation remains'}]}]}
 const context={stage:'condition',candidates:[{seat_id:'a',recommendations:[4]}]}
 const after=structuredClone(before);after.candidate_reviews[0].action_reviews[0].retention_response='unknown arrangements justify necessity'
 assert.throws(()=>assertRepairPreservesVerdict(before,after,context),{code:'ENTERPRISE_REVIEW_VERDICT_DRIFT'})
 after.candidate_reviews[0].action_reviews[0].retention_response='known obligation remains';after.candidate_reviews[0].action_reviews[0].deletion_case='new missing field'
 assert.doesNotThrow(()=>assertRepairPreservesVerdict(before,after,context))
})
test('v75 incomparable object is required without program keyword semantics',()=>{
 const {repairMode}=require('../src/enterprise-review-repair')
 const v={consistent:true,selected_seat_id:'a',selection_mode:'equivalent_choice',candidate_reviews:[{seat_id:'a',assessment:'supported',comparison_to_selected:{relation:'selected',reason:'selected'}},{seat_id:'b',assessment:'supported',comparison_to_selected:{relation:'not_comparable',reason:'scope'}}]}
 assert.equal(repairMode(d.validateSelectionComparison(v)),'format_only')
 v.candidate_reviews[1].comparison_to_selected.alternative_object='disclosed regulatory approval'
 assert.deepEqual(d.validateSelectionComparison(v),[])
 v.candidate_reviews[1].comparison_to_selected.alternative_object='不同视角'
 assert.deepEqual(d.validateSelectionComparison(v),[]) // quality remains semantic review, never a keyword gate
})
