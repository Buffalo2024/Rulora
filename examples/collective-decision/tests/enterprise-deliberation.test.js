const test=require('node:test'),assert=require('node:assert/strict')
const d=require('../src/enterprise-deliberation')
test('direction boundaries reach initial seats, peer exchanges and review through one shared policy',()=>{
 const {stageInstruction,DIRECTION_POLICY}=require('../src/enterprise-action-contract')
 const base={agent:{label:'测试',lens:'经营'},stage:'direction',question:{},company:{},policy:'',stageInstruction,evidence:[]}
 const initial=JSON.parse(d.buildSeatPrompt(base)[1].content)
 const exchange=JSON.parse(d.buildSeatPrompt({...base,review:true,own:{direction:1},peers:[{seat_id:'b',direction:0}],round:1})[1].content)
 const review=JSON.parse(d.buildReviewPrompt({stage:'direction',policy:'',question:{},rules:[],arbitrationRules:d.reviewRules('direction'),candidates:[],evidence:[]})[1].content)
 for(const input of [initial,exchange,review]) assert.deepEqual(input.direction_policy,DIRECTION_POLICY)
 assert.equal(exchange.own.direction,1);assert.equal(exchange.differences[0].direction,0)
 assert.equal(review.review_output_contract.outer_fields.includes('direction_policy'),false)
})
test('direction comparison stays outside condition prompts and does not widen output contracts',()=>{
 const {stageInstruction}=require('../src/enterprise-action-contract')
 const base={agent:{label:'测试',lens:'经营'},stage:'condition',policy:'',stageInstruction,evidence:[]}
 for(const p of [d.buildSeatPrompt(base),d.buildSeatPrompt({...base,review:true,own:{},peers:[]}),d.buildReviewPrompt({stage:'condition',policy:'',question:{},rules:[],arbitrationRules:d.reviewRules('condition'),candidates:[],evidence:[]})]) {
  assert.equal(Object.hasOwn(JSON.parse(p[1].content),'direction_policy'),false)
 }
 const prompt=d.buildReviewPrompt({stage:'direction',policy:'',question:{},rules:[],arbitrationRules:d.reviewRules('direction'),candidates:[],evidence:[]})
 assert.match(prompt[0].content,/替代方案最强论据/)
 assert.match(prompt[0].content,/不行动代价/)
 assert.match(prompt[0].content,/不强求唯一正确/)
 assert.deepEqual(JSON.parse(prompt[1].content).review_output_contract.candidate_reviews.fields,['seat_id','assessment','independence','reason'])
})
test('direction gate permits competing supported judgments without prose parsing or forced unanimity',()=>{
 const candidates=[{seat_id:'growth',direction:1},{seat_id:'operations',direction:0}]
 const review={consistent:true,selected_seat_id:'growth',authority:'within_rules',unresolved_gaps:[],applied_rule_ids:['SUPPORTED_WHOLE_CANDIDATE'],review_reason:'两者均有依据，比较启动范围后选择拓展，仍有不确定性',candidate_reviews:candidates.map(c=>({seat_id:c.seat_id,assessment:'supported',independence:'independent',reason:'独立依据'})),revision_requests:[]}
 assert.deepEqual(d.validateReview(review,candidates,'direction',d.reviewRules('direction')),[])
 review.selected_seat_id='operations';review.review_reason='不同判断由模型说明'
 assert.deepEqual(d.validateReview(review,candidates,'direction',d.reviewRules('direction')),[])
 review.selected_seat_id='composed'
 assert(d.validateReview(review,candidates,'direction',d.reviewRules('direction')).some(x=>x.includes('未知候选')))
})
test('maintain requires a version acknowledgement and forbids replacing a frozen candidate',()=>{
 const args={stage:'direction',broadcastVersion:'v1',validate:()=>[]}
 assert.deepEqual(d.validateExchange({review_decision:'maintain',broadcast_version:'v1',review_summary:'维持',candidate:null},args),[])
 assert.ok(d.validateExchange({review_decision:'maintain',broadcast_version:'old',review_summary:'维持',candidate:{direction:1}},args).length>=2)
})
test('peer version ignores pipeline metadata but includes changed evidence and full action text',()=>{
 const a={seat_id:'a',direction:1,reason:'原理由'},b={seat_id:'b',direction:1,reason:'原理由'}
 const v=d.inputVersion([a,b],'a','direction',{evidence:'v1'})
 b.checkpoint={time:'different'}
 assert.equal(d.inputVersion([a,b],'a','direction',{evidence:'v1'}),v)
 b.reason='新反证导致新解释'
 assert.notEqual(d.inputVersion([a,b],'a','direction',{evidence:'v1'}),v)
 assert.notEqual(d.inputVersion([a,b],'a','direction',{evidence:'v2'}),v)
})
test('Risk core checks item coverage without deciding semantic necessity from labels',()=>{
 const c={seat_summary:'摘要',recommendations:[3,6,8],evidence_refs:['e'],label_assessments:[3,6,8].map(code=>({code,necessary:false,why_required:['必要性有争议'],why_deletable:['可能可以删除'],counter_evidence:[],evidence_refs:['e']})),combination_reason:'交给模型复核争议'}
 assert.deepEqual(d.validateAnalysis(c,'condition',new Set(['e'])),[])
 c.label_assessments.pop()
 assert.ok(d.validateAnalysis(c,'condition',new Set(['e'])).some(e=>e.includes('覆盖')))
})
test('review cannot pass an unknown rule or select unsupported actions',()=>{
 const c={seat_id:'a',recommendations:[3],actions:[{id:3}]}
 const r={consistent:true,selected_seat_id:'a',unresolved_gaps:[],authority:'within_rules',applied_rule_ids:['invented'],review_reason:'理由',candidate_reviews:[{seat_id:'a',assessment:'supported',independence:'independent',reason:'理由',action_reviews:[{id:3,assessment:'unsupported',reason:'反证'}],issues:[],combination_assessment:'compatible',combination_reason:'组合理由'}]}
 const errors=d.validateReview(r,[c],'condition',d.REVIEW_RULES)
 assert.ok(errors.some(e=>e.includes('未授权')))
 assert.ok(errors.some(e=>e.includes('逐项通过')))
})
test('runtime state exposes frozen/reactivated labels and current exchange round',async()=>{
 const {WebJobManager}=require('../src/web-job-manager')
 const job={agent_states:{a:{agent_id:'a',status:'idle'}},events:[],progress_percent:0}
 const logs=[]
 const manager={mutateJob:async(_id,fn)=>fn(job),appendLog:async(_job,text)=>logs.push(text)}
 const progress=event=>WebJobManager.prototype.recordProgress.call(manager,'job',event)
 await progress({type:'agent_started',agent_id:'a',phase:'condition_self_review',round:7,max_rounds:10})
 await progress({type:'seat_frozen',agent_id:'a',phase:'condition_self_review',round:7,broadcast_version:'v7'})
 assert.equal(job.agent_states.a.status,'frozen');assert.equal(job.agent_states.a.exchange_round,7);assert.equal(job.agent_states.a.max_exchange_rounds,10)
 assert.equal(job.events.at(-1).broadcast_version,'v7')
 await progress({type:'seat_reactivated',agent_id:'a',phase:'condition_self_review',round:8})
 assert.equal(job.agent_states.a.status,'reactivated')
 assert.ok(logs.some(x=>x.includes('重新复审')))
})
test('condition context omits first-layer audits and separates exchange schema from initial instructions',()=>{
 const {stageInstruction}=require('../src/enterprise-action-contract')
 const prior={version:'v',code:0,time_range:'12m',reason:'方向依据',candidates:[{reason:'DUPLICATE_AUDIT'}],initial_candidates:['DUPLICATE_AUDIT'],semantic_review:{review_reason:'DUPLICATE_AUDIT'}}
 const own={recommendations:[3],actions:[{id:3}],seat_summary:'摘要'}
 const p=d.buildSeatPrompt({agent:{label:'测试',lens:'风险'},stage:'condition',review:true,prior,own,peers:[{seat_id:'b',...own,reason:'DUPLICATE_REASON',factors:[{}]}],policy:'政策',stageInstruction})
 const input=JSON.parse(p[1].content)
 assert(!JSON.stringify(p).includes('DUPLICATE_AUDIT'));assert(!JSON.stringify(p).includes('DUPLICATE_REASON'))
 assert.equal(input.output_contract.recommendations.max_items,undefined)
 assert(!p[0].content.includes('上限3项'));assert(!p[0].content.includes('先判断哪些关键目标'))
 assert.deepEqual(input.differences[0].action_statements,[{}]);assert.equal(input.differences[0].recommendations,undefined);assert.equal(input.action_options.length,13)
})
test('review cannot approve merely supported optional actions; necessity remains model-declared',()=>{
 const c={seat_id:'a',recommendations:[3]};const r={consistent:true,selected_seat_id:'a',unresolved_gaps:[],authority:'within_rules',applied_rule_ids:['SUPPORTED_WHOLE_CANDIDATE'],review_reason:'理由',candidate_reviews:[{seat_id:'a',assessment:'supported',independence:'independent',reason:'支持',task_coverage:'sufficient',action_reviews:[{id:3,assessment:'supported',reason:'有益',direction_assessment:'compatible',necessity:'optional',omission_impact:'删除不影响目标'}],issues:[],combination_assessment:'compatible',combination_reason:'无冲突'}]}
 assert(d.validateReview(r,[c],'condition',d.REVIEW_RULES).some(e=>e.includes('各项必要')))
 r.candidate_reviews[0].action_reviews[0].necessity='required'
 assert.deepEqual(d.validateReview(r,[c],'condition',d.REVIEW_RULES),[])
 r.candidate_reviews[0].action_reviews=[null];assert.doesNotThrow(()=>d.validateReview(r,[c],'condition',d.REVIEW_RULES))
})
test('condition freeze version tracks exactly broadcast content rather than omitted audit text',()=>{
 const a={seat_id:'a',recommendations:[3],seat_summary:'摘要',actions:[{id:3,action:'核对应收'}],reason:'冗余理由',factors:[]}
 const v=d.inputVersion([a],'b','condition',{evidence:'v'})
 a.reason='仅审计理由措辞改变';a.factors=[{name:'审计展开'}]
 assert.equal(d.inputVersion([a],'b','condition',{evidence:'v'}),v)
 a.actions[0].action='调整收款安排'
 assert.notEqual(d.inputVersion([a],'b','condition',{evidence:'v'}),v)
})
test('final selection cannot silently override a proposing seat explicit non-necessity flag',()=>{
 const c={seat_id:'a',recommendations:[3],label_assessments:[{code:3,necessary:false}]}
 const r={consistent:true,selected_seat_id:'a',unresolved_gaps:[],authority:'within_rules',applied_rule_ids:['SUPPORTED_WHOLE_CANDIDATE'],review_reason:'复核认为必要',candidate_reviews:[{seat_id:'a',assessment:'supported',independence:'independent',reason:'支持',task_coverage:'sufficient',action_reviews:[{id:3,assessment:'supported',direction_assessment:'compatible',necessity:'required',omission_impact:'关键风险遗漏',reason:'依据'}],issues:[],combination_assessment:'compatible',combination_reason:'无冲突'}]}
 assert(d.validateReview(r,[c],'condition',d.REVIEW_RULES).some(e=>e.includes('返回原席修订')))
})
test('assessment code type errors give actionable feedback without coercing model output',()=>{
 const c={seat_summary:'摘要',recommendations:[3],evidence_refs:['e'],label_assessments:[{code:'3',necessary:true,why_required:['关键风险'],why_deletable:['有替代安排'],counter_evidence:[],evidence_refs:['e']}],combination_reason:'依据'}
 assert(d.validateAnalysis(c,'condition',new Set(['e'])).some(e=>e.includes('整数编号，不能是字符串')))
 assert.equal(c.label_assessments[0].code,'3')
})

