const { isActualAction, isNoNewMeasures, ACTION_OPTIONS_VERSION, ACTION_RELATION_POLICY, OBJECT_BOUNDARIES, ACTION_FIELD_ENUMS } = require('./enterprise-action-contract')
const { canonicalJson, sha256 } = require('./utils')
const { ACTIONS, DIRECTION_POLICY } = require('./enterprise-action-contract')
const VERSION = '5.3.0-action-object-boundaries'
// One shared decision standard, supplied once to initial seats, exchanges and review.
// Models assess meaning; the program validates declarations without inferring necessity.
const NECESSITY_POLICY = Object.freeze({
  selection: '从已知事实识别本席位关键风险，再提出必要动作。不从选项清单寻找好处，不按数量筛选；同行可指出真实遗漏，合理增补须有自己的依据。',
  independence: '仅判断自己的岗位视角，不要求承担其他席位范围。同行提示是待核验的质疑，不是应采纳的措施；先去掉同行的结论，检验已有事实在本席视角内是否仍要求改变。具体说明本席已知传导机制，以及自己的原措施实施后仍存在的后果；仅称可能影响经营、现金或交付不能把其他视角转成本席必要行动。允许依据已有事实发现真实遗漏，不要求必须出现新证据；同行已提出或尚未提出均不影响必要性。已有候选之外的同行措施不是本方案的替代安排。',
  evidence: '按已有公开安排→在这些安排下仍成立的已知风险→建议具体改变什么，形成必要性判断。已有安排未披露时明确未知，不假定充分或不足；不能用未证明机制充分推导必须新增机制。已发生的不利结果、明确到期义务或已成立风险可支持强化、落实或核对现有安排；执行数据缺失列前提，不假定必需新建制度或新增融资。去掉未知后没有独立依据的行动不标必要。',
  countercheck: '保留本候选其余措施和已知现行安排，检验不采取该动作是否仍有具体关键问题。why_deletable记录最强删除解释；why_required指出这些安排实施后仍成立的已知剩余风险，并说明建议与既有安排的执行差异。不能只回应有利条件未被证实。没有合理删除解释可明确说明，不编造既有控制或消除风险的事实。',
  deduplication: '比较实际动作和执行对象。对于同一项目或对象，说明执行A后B还有哪项独立动作、反过来是否也成立；只说选谁与何时投、经营与资本属于不同概念不能证明独立。步骤或前提归入主动作，需收窄或合并由原席修改，不为维持数量补项。'
})
const CANDIDATE_SELECTION_POLICY = Object.freeze({
  fairness: '先逐席判断其自身范围的方案是否成立，再选择。不得因缺少其他视角而降级；覆盖更多维度、包含更多条目、席位名贴近题目或被称为元审查，都不是选优依据。结构完整不等于全视角覆盖。',
  comparison: '先在各自岗位范围内审查必要性，不能跨视角数遗漏。review_reason逐一比较选中候选与其他成立候选：在相同具体风险或执行对象上，指出证据强度、动作直接性、执行边界或时点适配的差别。不同视角处理不同风险时，不能把多处理另一种风险、同时引用更多已知事实称为证据更直接；其他方案缺少本席动作不构成质量较差。没有可支持的同对象质量差别时明确近似等效，选择一个已有完整候选，不编造唯一优胜。较大与较小组合均不因数量、覆盖广度、谨慎程度或编号顺序获得优势。'
})
const REVIEW_RULES = [
  { id: 'SUPPORTED_WHOLE_CANDIDATE', text: '可依据证据支持、关键反证和论证充分性选择已有完整候选；多个候选均成立时可选其中一项并说明依据，无须额外席位排名规则。不得按多数票、片段拼接或自造候选。' },
  { id: 'CONDITIONAL_ACTIONS', text: '公开证据支持方向时，执行前提尚待核实时允许有明确前提的条件性行动；不得据未知内部信息断言执行能力。' },
  { id: 'EXISTING_ARRANGEMENTS_SUFFICIENT', text: '仅当已有可核验安排支持冻结方向且无需新增动作时，可选择已有[13]候选；必须独立核验充分性及方向关系，不把未知、空输出、调用失败或格式修复当作无需措施。' },
  { id: 'NO_RELIABLE_ADVICE', text: '关键冲突无法消解或证据不足时保留未决或已有无建议，不得编造事实、权限或用户规则。' }
]
function reviewRules(stage) {
  if (!['direction','condition'].includes(stage)) throw new Error('Unknown enterprise stage')
  return REVIEW_RULES.filter(rule => stage === 'condition' || !['CONDITIONAL_ACTIONS','EXISTING_ARRANGEMENTS_SUFFICIENT'].includes(rule.id))
}
const isObject = x => x && typeof x === 'object' && !Array.isArray(x)
const text = x => typeof x === 'string' && Boolean(x.trim())
const list = x => Array.isArray(x) && x.every(text)
function exactIds(actual, expected) { return Array.isArray(actual) && actual.length === expected.length && new Set(actual).size === expected.length && actual.every(x => expected.includes(x)) }
function candidatePayload(candidate, stage) {
  const fields = [stage === 'direction' ? 'direction' : 'recommendations', 'reason', 'evidence_refs', 'gaps', 'assumptions', 'factors', 'seat_summary', ...(stage === 'condition' ? ['actions', 'direction_version', 'label_assessments', 'combination_reason', 'no_action_basis'] : [])]
  return Object.fromEntries(fields.filter(k => Object.hasOwn(candidate, k)).map(k => [k, structuredClone(candidate[k])]))
}
function validateAnalysis(candidate, stage, evidenceIds) {
  const errors = []
  if (!isObject(candidate)) return ['候选必须是对象']
  if (!text(candidate?.seat_summary) || candidate.seat_summary.length > 1200) errors.push('seat_summary须为1至1200字的席位核心摘要')
  if (stage !== 'condition') return errors
  const ids = Array.isArray(candidate.recommendations) ? candidate.recommendations.filter(isActualAction) : []
  const assessments = candidate.label_assessments
  if (!Array.isArray(assessments) || !exactIds(assessments.map(x => x?.code), ids)) errors.push('label_assessments必须覆盖且仅覆盖全部所选实际行动')
  for (const item of Array.isArray(assessments) ? assessments : []) {
    if (!isObject(item)) { errors.push('逐项论证必须是对象'); continue }
    if (!Number.isInteger(item.code)) errors.push('label_assessments.code必须是整数编号，不能是字符串')
    if (typeof item.necessary !== 'boolean') errors.push('逐项论证须声明necessary布尔值')
    for (const k of ['why_required', 'why_deletable', 'counter_evidence']) if ((k === 'why_required' || Object.hasOwn(item,k)) && !list(item[k])) errors.push(`${k}必须是字符串数组`)
    if (item.counter_evidence_refs!==undefined && (!Array.isArray(item.counter_evidence_refs) || item.counter_evidence_refs.some(id=>!evidenceIds.has(id) || !(Array.isArray(candidate.evidence_refs) && candidate.evidence_refs.includes(id))))) errors.push('逐项反证须引用候选内已登记证据')
    if (item.necessary === true && !item.why_required?.length) errors.push('必要行动须说明删除后未被覆盖的关键问题')
    if (!Array.isArray(item.evidence_refs) || !item.evidence_refs.length || item.evidence_refs.some(id => !evidenceIds.has(id) || !(Array.isArray(candidate.evidence_refs) && candidate.evidence_refs.includes(id)))) errors.push('逐项论证须引用候选内已登记证据')
  }
  if (candidate.combination_reason != null && typeof candidate.combination_reason !== 'string' && !list(candidate.combination_reason)) errors.push('combination_reason如提供须为字符串、字符串数组或空值')
  return errors
}
function validateExchange(value, { stage, own, peers, broadcastVersion, validate }) {
  if (!isObject(value)) return ['交换结果必须是对象']
  const errors = []
  const fields = ['review_decision','broadcast_version','review_summary','candidate','addition_basis','revision_kind']
  if (Object.keys(value).some(k => !fields.includes(k))) errors.push('交换结果包含未授权字段')
  if (!['maintain','revise','undetermined'].includes(value.review_decision)) errors.push('review_decision必须是maintain、revise或undetermined')
  if (value.broadcast_version !== broadcastVersion) errors.push(`交换结果未绑定收到的广播版本：期望${JSON.stringify(broadcastVersion)}，实际${JSON.stringify(value.broadcast_version)}`)
  if (!text(value.review_summary) || value.review_summary.length > 1600) errors.push('review_summary须为1至1600字的判断摘要')
  if (value.review_decision === 'maintain') {
    if (value.candidate !== null) errors.push('maintain必须返回candidate:null，原完整候选保持不变')
  } else {
    errors.push(...validate(value.candidate))
    if (value.review_decision === 'undetermined' && (stage === 'direction' ? value.candidate?.direction !== null : !exactIds(value.candidate?.recommendations, [10]))) errors.push(stage === 'direction' ? 'undetermined须提交direction:null的完整候选' : 'undetermined须提交recommendations:[10]的完整候选')
  }

  if (value.review_decision === 'revise') {
    if (!['substantive','wording_only'].includes(value.revision_kind)) errors.push('修订须声明revision_kind为substantive或wording_only')
    if (value.revision_kind === 'wording_only' && canonicalJson(substantivePayload(value.candidate)) !== canonicalJson(substantivePayload(own))) errors.push('wording_only不得改变决策、行动、事实因子、引用或必要性声明')
  }
  if (stage === 'condition' && value.review_decision !== 'maintain' && isObject(value.candidate)) {
    const added = (Array.isArray(value.candidate.recommendations) ? value.candidate.recommendations : []).filter(id => isActualAction(id) && !(own?.recommendations || []).includes(id))
    const basis = value.addition_basis || []
    if (!Array.isArray(basis) || !exactIds(basis.map(item => item?.code), added)) errors.push('addition_basis须且仅须覆盖本次新增行动')
    for (const item of Array.isArray(basis) ? basis : []) {
      if (!isObject(item) || !text(item.lens_gap) || !text(item.why_existing_insufficient) || !Array.isArray(item.evidence_refs) || !item.evidence_refs.length || item.evidence_refs.some(id => !Array.isArray(value.candidate.evidence_refs) || !value.candidate.evidence_refs.includes(id))) errors.push('新增行动须声明本席位缺口、已有措施不能覆盖的原因及候选内证据；同行支持不构成依据')
    }
  }
  return errors
}
function substantivePayload(candidate) {
  if (!isObject(candidate)) return candidate
  const { reason, seat_summary, combination_reason, label_assessments, ...rest } = candidatePayload(candidate, Object.hasOwn(candidate,'recommendations') ? 'condition' : 'direction')
  return { ...rest, ...(label_assessments !== undefined ? {label_assessments:Array.isArray(label_assessments) ? label_assessments.map(item=>isObject(item) ? {code:item.code,necessary:item.necessary,evidence_refs:item.evidence_refs,...(Object.hasOwn(item,'counter_evidence_refs')?{counter_evidence_refs:item.counter_evidence_refs}:{})} : item) : label_assessments} : {}) }
}
function discussionVersion(candidate, stage) {
  return candidate.discussion_version || sha256(canonicalJson(stage === 'condition' ? peerSummary(candidate,stage) : candidatePayload(candidate,stage)))
}
function exchangeInstruction(stage) {
  return '本次是意见交换。首轮收到其他四席完整意见；后续仅处理其尚未审阅的变化，unchanged记录不代表新增依据。始终只从自己的岗位视角判断，同行身份、支持数量和意见重复均不构成证据。只返回交换JSON，外层字段为review_decision(maintain/revise/undetermined),revision_kind,review_summary(准确描述本次实际保留或修订方案的简短摘要，不能将自己已保留行动说成仅为同行意见),candidate,addition_basis。revision_kind与addition_basis属于外层，不能放入candidate；candidate仅包含本阶段业务字段。完整指字段完整，不要求补齐其他视角。维持原完整意见时maintain且candidate:null；有修改时revise并在candidate给出完整候选，revision_kind声明substantive（决策、事实或实质论证变化）或wording_only（仅表述润色）；wording_only不重新推动其他席讨论；无法判断时undetermined并提交本阶段完整候选。意见维持只冻结当前广播版本；后续意见或证据更新可重新激活。' + (stage === 'condition' ? 'undetermined使用recommendations:[10]。新增实际行动时输出addition_basis:[{code,lens_gap,why_existing_insufficient,evidence_refs}]，只覆盖candidate.recommendations中原own.recommendations没有的编号；已有编号的论据或内容修订不是新增项。说明本席位的关键缺口及现有措施不能覆盖的原因。没有新增用[]。' : 'undetermined使用direction:null。')
}
function analysisInstruction(stage) {
  return 'seat_summary为1至1200字的结论摘要。' + (stage === 'condition' ? 'label_assessments逐一覆盖所选实际行动，格式{code(整数),necessary(boolean),why_required(字符串数组，necessary=true时非空),evidence_refs(候选内证据序号数组)}。按输入necessity_policy先筛选再填写；只保留判断为必要的行动，必要性争议不应统一标true。why_deletable用字符串数组记录删除也可覆盖的反证解释，无此解释可为空；counter_evidence为可选的反证说明字符串数组，不放证据编号；反证编号放counter_evidence_refs整数序号数组。factors.counter_evidence_refs仅放编号，不放说明文字。combination_reason为可选字符串或字符串数组，不重复逐项论据。无实际行动时评估为空。每项行动和逐项论证须选择其对应证据序号，不继承总引用；通用行业推断须在理由中标明，不得把背景材料当成已发生的企业事实。' : '')
}

