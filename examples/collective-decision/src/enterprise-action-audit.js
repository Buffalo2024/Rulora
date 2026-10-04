const { isActualAction } = require('./enterprise-action-contract')
const {canonicalJson,sha256}=require('./utils')
const RESIDUAL_RISK_SOURCES=Object.freeze(['known_fact','unknown_sufficiency','no_residual_risk'])
const BOUNDARY_RELATIONSHIPS=Object.freeze(['independent','shared_object_independent','overlapping','uncertain'])
const obj=x=>x&&typeof x==='object'&&!Array.isArray(x)
const text=x=>typeof x==='string'&&Boolean(x.trim())
const codes=c=>(Array.isArray(c?.recommendations)?c.recommendations:[]).filter(x=>Number.isInteger(x)&&isActualAction(x))
const action=(c,id)=>structuredClone(c?.actions?.find(a=>a.id===id)||null)
const version=c=>c?.discussion_version||sha256(canonicalJson(c))

// Provenance is copied from the synchronous round input, never inferred from prose.
function recordActionHistory(history,before,after,round,deliveries={},receipts={}) {
 for(const [recipient,peers] of Object.entries(deliveries)) {
  receipts[recipient] ||= {}
  for(const peer of peers)if(!peer.unchanged&&Array.isArray(peer.actions))receipts[recipient][peer.seat_id]=structuredClone(peer)
 }
 for(const current of after) {
  const previous=before.find(c=>c.seat_id===current.seat_id)
  for(const code of new Set([...codes(previous),...codes(current)])) {
   const kind=!previous?'initial':!codes(previous).includes(code)?'added':!codes(current).includes(code)?'removed':null
   if(!kind)continue
   const received_same_code=kind==='added'?Object.values(receipts[current.seat_id]||{}).filter(peer=>codes(peer).includes(code)).map(peer=>({seat_id:peer.seat_id,candidate_version:peer.candidate_version,action_snapshot:action(peer,code),first_proposed_round:history.find(h=>h.seat_id===peer.seat_id&&h.code===code&&h.kind!=='removed')?.round??0})):[]
   history.push({seat_id:current.seat_id,code,round,kind,candidate_version:version(current),action_snapshot:action(kind==='removed'?previous:current,code),received_same_code,temporal_signal:received_same_code.length?'received_peer_code_before_addition':'none'})
  }
 }
}
function flaggedAdditions(history,candidate) {
 return codes(candidate).map(code=>history.filter(h=>h.seat_id===candidate.seat_id&&h.code===code).at(-1)).filter(h=>h?.kind==='added'&&h.received_same_code.length)
}
function pairKey(ids){return [...ids].sort((a,b)=>a-b).join(':')}
function validateActionAuditReview(review,candidates,history=[]) {
 const errors=[]
 for(const row of Array.isArray(review.candidate_reviews)?review.candidate_reviews:[]) {
  if(!obj(row))continue
  const candidate=candidates.find(c=>c.seat_id===row.seat_id);if(!candidate)continue
  const ids=codes(candidate),selected=review.consistent&&row.seat_id===review.selected_seat_id
  for(const a of Array.isArray(row.action_reviews)?row.action_reviews:[]) {
   if(!obj(a))continue
   if(!['established','unknown_only','uncertain'].includes(a.basis_status)||!text(a.known_basis)||!['adequate','no_plausible_alternative','invalid','uncertain'].includes(a.countercheck_status)||!text(a.deletion_case)||!text(a.retention_response))errors.push('行动审查须声明已知依据、删除解释及保留回应')
   if(selected&&(a.basis_status!=='established'||!['adequate','no_plausible_alternative'].includes(a.countercheck_status)))errors.push('不得批准仅由未知支持或反证未通过的行动')
   const validSource=RESIDUAL_RISK_SOURCES.includes(a.residual_risk_source)
   if(!validSource)errors.push('行动审查须声明保留依据来源residual_risk_source')
   // Missing/invalid fields are format errors; valid contradictory declarations
   // are business judgments and must never be changed by format-only repair.
   if(selected&&validSource&&a.residual_risk_source!=='known_fact')errors.push('被选行动须有已知剩余风险，不能以未知充分性或无剩余风险支撑保留')
   if(a.residual_risk_source==='no_residual_risk'&&a.necessity==='required')errors.push('无剩余风险不得同时声明行动必要')
  }
  const pairs=row.boundary_reviews||[],keys=[]
  if(!Array.isArray(pairs))errors.push('边界审查须绑定候选内两个行动及关系理由')
  for(const pair of Array.isArray(pairs)?pairs:[]) {
   if(!obj(pair)||!Array.isArray(pair.action_ids)||pair.action_ids.length!==2||new Set(pair.action_ids).size!==2||pair.action_ids.some(id=>!ids.includes(id))||!BOUNDARY_RELATIONSHIPS.includes(pair.relationship)||!text(pair.reason)){errors.push('边界审查须绑定候选内两个行动及关系理由');continue}
   keys.push(pairKey(pair.action_ids))
   if(selected&&!['independent','shared_object_independent'].includes(pair.relationship))errors.push('不得批准边界重叠或独立作用未决的组合')
  }
  const expected=ids.flatMap((id,i)=>ids.slice(i+1).map(other=>pairKey([id,other])))
  if(new Set(keys).size!==keys.length||(selected&&(keys.length!==expected.length||expected.some(k=>!keys.includes(k)))))errors.push('选中组合须逐对覆盖行动边界且不得重复')
  const timing=row.timing_reviews||[],flags=flaggedAdditions(history,candidate),timingCodes=[]
  if(!Array.isArray(timing))errors.push('时序审查须绑定本席已标记新增行动并声明独立性')
  for(const item of Array.isArray(timing)?timing:[]) {
   if(!obj(item)||!flags.some(f=>f.code===item.code)||!['independent','peer_only','uncertain'].includes(item.assessment)||!text(item.reason)){errors.push('时序审查须绑定本席已标记新增行动并声明独立性');continue}
   timingCodes.push(item.code)
   if(selected&&item.assessment!=='independent')errors.push('不得批准新增依据仅来自同行或独立性未决的行动')
  }
  if(new Set(timingCodes).size!==timingCodes.length||(selected&&(timingCodes.length!==flags.length||flags.some(f=>!timingCodes.includes(f.code)))))errors.push('选中候选须覆盖全部时序标记')
 }
 return [...new Set(errors)]
}
module.exports={recordActionHistory,flaggedAdditions,validateActionAuditReview,RESIDUAL_RISK_SOURCES,BOUNDARY_RELATIONSHIPS}