test('model-declared direction and pair conflicts cannot pass; program does not infer business meaning',()=>{
 const c={seat_id:'a',recommendations:[2,4]};const r={consistent:true,selected_seat_id:'a',unresolved_gaps:[],authority:'within_rules',applied_rule_ids:['SUPPORTED_WHOLE_CANDIDATE'],review_reason:'依据',candidate_reviews:[{seat_id:'a',assessment:'supported',independence:'independent',reason:'依据',task_coverage:'sufficient',action_reviews:[2,4].map(id=>({id,assessment:'supported',reason:'依据',necessity:'required',omission_impact:'关键风险',direction_assessment:'compatible'})),issues:[],combination_assessment:'compatible',combination_reason:'依据'}]}
 assert.deepEqual(d.validateReview(r,[c],'condition',d.REVIEW_RULES),[])
 r.candidate_reviews[0].action_reviews[0].direction_assessment='conflicting'
 assert.ok(d.validateReview(r,[c],'condition',d.REVIEW_RULES).some(x=>x.includes('第一层方向')))
 r.candidate_reviews[0].action_reviews[0].direction_assessment='compatible'
 r.candidate_reviews[0].issues=[{kind:'action_conflict',action_ids:[2,4],reason:'同一对象执行条件互斥'}]
 assert.ok(d.validateReview(r,[c],'condition',d.REVIEW_RULES).some(x=>x.includes('仍有方向冲突')))
 r.consistent=false;r.selected_seat_id=null
 assert.deepEqual(d.validateReview(r,[c],'condition',d.REVIEW_RULES),[])
 r.candidate_reviews[0].issues[0].action_ids=[99]
 assert.ok(d.validateReview(r,[c],'condition',d.REVIEW_RULES).some(x=>x.includes('绑定已有行动')))
})