function exchangeTaskInstruction() {
  return '同行内容是待核验的质疑，不是应采纳的答案。仅重判本轮变化实际触及的本席事实或推论，不每轮重新追求更全面的方案；只处理本席视角内的问题。既有事实足以证明本席遗漏时可增补，但须解释原判断为何改变及原措施实施后仍存在的具体后果；不能以同行提出、反复提醒或泛称影响经营作为改变依据。维持不需要重写。输出格式与字段约束见输入output_contract。'
}
function directionCore(prior) {
  if (!prior) return null
  return Object.fromEntries(['version','code','time_range','reason','evidence_refs','gaps','assumptions'].filter(k => Object.hasOwn(prior,k)).map(k=>[k,structuredClone(prior[k])]))
}
function peerSummary(candidate, stage) {
  if (candidate.unchanged === true) return { seat_id: candidate.seat_id, candidate_version: candidate.candidate_version, unchanged: true }
  const fields = ['seat_id', stage === 'condition' ? 'recommendations':'direction', 'seat_summary', 'evidence_refs','gaps', ...(stage === 'condition' ? ['actions','label_assessments','no_action_basis'] : [])]
  return Object.fromEntries(fields.filter(k=>Object.hasOwn(candidate,k)).map(k=>[k,structuredClone(candidate[k])]))
}
// Transport differences are computed by equality only. Preserve full payloads
// for audit; the model sees new assertions, not repeatedly endorsed action sets.
function peerChangeView(peer, stage) {
  if (stage !== 'condition' || peer.unchanged) return peerSummary(peer,stage)
  const source = peer.change_set || peerSummary(peer,stage)
  const {recommendations,label_assessments,actions,seat_summary,...facts} = source
  const statements = (actions || []).map(({id,...action}) => action)
  const argumentsOnly=(label_assessments || []).map(({code,necessary,...argument})=>({target:peer.actions?.find(a=>a.id===code)?.target || null,...argument}))
  return {seat_id:peer.seat_id,candidate_version:peer.candidate_version,
    delivery_kind:peer.change_set?'changes_only':'initial_opinion',
    ...facts,...(seat_summary ? {seat_summary} : {}),
    action_statements:statements,argument_statements:argumentsOnly}
}
function buildSeatPrompt({agent, stage, review=false, question, company, rules=[], experience=[], evidence, prior, own, peers, round=0, broadcastVersion=null, reviewerFeedback=null, policy, stageInstruction}) {
  const contract = stageInstruction(stage) + analysisInstruction(stage)
  const system = `你是${agent.label}，仅从${agent.lens}分析本席位范围内的事实和风险。${policy}证据为可定位摘录，未覆盖的信息不可当成未披露事实。` + (review && stage === 'condition' ? exchangeTaskInstruction() + exchangeInstruction(stage) : contract + (review ? exchangeInstruction(stage) : ''))
  const input = {stage,question,company,rules,experience,evidence,allowed_evidence_ids:(evidence || []).map(item => item.id),frozen_direction:directionCore(prior),own:review?candidatePayload(own,stage):undefined,broadcast_version:broadcastVersion,differences:review?(peers||[]).map(p=>stage==='condition'?peerChangeView(p,stage):p.unchanged ? peerSummary(p,stage) : {...peerSummary(p,stage),...candidatePayload(p,stage),candidate_version:p.candidate_version}):undefined,review_round:review?round:0}
  if (stage === 'condition') Object.assign(input,{necessity_policy:NECESSITY_POLICY,action_options_version:ACTION_OPTIONS_VERSION,action_relation_policy:ACTION_RELATION_POLICY,object_boundaries:OBJECT_BOUNDARIES})
  if (stage === 'direction') input.direction_policy = DIRECTION_POLICY
  // Initial and exchange calls share the same wire contract; no extra business task.
  if (stage === 'condition') {
    input.action_options = ACTIONS
    input.output_contract = {
      recommendations: {type:'integer[]',allowed_codes:[1,2,3,4,5,6,7,8,9,10,11,12,13],min_items:1,no_advice_exclusive:10,no_new_measures_exclusive:13,empty_allowed:false},
      fields:['recommendations','actions','reason','evidence_refs','gaps','assumptions','factors','direction_version','seat_summary','label_assessments','combination_reason','no_action_basis'],
      actions: {fields:['id','target','scope','time_range','action','effect','readiness','prerequisites','evidence_refs','direction_relation','decision_object','commitment_status'],...ACTION_FIELD_ENUMS,object_fields_required_for:Object.keys(OBJECT_BOUNDARIES).map(Number),object_fields_for_other_codes:'omit'},
      factors: { fields:['name','mechanism','effect','evidence_refs','counter_evidence_refs'], effect:['positive','neutral','negative','mixed','unknown'] },
      field_types: {seat_summary:'required nonempty string, 1-1200 characters',reason:'nonempty string',evidence_refs:'integer selector[]',gaps:'string[]',assumptions:'string[]',factors:'object[]',direction_version:'program bound; omit in model output'},
      action_constraints:'每项target/action/time_range/direction_relation为非空字符串；id为对应整数编号；prerequisites为字符串数组，conditional时非空；evidence_refs为非空数组且引用必须属于本次证据表，程序汇总候选evidence_refs。实际建议须非空factors和证据；[10]须非空gaps、空actions和空label_assessments；[13]须空actions和空label_assessments，非空no_action_basis已有安排及证据、充分性和方向关系，gaps为空且冻结方向已确定；recommendations禁止[]。',
      no_action_basis:{required_for:'recommendations exactly [13]',fields:['existing_arrangements','why_sufficient','direction_relation'],existing_arrangements_fields:['arrangement','evidence_refs']},
      label_assessment_code_type:'integer',
      label_assessments:['code','necessary','why_required','why_deletable','counter_evidence','counter_evidence_refs','evidence_refs'],
      constraints:'逐项评估包含整数code、布尔necessary、字符串数组why_required（necessary=true时非空）、证据序号数组evidence_refs。只重判变化触及的论证；修订时提交完整方案，不要求重新寻找更多措施。why_deletable用字符串数组记录反证解释，无此解释可为空；counter_evidence为可选反证说明字符串数组，不放编号；反证编号放counter_evidence_refs整数序号数组。factors.counter_evidence_refs仅放编号，不放说明文字；combination_reason可选，允许字符串、字符串数组或空值。seat_summary必填且为1至1200字，引用必须已登记，direction_version由程序绑定冻结版本，编号10和13无actions；no_action_basis仅适用于[13]，2/4/11/12须按object_boundaries声明对象和承诺状态。'
    }
  }
  if (review) input.exchange_output_contract = {
    outer_fields:['review_decision','revision_kind','review_summary','candidate','addition_basis'],
    program_bound_fields:['broadcast_version'],
    revision_kind:{location:'outer',required_when:'review_decision=revise',values:['substantive','wording_only']},
    candidate:{location:'candidate',maintain:null,fields:stage === 'direction' ? ['direction','reason','evidence_refs','gaps','assumptions','factors','seat_summary'] : input.output_contract.fields},
    addition_basis:{location:'outer',required_for:'condition: candidate codes absent from own.recommendations; unchanged codes and content revisions are not additions',fields:['code','lens_gap','why_existing_insufficient','evidence_refs']}
  }
  if (reviewerFeedback) input.reviewer_feedback = reviewerFeedback
  return [{role:'system',content:system},{role:'user',content:JSON.stringify(input)}]
}
function inputVersion(decisions, seatId, stage, basis) {
  const { reviewer_feedback_version, reviewer_feedback, ...stableBasis } = basis
  return sha256(canonicalJson({ basis: stableBasis, feedback: reviewer_feedback?.[seatId] || null, peers: decisions.filter(x => x.seat_id !== seatId).map(x => ({ seat_id: x.seat_id, candidate_version: discussionVersion(x, stage) })) }))
}
function peerDelivery(peers, stage, seen = {}, seenPayloads = {}) {
  return peers.map(peer => {
    const payload = candidatePayload(peer, stage), version = discussionVersion(peer, stage)
    return seen[peer.seat_id] === version
      ? { seat_id: peer.seat_id, candidate_version: version, unchanged: true }
      : { seat_id: peer.seat_id, ...payload, candidate_version: version, unchanged: false,
          ...(stage==='condition' && seenPayloads[peer.seat_id] ? {change_set:conditionChanges(seenPayloads[peer.seat_id],payload)} : {}) }
  })
}
function conditionChanges(previous,current) {
  const changed={}
  for(const key of ['reason','seat_summary','no_action_basis'])
    if(canonicalJson(previous[key]??null)!==canonicalJson(current[key]??null))changed[key]=structuredClone(current[key]??null)
  for(const key of ['evidence_refs','gaps','assumptions','factors']) {
    const before=previous[key]||[],after=current[key]||[]
    const added=after.filter(a=>!before.some(b=>canonicalJson(a)===canonicalJson(b)))
    const removed=before.filter(b=>!after.some(a=>canonicalJson(a)===canonicalJson(b)))
    if(added.length)changed[key]=structuredClone(added)
    if(removed.length)changed['withdrawn_'+key]=structuredClone(removed)
  }
  changed.actions=(current.actions||[]).filter(a=>canonicalJson(a)!==canonicalJson((previous.actions||[]).find(p=>p.id===a.id)??null))
  changed.label_assessments=(current.label_assessments||[]).filter(a=>{
    const {necessary,...claim}=a,old=(previous.label_assessments||[]).find(p=>p.code===a.code)
    const {necessary:oldNecessity,...oldClaim}=old||{}
    return canonicalJson(claim)!==canonicalJson(oldClaim)
  })
  changed.withdrawn_actions=(previous.actions||[]).filter(a=>!(current.actions||[]).some(c=>c.id===a.id)).map(({id,...a})=>a)
  return changed
}
function summarizeSeats(decisions, stage, states) {
  return decisions.map(c => ({ seat_id: c.seat_id, code: c[stage === 'direction' ? 'direction' : 'recommendations'], summary: c.seat_summary, evidence_refs: c.evidence_refs, gaps: c.gaps, assumptions: c.assumptions || [], label_assessments: c.label_assessments || [], combination_reason: c.combination_reason || null, ...states[c.seat_id], candidate_sha256: sha256(canonicalJson(candidatePayload(c, stage))) }))
}
function validateReview(value, candidates, stage, rules, {requireActionAudit=false,requireSelectionComparison=false,actionHistory=[]}={}) {
  if (!isObject(value)) return ['语义复核必须是对象']
  const errors = [], selected = candidates.find(c => c.seat_id === value.selected_seat_id)
  if (Object.keys(value).some(k => !['consistent','selected_seat_id','unresolved_gaps','authority','applied_rule_ids','review_reason','candidate_reviews','revision_requests',...(stage==='condition'?['selection_mode']:[])].includes(k))) errors.push('语义复核含未授权字段')
  if (typeof value.consistent !== 'boolean' || !list(value.unresolved_gaps)) errors.push('复核consistent与unresolved_gaps结构无效')
  if (value.selected_seat_id != null && !selected) errors.push('复核选择了未知候选')
  if (!['within_rules','requires_human'].includes(value.authority) || !text(value.review_reason)) errors.push('复核须声明权限与判断理由')
  if (!Array.isArray(value.applied_rule_ids) || value.applied_rule_ids.some(id => (stage === 'direction' && ['CONDITIONAL_ACTIONS','EXISTING_ARRANGEMENTS_SUFFICIENT'].includes(id)) || !rules.some(r => r.id === id))) errors.push('复核引用未授权规则')
  if (value.consistent && (value.authority !== 'within_rules' || !selected || !value.applied_rule_ids?.length || value.unresolved_gaps?.length)) errors.push('通过须在规则权限内、引用规则、选择完整候选且无阻断缺口')
  if (value.authority === 'requires_human' && value.consistent !== false) errors.push('超出权限不得批准')
  if (!Array.isArray(value.candidate_reviews) || !exactIds(value.candidate_reviews.map(r=>r?.seat_id), candidates.map(c=>c.seat_id))) errors.push('复核须保留五席逐席评估')
  for (const r of Array.isArray(value.candidate_reviews) ? value.candidate_reviews : []) {
    const c = candidates.find(c=>c.seat_id===r?.seat_id)
    if (!isObject(r) || !['supported','unsupported','uncertain'].includes(r.assessment) || !text(r.reason)) { errors.push('逐席复核结构无效'); continue }
    if (!['independent','peer_support_only','uncertain'].includes(r.independence)) errors.push('逐席复核须声明独立依据状态')
    if (value.consistent && r.seat_id === value.selected_seat_id && r.independence !== 'independent') errors.push('不得批准依赖同行支持或独立依据未决的候选')
    if (value.consistent && r.seat_id === value.selected_seat_id && r.assessment !== 'supported') errors.push('被选完整候选须由模型明确判定supported')
    if (stage === 'condition' && c) {
      const validCodes=Array.isArray(c.recommendations) && c.recommendations.length && c.recommendations.every(id=>Number.isInteger(id) && (isActualAction(id) || [10,13].includes(id))) && !([10,13].some(id=>c.recommendations.includes(id)) && c.recommendations.length!==1)
      if(!validCodes)errors.push('复核不得批准空、未知或混合状态建议候选')
      const ids = (Array.isArray(c.recommendations)?c.recommendations:[]).filter(isActualAction)
      if(requireActionAudit && ids.length) {
        if(!['compatible','conflicting','uncertain'].includes(r.combination_direction_assessment))errors.push('复核须声明整个组合与第一层方向的相容性')
        if(value.consistent && r.seat_id===value.selected_seat_id && r.combination_direction_assessment!=='compatible')errors.push('不得批准整体组合违背第一层方向或相容性未决的候选')
      }
      if(isNoNewMeasures(c.recommendations)) {
        const nr=r.no_action_review
        if(!isObject(nr) || Object.keys(nr).some(k=>!['assessment','direction_assessment','reason'].includes(k)) || !['supported','unsupported','uncertain'].includes(nr.assessment) || !['compatible','conflicting','uncertain'].includes(nr.direction_assessment) || !text(nr.reason))errors.push('无需新增措施复核须声明已有安排充分性及方向相容性')
        if(value.consistent && r.seat_id===value.selected_seat_id && (!nr || nr.assessment!=='supported' || nr.direction_assessment!=='compatible'))errors.push('不得批准未经独立确认或方向不相容的无需新增措施')
      } else if(r.no_action_review != null) errors.push('仅[13]候选允许no_action_review')
      if (value.consistent && r.seat_id === value.selected_seat_id && c.label_assessments?.some(a=>a.necessary === false)) errors.push('原席明确标为非必要的保留项须先返回原席修订，不得直接批准')
      if (!['sufficient','insufficient','uncertain','not_applicable'].includes(r.task_coverage)) errors.push('复核须判断本席位范围充分性')
      for (const a of Array.isArray(r.action_reviews) ? r.action_reviews : []) if (!['required','optional','uncertain'].includes(a?.necessity) || !text(a?.omission_impact)) errors.push('复核须声明行动必要性及删去后果')
      if (value.consistent && r.seat_id === value.selected_seat_id && (ids.length ? r.task_coverage !== 'sufficient' || (Array.isArray(r.action_reviews) && r.action_reviews.some(a=>a?.necessity!=='required')) : r.task_coverage !== 'not_applicable')) errors.push('通过方案须由模型明确判断本席位关键风险得到合理回应且各项必要')
      if (!Array.isArray(r.action_reviews) || !exactIds(r.action_reviews.map(x=>x?.id), ids)) errors.push('复核必须逐项覆盖该席全部已选行动')
      for (const a of Array.isArray(r.action_reviews) ? r.action_reviews : []) if (!isObject(a) || !['supported','unsupported','uncertain'].includes(a.assessment) || !text(a.reason)) errors.push('逐行动复核结构无效')
      for (const a of Array.isArray(r.action_reviews) ? r.action_reviews : []) {
        if (!['compatible','conflicting','uncertain'].includes(a?.direction_assessment)) errors.push('逐行动须声明与第一层方向的相容性')
        if (value.consistent && r.seat_id === value.selected_seat_id && a?.direction_assessment !== 'compatible') errors.push('不得批准与第一层方向冲突或关系未决的行动')
      }
      if (!Array.isArray(r.issues)) errors.push('复核须提供issues数组，无问题时为空')
      for (const issue of Array.isArray(r.issues) ? r.issues : []) {
        if (!isObject(issue) || !['direction_conflict','action_conflict','redundant'].includes(issue.kind) || !text(issue.reason) || !Array.isArray(issue.action_ids) || !issue.action_ids.length || new Set(issue.action_ids).size !== issue.action_ids.length || issue.action_ids.some(id=>!ids.includes(id)) || (issue.kind === 'action_conflict' && issue.action_ids.length < 2)) errors.push('复核问题须绑定已有行动编号并说明类型和理由')
      }
      if (value.consistent && r.seat_id === value.selected_seat_id && r.issues?.length) errors.push('不得批准仍有方向冲突、行动冲突或重复问题的候选')
      if (!['compatible','conflicting','uncertain','not_applicable'].includes(r.combination_assessment) || !text(r.combination_reason)) errors.push('复核缺少组合判定')
      if (value.consistent && r.seat_id === value.selected_seat_id && (ids.length ? r.combination_assessment !== 'compatible' || (Array.isArray(r.action_reviews) && r.action_reviews.some(a=>a?.assessment!=='supported')) : r.combination_assessment !== 'not_applicable')) errors.push('被选方案须逐项通过且组合相容；无实际行动须not_applicable')
    }
  }
  const requests = value.revision_requests || []
  if (!Array.isArray(requests) || new Set(requests.map(r=>r?.seat_id)).size !== requests.length || requests.some(r=>!candidates.some(c=>c.seat_id===r?.seat_id) || !text(r.reason) || !Array.isArray(r.action_ids) || (stage === 'direction' ? r.action_ids.length !== 0 : r.action_ids.some(id=>!candidates.find(c=>c.seat_id===r.seat_id)?.recommendations?.includes(id))))) errors.push('修订请求须绑定已有席位和行动编号')
  if (requests.length && (stage !== 'condition' || value.consistent || value.selected_seat_id !== null || value.authority !== 'within_rules')) errors.push('修订请求仅用于权限内第二层未通过且未选择候选')
  if(stage==='condition'&&requireActionAudit)errors.push(...require('./enterprise-action-audit').validateActionAuditReview(value,candidates,actionHistory))
  if(stage==='condition'&&requireSelectionComparison)errors.push(...validateSelectionComparison(value,candidates))
  return errors
}
function validateSelectionComparison(value,candidates=[]) {
  const errors=[]
  if(!['quality_difference','equivalent_choice','no_selection'].includes(value.selection_mode))return ['复核须声明候选比较选择模式']
  if(!value.consistent)return value.selection_mode==='no_selection'?[]:['未选择候选时比较模式须为no_selection']
  if(value.selection_mode==='no_selection')errors.push('通过时须声明质量差异或等效选择')
  const alternatives=[]
  for(const row of Array.isArray(value.candidate_reviews)?value.candidate_reviews:[]) {
    if(!isObject(row))continue
    if(row.assessment!=='supported')continue
    const comparison=row.comparison_to_selected
    if(!isObject(comparison)||!['selected','weaker','equivalent','not_comparable'].includes(comparison.relation)||!text(comparison.reason)) {errors.push('成立候选须声明与选中方案的同对象比较');continue}
    if(row.seat_id===value.selected_seat_id) {
      if(comparison.relation!=='selected')errors.push('选中候选比较关系须为selected')
    } else {
      alternatives.push(comparison)
      if(comparison.relation==='selected')errors.push('不得将替代候选标为选中方案')
      if(comparison.relation==='weaker'&&(!text(comparison.shared_object)||!['evidence_strength','action_directness','execution_boundary','timing_fit'].includes(comparison.quality_basis)))errors.push('质量差异须声明共同具体对象及质量依据')
      if(comparison.relation==='not_comparable'&&!text(comparison.alternative_object))errors.push('not_comparable须声明具体不同对象alternative_object')
      if(comparison.relation==='weaker') {
        const own=candidates.find(c=>c.seat_id===row.seat_id),selected=candidates.find(c=>c.seat_id===value.selected_seat_id)
        for(const [field,candidate] of [['candidate_action_ids',own],['selected_action_ids',selected]]) {
          const ids=comparison[field]
          if(!Array.isArray(ids)||!ids.length||new Set(ids).size!==ids.length||ids.some(id=>!Number.isInteger(id)||!isActualAction(id)||!candidate?.recommendations?.includes(id)))errors.push('质量比较须绑定双方候选中已有的实际行动')
        }
      }
    }
  }
  if(value.selection_mode==='quality_difference'&&alternatives.some(c=>c.relation!=='weaker'))errors.push('不得将等效或不可跨视角比较的成立方案声明为质量劣势')
  return [...new Set(errors)]
}
function buildReviewPrompt({stage, policy, question, rules, arbitrationRules, prior, candidates, evidence, seats=[], additions={}, exchangeReviews=[], actionHistory=[]}) {
  const input = {question,rules,arbitration_rules:arbitrationRules.filter(r => stage === 'condition' || !['CONDITIONAL_ACTIONS','EXISTING_ARRANGEMENTS_SUFFICIENT'].includes(r.id)),stage,...(stage === 'condition' ? {frozen_direction:directionCore(prior)} : {}),candidates:candidates.map(c=>({seat_id:c.seat_id,seat_lens:seats.find(row=>row[0]===c.seat_id)?.[2] || null,...candidatePayload(c,stage),addition_basis:Object.values(additions[c.seat_id] || {})})),evidence}
  if (stage === 'condition') {
    Object.assign(input,{necessity_policy:NECESSITY_POLICY,action_options_version:ACTION_OPTIONS_VERSION,action_relation_policy:ACTION_RELATION_POLICY,object_boundaries:OBJECT_BOUNDARIES})
    input.action_options = ACTIONS
    input.action_history = candidates.flatMap(c=>require('./enterprise-action-audit').flaggedAdditions(actionHistory,c)).map(({seat_id,code,round,candidate_version,temporal_signal})=>({seat_id,code,round,candidate_version,temporal_signal,kind:'added',received_same_code:[{received:true}]}))
  }
  input.review_method_version = VERSION
  input.candidate_selection_policy = CANDIDATE_SELECTION_POLICY
  if(stage==='condition')input.candidate_identity_policy='anonymous_transport'
  if (stage === 'direction') input.direction_policy = DIRECTION_POLICY
  if(stage==='condition') {
    const latest=new Map()
    for(const round of exchangeReviews)for(const response of round.responses||[])latest.set(response.seat_id,{round:round.round,response})
    // Historical persuasion text is audit material, not fresh support for a
    // candidate. Review the bound current candidate and independently its adds.
    input.exchange_reviews=[...latest.values()].map(({round,response})=>({round,responses:[Object.fromEntries(['seat_id','review_decision','revision_kind'].filter(k=>Object.hasOwn(response,k)).map(k=>[k,response[k]]))]}))
  } else input.exchange_reviews = exchangeReviews
  input.review_output_contract={
    outer_fields:['candidate_reviews','review_reason','consistent','selected_seat_id','unresolved_gaps','authority','applied_rule_ids','revision_requests',...(stage==='condition'?['selection_mode']:[])],
    ...(stage==='condition'?{no_action_review:{location:'candidate_reviews item',required_for:'recommendations exactly [13]',fields:['assessment','direction_assessment','reason'],assessment:['supported','unsupported','uncertain'],direction_assessment:['compatible','conflicting','uncertain'],otherwise:'omit or null; never emit an empty judgment object'},combination_direction_assessment:{location:'candidate_reviews item',required_for:'actual-action candidates',values:['compatible','conflicting','uncertain']}}:{}),
    candidate_reviews:{fields:['seat_id','assessment','independence','reason',...(stage === 'condition' ? ['task_coverage','action_reviews','issues','combination_assessment','combination_reason','boundary_reviews','timing_reviews','combination_direction_assessment','no_action_review'] : [])],...(stage === 'condition' ? {task_coverage_meaning:'仅本席位关键风险是否合理回应；不得按其他席位维度评价或排名'} : {}),independence_location:'each candidate_reviews item',independence_values:['independent','peer_support_only','uncertain']},
    ...(stage === 'condition' ? {action_reviews:{location:'each candidate_reviews item',fields:['id','assessment','reason','necessity','omission_impact','direction_assessment','basis_status','known_basis','countercheck_status','deletion_case','retention_response','residual_risk_source']},boundary_reviews:{location:'candidate_reviews item',fields:['action_ids','relationship','reason'],required_for:'selected candidate: every pair; others: identified pairs only'},timing_reviews:{location:'candidate_reviews item',fields:['code','assessment','reason'],required_for:'selected candidate: all currently retained, temporally flagged additions'},revision_requests:{location:'outer',fields:['seat_id','action_ids','reason']}} : {})
  }
  const task = stage === 'condition'
    ? '先按输入necessity_policy完成逐席及逐行动判断，再选择；不先选中覆盖最广者后补理由。仅可选或必要性未明的保留项归原席取舍，已有成立候选可直接选择，无须为其他候选额外补齐或统一。整体退出仅对应收缩，区分局部和条件性安排；检查同范围同期冲突和方向关系，不以条件性标签掩盖冲突；一般执行限制可作为前提，推翻第一层的事实须报告阻断。'
    : '当前仅复核第一层经营方向，方向尚未冻结；不要求冻结方向版本、行动项、行动必要性或组合审查。按输入direction_policy独立检查各完整方向候选。多个候选同方向不是冲突。SUPPORTED_WHOLE_CANDIDATE授权选择已有完整候选；在review_reason中比较被选方案与有依据的替代方案，说明其实际经营对象、范围、启动条件及关键证据差别，回应替代方案最强论据，并说明行动风险与不行动代价为何支持本次取舍。若认为相反代码只是表述差异，须指出相同安排和仍存的实际差别，不能仅以措辞相近消除分歧。不以更长、更谨慎的论述作为优选依据；没有定量依据时明确不确定性。多个候选均成立时仍可选择完整候选并说明比较理由，不强求唯一正确或额外席位排名；不得按多数票或拼接。仅在确有阻断冲突、证据不足或超出授权时保留未决。'
  const challenge = stage === 'direction' ? 'exchange_reviews保留已发生的逐轮回应。第一层不追加复核质询轮，revision_requests用[]；根据已有证据与回应在规则内裁决，确有阻断问题时保留未决，不自行改写候选。' : '按candidate_selection_policy比较完整候选。逐项在omission_impact写删除后、本候选其余措施和已知现行安排无法处理的剩余风险；核对原席的why_deletable反证。逐对用同一项目或对象的实际执行状态检查覆盖，描述执行A后B尚需做什么及反向检查；概念名称或代码不同不是去重证明；尚需收窄或合并时issues声明redundant并绑定相关编号，交回原席修订，不由复核删改。允许两个不同动作针对同一风险，不因同一主题自动判重复。'
  const audit = stage==='condition' ? '按action_reviews输出契约：known_basis记录已有公开安排和可定位的已知风险；未披露安排写未知，不当成不足证据。deletion_case记录保留既有安排及本方案其他措施时的最强删除解释；retention_response说明该解释下仍成立的已知风险与本动作的具体差异，不用未证明充分或缺少内部数据替代。basis_status(established/unknown_only/uncertain)仅依据去除未知后是否仍成立；countercheck_status(adequate/no_plausible_alternative/invalid/uncertain)核对解释与回应是否真正成立。原席why_deletable可能无效，不直接采信necessary=true。选中项须established且反证adequate或no_plausible_alternative。boundary_reviews逐对填{action_ids:[A,B],relationship:independent/shared_object_independent/overlapping/uncertain,reason}，independent表示不同作用且彼此不可替代；shared_object_independent表示同一项目、对象或资源上的不同必要执行动作，实施A后B仍有独立剩余动作，反向亦成立；overlapping仅表示执行动作存在替代、重复或需收窄，不能仅因对象相同而使用；uncertain表示不能判定上述边界。reason说明实际剩余动作，不要求编造项目数据；需收窄归原席修改。action_history只记录新增时已收到的同行意见，不代表违规；timing_reviews对选中候选保留的标记新增填{code,assessment:independent/peer_only/uncertain,reason}，允许有自身已知缺口的合理增补。无行动、配对或标记用[]；非选中候选只记录已识别配对与时序问题。residual_risk_source声明保留依据来源：known_fact=现行安排实施后仍成立的可定位已知剩余风险；unknown_sufficiency=仅凭未证明充分或缺少内部数据；no_residual_risk=删除后无已知剩余风险。被选行动须known_fact；no_residual_risk不得同时声明required。' : ''
  if(stage==='condition') {
    input.review_output_contract.candidate_reviews.fields.push('comparison_to_selected')
    input.review_output_contract.comparison_to_selected={fields:['relation','shared_object','quality_basis','reason','candidate_action_ids','selected_action_ids','alternative_object'],relations:['selected','weaker','equivalent','not_comparable'],quality_basis:['evidence_strength','action_directness','execution_boundary','timing_fit'],meaning:'比较该候选与选中方案的同一具体对象质量；不同范围无共同对象时not_comparable，不用缺少其他视角动作判weaker；not_comparable须用alternative_object定位该候选具体处理的不同风险或对象'}
    input.review_output_contract.selection_mode=['quality_difference','equivalent_choice','no_selection']
    input.review_output_contract.action_reviews.residual_risk_source_values=require('./enterprise-action-audit').RESIDUAL_RISK_SOURCES
    input.review_output_contract.boundary_reviews.relationships=require('./enterprise-action-audit').BOUNDARY_RELATIONSHIPS
    input.review_output_contract.timing_reviews.targets=input.candidates.map(c=>({seat_id:c.seat_id,codes:input.action_history.filter(h=>h.seat_id===c.seat_id).map(h=>h.code)}))
  }
  const comparison = stage==='condition' ? '成立候选逐席填写comparison_to_selected:{relation:selected/weaker/equivalent/not_comparable,shared_object:共同具体对象或null,quality_basis:evidence_strength/action_directness/execution_boundary/timing_fit或null,reason}。weaker须在共同对象上证明质量差别，并填写candidate_action_ids和selected_action_ids分别绑定双方当前已有实际行动（非10或13）；这些是定位符，不以同码判等效、不同码判劣势。非weaker可不填写。匿名候选的职责仅依实际行动判断，不推测原席位身份或给予岗位优势。不得用缺少另一视角动作或未知内部数据证明较弱。不存在共同对象用not_comparable，不能为了排名编造共同对象。选中者用selected。有任何成立替代方案equivalent或not_comparable，selection_mode须equivalent_choice，review_reason明确这是多个成立完整方案中的等效选择，不宣称唯一最佳；仅全部成立替代方案均有同对象质量劣势时用quality_difference。没有选择用no_selection。action_history的标记事实由程序记录，表示新增前已收到同码同行意见；timing_reviews.reason只解释既有事实能否独立支持该新增，不重述或改写先后顺序。' : ''
  return [{role:'system',content:policy + task + challenge + audit + comparison + reviewInstruction(stage)}, {role:'user',content:JSON.stringify(input)}]
}
function reviewInstruction(stage) {
  return '先形成candidate_reviews的独立判断，再写比较理由和选择；最终只输出JSON：consistent(boolean),selected_seat_id(已有完整候选ID或null),unresolved_gaps(阻断缺口字符串数组),authority(within_rules/requires_human),applied_rule_ids(输入裁决规则ID数组),review_reason,candidate_reviews。candidate_reviews逐席填写{seat_id,assessment:supported/unsupported/uncertain,independence:independent/peer_support_only/uncertain,reason}；核对本席位视角内的独立证据与推论，同行认同和重复不是依据，选中候选须independence=independent' + (stage === 'condition' ? '，每席还须action_reviews:[{id,assessment:supported/unsupported/uncertain,reason}]逐项覆盖实际行动，以及combination_assessment:compatible/conflicting/uncertain/not_applicable,combination_reason，实际行动候选须增加combination_direction_assessment:compatible/conflicting/uncertain，检查整个组合而非只逐项。实际组合通过须全部行动supported且组合compatible，无实际行动使用not_applicable。' : '。') + '语义判断由你完成，程序仅核对字段和授权规则ID。多个完整候选均成立不构成缺少授权或必须人工排名；依据SUPPORTED_WHOLE_CANDIDATE选择并说明理由。unresolved_gaps仅列阻断结论的缺口，普通限制留在候选中；不通过但仍在授权内时consistent=false且authority=within_rules。超出规则、缺少适用规则或规则冲突时authority=requires_human且consistent=false，说明需人工确认什么；不补造规则。不按多数票，不拼接各席片段。' + (stage === 'condition' ? '每席增加task_coverage(sufficient/insufficient/uncertain/not_applicable)，仅判断该席位视角内有证据的关键问题是否得到回应，不要求覆盖其他席位维度；每项action_reviews增加necessity(required/optional/uncertain),omission_impact(删去后果),direction_assessment(compatible/conflicting/uncertain)。每席增加issues:[{kind:direction_conflict/action_conflict/redundant,action_ids:涉及的行动编号数组,reason}]，无问题用[]；行动冲突须绑定至少两个编号。通过须方向相容且issues为空。有证据支持不等于必须执行；检查现有其他行动能否覆盖。通过须本席位关键风险得到合理回应且各保留项必要；无实际行动用not_applicable；[13]表示已有安排足够、无需新增措施，必须填写no_action_review:{assessment:supported/unsupported/uncertain,direction_assessment:compatible/conflicting/uncertain,reason}，独立核对已有安排证据、充分性及整体方向；[10]表示无法可靠建议，recommendations禁止空数组，须按各自理由复核，不为填写action_reviews而生成行动。不因某席位缺少其他席位的行动而要求补齐。选项分类不同不证明独立必要性；逐项核对新增行动的addition_basis，并回应其他候选关于覆盖、重复或证据不足的具体异议。同行支持数量、反复表述均不作为依据。不得按数量选优。若已有候选都需修订，可返回revision_requests:[{seat_id,action_ids,reason}]交回原席独立修改；此时consistent=false,selected_seat_id=null,authority=within_rules。无修订请求用[]。原席仍将保留项标为necessary=false时，须返回原席修订后再批准。不得自行删项或生成新候选。' : '')
}
module.exports = { reviewRules, NECESSITY_POLICY, buildReviewPrompt, buildSeatPrompt, directionCore, peerSummary, peerChangeView, conditionChanges, peerDelivery, discussionVersion, substantivePayload, VERSION, REVIEW_RULES, candidatePayload, validateAnalysis, validateExchange, exchangeInstruction, analysisInstruction, inputVersion, summarizeSeats, validateReview, validateSelectionComparison, reviewInstruction }
