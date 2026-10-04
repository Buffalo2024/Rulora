const { isActualAction } = require('./enterprise-action-contract')
const {canonicalJson}=require('./utils')
const {flaggedAdditions,RESIDUAL_RISK_SOURCES,BOUNDARY_RELATIONSHIPS}=require('./enterprise-action-audit')
// Only contract errors are eligible for a format-only repair. Business gate
// failures require a separately recorded reassessment, never a silent repair.
const FORMAT_ERRORS=new Set(['行动审查须声明保留依据来源residual_risk_source','not_comparable须声明具体不同对象alternative_object','复核须声明候选比较选择模式','成立候选须声明与选中方案的同对象比较','语义复核含未授权字段','复核consistent与unresolved_gaps结构无效','复核须声明权限与判断理由','复核须保留五席逐席评估','逐席复核结构无效','逐席复核须声明独立依据状态','复核须判断任务覆盖程度','复核须判断本席位范围充分性','复核须声明行动必要性及删去后果','复核必须逐项覆盖该席全部已选行动','逐行动复核结构无效','逐行动须声明与第一层方向的相容性','复核须提供issues数组，无问题时为空','复核缺少组合判定','复核问题须绑定已有行动编号并说明类型和理由','修订请求须绑定已有席位和行动编号','复核引用未授权规则','行动审查须声明已知依据、删除解释及保留回应','边界审查须绑定候选内两个行动及关系理由','选中组合须逐对覆盖行动边界且不得重复','复核须声明整个组合与第一层方向的相容性','无需新增措施复核须声明已有安排充分性及方向相容性','时序审查须绑定本席已标记新增行动并声明独立性','选中候选须覆盖全部时序标记'])
function repairMode(errors) { return errors.every(e=>FORMAT_ERRORS.has(e))?'format_only':'business_reassessment' }
const obj=x=>x&&typeof x==='object'&&!Array.isArray(x)
const arr=x=>Array.isArray(x)?x:[]
const prose=(row,fields)=>Object.fromEntries(fields.filter(key=>typeof row[key]==='string'&&row[key].trim()).map(key=>[key,row[key]]))
const enums=(row,fields)=>Object.fromEntries(Object.entries(fields).filter(([key,values])=>values.includes(row[key])).map(([key])=>[key,row[key]]))
function verdict(value,context) {
 if(!obj(value))return null
 const scoped=Array.isArray(context?.candidates),candidateFor=id=>scoped?context.candidates.find(c=>c.seat_id===id):null
 const snapshot=prose(value,['review_reason'])
 if(typeof value.consistent==='boolean')snapshot.consistent=value.consistent
 if(value.selected_seat_id===null||(!scoped&&typeof value.selected_seat_id==='string')||candidateFor(value.selected_seat_id))snapshot.selected_seat_id=value.selected_seat_id
 Object.assign(snapshot,enums(value,{authority:['within_rules','requires_human']}))
 Object.assign(snapshot,enums(value,{selection_mode:['quality_difference','equivalent_choice','no_selection']}))
 if(Array.isArray(value.unresolved_gaps))snapshot.has_unresolved_gaps=value.unresolved_gaps.length>0
 if(Array.isArray(value.applied_rule_ids)) {
  const known=value.applied_rule_ids.filter(id=>!Array.isArray(context?.arbitrationRules)||context.arbitrationRules.some(r=>r.id===id))
  if(known.length)snapshot.applied_rule_ids=known.map(id=>({id}))
 }
 snapshot.candidate_reviews=arr(value.candidate_reviews).filter(r=>obj(r)&&(!scoped||candidateFor(r.seat_id))).map(r=>{
  const candidate=candidateFor(r.seat_id),ids=arr(candidate?.recommendations).filter(id=>isActualAction(id)),inScope=id=>!scoped||ids.includes(id)
  const out={seat_id:r.seat_id,...prose(r,['reason']),...enums(r,{assessment:['supported','unsupported','uncertain'],independence:['independent','peer_support_only','uncertain']})}
  if(context?.stage==='direction')return out
  if(obj(r.comparison_to_selected)) {
    out.comparison_to_selected={...prose(r.comparison_to_selected,['reason','alternative_object']),...enums(r.comparison_to_selected,{relation:['selected','weaker','equivalent','not_comparable'],quality_basis:['evidence_strength','action_directness','execution_boundary','timing_fit']})}
    for(const field of ['candidate_action_ids','selected_action_ids'])if(Array.isArray(r.comparison_to_selected[field])&&r.comparison_to_selected[field].length)out.comparison_to_selected[field]=canonicalJson([...r.comparison_to_selected[field]].sort((a,b)=>a-b))
    if(typeof r.comparison_to_selected.shared_object==='string'&&r.comparison_to_selected.shared_object.trim())out.comparison_to_selected.shared_object=r.comparison_to_selected.shared_object
  }
  Object.assign(out,prose(r,['combination_reason']))
  Object.assign(out,enums(r,{combination_direction_assessment:['compatible','conflicting','uncertain']}))
  if(obj(r.no_action_review))out.no_action_review={...prose(r.no_action_review,['reason']),...enums(r.no_action_review,{assessment:['supported','unsupported','uncertain'],direction_assessment:['compatible','conflicting','uncertain']})}
  Object.assign(out,enums(r,{task_coverage:scoped?(!ids.length?['not_applicable']:['sufficient','insufficient','uncertain']):['sufficient','insufficient','uncertain','not_applicable'],combination_assessment:scoped?(!ids.length?['not_applicable']:['compatible','conflicting','uncertain']):['compatible','conflicting','uncertain','not_applicable']}))
  out.action_reviews=arr(r.action_reviews).filter(a=>obj(a)&&inScope(a.id)).map(a=>({id:a.id,...prose(a,['reason','omission_impact','known_basis','deletion_case','retention_response']),...enums(a,{assessment:['supported','unsupported','uncertain'],necessity:['required','optional','uncertain'],direction_assessment:['compatible','conflicting','uncertain'],basis_status:['established','unknown_only','uncertain'],countercheck_status:['adequate','no_plausible_alternative','invalid','uncertain'],residual_risk_source:RESIDUAL_RISK_SOURCES})}))
  out.boundary_reviews=arr(r.boundary_reviews).filter(x=>obj(x)&&Array.isArray(x.action_ids)&&x.action_ids.length===2&&new Set(x.action_ids).size===2&&x.action_ids.every(inScope)&&BOUNDARY_RELATIONSHIPS.includes(x.relationship)).map(x=>({id:[...x.action_ids].sort((a,b)=>a-b).join(':'),relationship:x.relationship,...prose(x,['reason'])}))
  const flags=scoped&&Array.isArray(context?.actionHistory)?flaggedAdditions(context.actionHistory,candidate):null
  out.timing_reviews=arr(r.timing_reviews).filter(x=>obj(x)&&inScope(x.code)&&(!flags||flags.some(f=>f.code===x.code))&&['independent','peer_only','uncertain'].includes(x.assessment)).map(x=>({id:x.code,assessment:x.assessment,...prose(x,['reason'])}))
  out.issues=arr(r.issues).filter(x=>obj(x)&&['direction_conflict','action_conflict','redundant'].includes(x.kind)&&Array.isArray(x.action_ids)&&x.action_ids.length&&new Set(x.action_ids).size===x.action_ids.length&&x.action_ids.every(inScope)&&(x.kind!=='action_conflict'||x.action_ids.length>=2)).map(x=>({id:x.kind+':'+[...x.action_ids].sort((a,b)=>a-b).join(':'),kind:x.kind,...prose(x,['reason'])}))
  if(Array.isArray(r.issues))out.issue_verdict=canonicalJson(out.issues.map(x=>x.id).sort())
  return out
 })
 snapshot.revision_requests=arr(value.revision_requests).filter(r=>obj(r)&&(!scoped||candidateFor(r.seat_id))&&Array.isArray(r.action_ids)&&r.action_ids.every(id=>!scoped||arr(candidateFor(r.seat_id)?.recommendations).includes(id))).map(r=>({id:r.seat_id+':'+[...r.action_ids].sort((a,b)=>a-b).join(':'),...prose(r,['reason'])}))
 if(Array.isArray(value.revision_requests))snapshot.revision_request_verdict=canonicalJson(snapshot.revision_requests.map(x=>x.id).sort())
 return snapshot
}
function assertRepairPreservesVerdict(previous,current,context) {
  const before=verdict(previous,context),after=verdict(current,context)
  function includesKnown(a,b) {
    if(Array.isArray(a))return Array.isArray(b)&&a.every(x=>includesKnown(x,b.find(y=>x.seat_id!=null?y.seat_id===x.seat_id:y.id===x.id)))
    if(a&&typeof a==='object')return b&&Object.keys(a).every(k=>includesKnown(a[k],b[k]))
    return canonicalJson(a)===canonicalJson(b)
  }
  if(before && !includesKnown(before,after))throw Object.assign(new Error('格式修订改变复核裁决；保留原输出与修订输出，须重新复核，不得直接交付'),{code:'ENTERPRISE_REVIEW_VERDICT_DRIFT',previous_verdict:before,revised_verdict:after})
}
function nextReviewRepair({attempt,errors,value,verdictDrift}) {
 if(verdictDrift&&attempt===1)return {mode:'fresh_reassessment',errors,previous_output:null}
 if(attempt>=1)return null
 return {mode:value?repairMode(errors):'contract_repair',errors,previous_output:value}
}
module.exports={repairMode,verdict,assertRepairPreservesVerdict,nextReviewRepair}