test('optional combination narrative may be null without blocking an otherwise valid proposal',()=>{
 const c={seat_summary:'摘要',recommendations:[3],evidence_refs:['E'],label_assessments:[{code:3,necessary:true,why_required:['关键现金风险'],evidence_refs:['E']}],combination_reason:null}
 assert.deepEqual(d.validateAnalysis(c,'condition',new Set(['E'])),[])
 c.combination_reason='';assert.deepEqual(d.validateAnalysis(c,'condition',new Set(['E'])),[])
 c.combination_reason=['各项相互补充且不构成总体扩张'];assert.deepEqual(d.validateAnalysis(c,'condition',new Set(['E'])),[])
 c.combination_reason={};assert.ok(d.validateAnalysis(c,'condition',new Set(['E'])).length)
})

test('necessity uncertainty may be declared without inventing a required-action rationale',()=>{
 const c={seat_summary:'合作只有一般益处，独立必要性未成立',recommendations:[6],evidence_refs:['E'],label_assessments:[{code:6,necessary:false,why_required:[],evidence_refs:['E']}]}
 assert.deepEqual(d.validateAnalysis(c,'condition',new Set(['E'])),[])
 c.label_assessments[0].necessary=true
 assert(d.validateAnalysis(c,'condition',new Set(['E'])).some(x=>x.includes('未被覆盖')))
})

test('broadcast retains the proposer necessity dispute without semantic coercion',()=>{
 const a={seat_id:'a',recommendations:[6],seat_summary:'有政策机会，但不代表必须合作',actions:[{id:6}],label_assessments:[{code:6,necessary:false,why_required:[],evidence_refs:['E']}]}
 const peer=d.peerSummary(a,'condition')
 assert.equal(peer.label_assessments[0].necessary,false)
 const before=d.inputVersion([a],'b','condition',{})
 a.label_assessments[0].necessary=true;a.label_assessments[0].why_required=['模型提出新的独立依据']
 assert.notEqual(d.inputVersion([a],'b','condition',{}),before)
})

test('stage-scoped rules and review input exclude condition-only requirements from direction',()=>{
 const input={policy:'',question:{},rules:[],arbitrationRules:d.REVIEW_RULES,candidates:[],evidence:[]}
 const first=d.buildReviewPrompt({...input,stage:'direction'})
 assert(!Object.hasOwn(JSON.parse(first[1].content),'frozen_direction'))
 assert(!JSON.parse(first[1].content).arbitration_rules.some(r=>r.id==='CONDITIONAL_ACTIONS'))
 assert(!d.reviewRules('direction').some(r=>r.id==='CONDITIONAL_ACTIONS'))
 assert(d.reviewRules('condition').some(r=>r.id==='CONDITIONAL_ACTIONS'))
 assert.match(d.buildReviewPrompt({...input,stage:'condition'})[0].content,/无须|不构成缺少授权/)
 assert(!d.exchangeInstruction('direction').includes('recommendations'))
 assert(!d.exchangeInstruction('condition').includes('direction:null'))
})

test('condition broadcast transmits factor enums and nested action contracts',()=>{
 const {stageInstruction}=require('../src/enterprise-action-contract')
 const p=d.buildSeatPrompt({agent:{label:'测试',lens:'经营'},stage:'condition',review:true,own:{},peers:[],policy:'',stageInstruction})
 const contract=JSON.parse(p[1].content).output_contract
 assert.deepEqual(contract.factors.effect,['positive','neutral','negative','mixed','unknown'])
 assert.match(contract.action_constraints,/conditional时非空/)
 assert.match(contract.action_constraints,/\[10\]须非空gaps/)
})

test('four peer records deliver full opinions once and only changed content afterwards',()=>{
 const peers=['a','b','c','d'].map(seat_id=>({seat_id,direction:1,reason:'独立原判断',seat_summary:'原摘要'}))
 const first=d.peerDelivery(peers,'direction')
 assert.equal(first.length,4);assert(first.every(p=>p.unchanged===false&&p.reason))
 const seen=Object.fromEntries(first.map(p=>[p.seat_id,p.candidate_version]))
 const repeated=d.peerDelivery(peers,'direction',seen)
 assert(repeated.every(p=>p.unchanged&&p.reason===undefined&&p.direction===undefined))
 peers[2].reason='新增具体反证';peers[2].direction=0
 const changed=d.peerDelivery(peers,'direction',seen)
 assert.equal(changed.filter(p=>!p.unchanged).length,1);assert.equal(changed[2].direction,0)
 assert(changed.filter(p=>p.unchanged).every(p=>Object.keys(p).length===3))
})
test('review feedback changes only its recipient version; evidence changes still reach everyone',()=>{
 const peers=[{seat_id:'a',direction:1,reason:'a'},{seat_id:'b',direction:0,reason:'b'}]
 const basis={evidence_version:'e',reviewer_feedback:{},reviewer_feedback_version:'all-old'}
 const a=d.inputVersion(peers,'a','direction',basis),b=d.inputVersion(peers,'b','direction',basis)
 const feedback={...basis,reviewer_feedback:{a:{reason:'具体反证'}},reviewer_feedback_version:'all-new'}
 assert.notEqual(d.inputVersion(peers,'a','direction',feedback),a)
 assert.equal(d.inputVersion(peers,'b','direction',feedback),b)
 assert.notEqual(d.inputVersion(peers,'b','direction',{...feedback,evidence_version:'new'}),b)
})
test('new actions need a lens gap and cited independent basis; gate does not interpret prose',()=>{
 const own={recommendations:[3]},candidate={recommendations:[3,4],evidence_refs:['e']}
 const value={review_decision:'revise',revision_kind:'substantive',broadcast_version:'v',review_summary:'本席发现新缺口',candidate}
 const args={stage:'condition',own,broadcastVersion:'v',validate:()=>[]}
 assert(d.validateExchange(value,args).some(x=>x.includes('addition_basis')))
 value.addition_basis=[{code:4,lens_gap:'本席资金投入风险',why_existing_insufficient:'存量回款不能约束新增项目承诺',evidence_refs:['e']}]
 assert.deepEqual(d.validateExchange(value,args),[])
 value.addition_basis[0].evidence_refs=['unregistered']
 assert(d.validateExchange(value,args).some(x=>x.includes('候选内证据')))
})
test('wording-only revisions cannot alter rigid business fields',()=>{
 const own={direction:1,reason:'原表述',evidence_refs:['e'],gaps:[],factors:[]}
 const value={review_decision:'revise',revision_kind:'wording_only',broadcast_version:'v',review_summary:'润色',candidate:{...own,reason:'润色后表述'}}
 const args={stage:'direction',own,broadcastVersion:'v',validate:()=>[]}
 assert.deepEqual(d.validateExchange(value,args),[])
 value.candidate.direction=0
 assert(d.validateExchange(value,args).some(x=>x.includes('wording_only不得')))
})
test('review cannot approve a candidate whose declared basis is only peer support',()=>{
 const candidate={seat_id:'a',direction:1}
 const review={consistent:true,selected_seat_id:'a',unresolved_gaps:[],authority:'within_rules',applied_rule_ids:['SUPPORTED_WHOLE_CANDIDATE'],review_reason:'审查',candidate_reviews:[{seat_id:'a',assessment:'supported',independence:'peer_support_only',reason:'只有同行支持'}]}
 assert(d.validateReview(review,[candidate],'direction',d.REVIEW_RULES).some(x=>x.includes('依赖同行支持')))
 review.candidate_reviews[0].independence='independent'
 assert.deepEqual(d.validateReview(review,[candidate],'direction',d.REVIEW_RULES),[])
})

test('malformed new audit fields return gate errors without breaking bounded recovery',()=>{
 const own={recommendations:[3],label_assessments:[]}
 const value={review_decision:'revise',revision_kind:'wording_only',broadcast_version:'v',review_summary:'错误格式',candidate:{recommendations:[3,4],evidence_refs:{},label_assessments:[null]},addition_basis:[{code:4,lens_gap:'缺口',why_existing_insufficient:'已有项不足',evidence_refs:['e']}]}
 assert.doesNotThrow(()=>d.validateExchange(value,{stage:'condition',own,broadcastVersion:'v',validate:()=>['候选结构无效']}))
 assert(d.validateExchange(value,{stage:'condition',own,broadcastVersion:'v',validate:()=>['候选结构无效']}).length>0)
 value.candidate.label_assessments={}
 assert.doesNotThrow(()=>d.validateExchange(value,{stage:'condition',own,broadcastVersion:'v',validate:()=>['候选结构无效']}))
})

test('v68 semantic overlap declarations block approval even when action codes differ',()=>{
 const prompt=d.buildReviewPrompt({stage:'condition',policy:'',question:{},rules:[],arbitrationRules:d.reviewRules('condition'),candidates:[],evidence:[]});
 assert.deepEqual(JSON.parse(prompt[1].content).action_options,require('../src/enterprise-action-contract').ACTIONS);
 const c={seat_id:'a',recommendations:[3,4,8]},r={consistent:true,selected_seat_id:'a',unresolved_gaps:[],authority:'within_rules',applied_rule_ids:['SUPPORTED_WHOLE_CANDIDATE'],review_reason:'candidate',candidate_reviews:[{seat_id:'a',assessment:'supported',independence:'independent',reason:'evidence',task_coverage:'sufficient',action_reviews:[3,4,8].map(id=>({id,assessment:'supported',reason:'evidence',necessity:'required',omission_impact:'residual risk',direction_assessment:'compatible'})),issues:[{kind:'redundant',action_ids:[3,8],reason:'Both include settling existing disputed receivables'}],combination_assessment:'compatible',combination_reason:'aligned'}]};
 assert(d.validateReview(r,[c],'condition',d.reviewRules('condition')).some(e=>e.includes('重复问题')));
 r.consistent=false;r.selected_seat_id=null;r.revision_requests=[{seat_id:'a',action_ids:[3,8],reason:'Narrow overlapping existing-receivable settlement before approving'}];assert.deepEqual(d.validateReview(r,[c],'condition',d.reviewRules('condition')),[]);
 assert.deepEqual(c.recommendations,[3,4,8]);
});
test('v68 keeps v66 direction return restrictions and permits opposing supported candidates',()=>{
 const candidates=[{seat_id:'a',direction:1},{seat_id:'b',direction:0}],r={consistent:false,selected_seat_id:null,unresolved_gaps:[],authority:'within_rules',applied_rule_ids:['SUPPORTED_WHOLE_CANDIDATE'],review_reason:'review',candidate_reviews:candidates.map(c=>({seat_id:c.seat_id,assessment:'supported',independence:'independent',reason:'independent evidence'})),revision_requests:[{seat_id:'a',action_ids:[],reason:'extra round'}]};
 assert(d.validateReview(r,candidates,'direction',d.reviewRules('direction')).some(e=>e.includes('仅用于权限内第二层')));
 r.revision_requests=[];r.consistent=true;r.selected_seat_id='b';assert.deepEqual(d.validateReview(r,candidates,'direction',d.reviewRules('direction')),[]);
});
