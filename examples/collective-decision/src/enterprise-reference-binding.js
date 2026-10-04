const { isActualAction, OBJECT_BOUNDARIES } = require('./enterprise-action-contract')
const { canonicalJson, sha256 } = require('./utils')
const fields = new Set(['evidence_refs','counter_evidence_refs','relevant_evidence_ids','allowed_evidence_ids'])
function createBinding(prompt,{anonymizeCandidates=true}={}) {
  const input = JSON.parse(prompt.find(x => x.role === 'user').content)
  if (!Array.isArray(input.evidence)) return null
  const entries = [...new Set(input.evidence.map(x => x.id))].sort().map((id,i) => ({selector:i+1,id}))
  const candidateEntries=anonymizeCandidates && input.candidate_identity_policy==='anonymous_transport' && Array.isArray(input.candidates)
    ? input.candidates.map(c=>({id:c.seat_id,order:sha256(canonicalJson({question:input.question,evidence:entries,seat:c.seat_id}))})).sort((a,b)=>a.order.localeCompare(b.order)).map((c,i)=>({alias:`candidate_${i+1}`,id:c.id})) : []
  return {version:candidateEntries.length?'1.1.0':'1.0.0',entries,sha256:sha256(canonicalJson(entries)),...(candidateEntries.length?{candidate_entries:candidateEntries,candidate_sha256:sha256(canonicalJson(candidateEntries))}:{}),direction_version:input.frozen_direction?.version || null,broadcast_version:input.broadcast_version || null,
    ...(input.stage === 'condition' && Array.isArray(input.own?.recommendations) ? {exchange_prior_codes:[...input.own.recommendations]} : {}),
    ...(input.stage === 'condition' && Array.isArray(input.candidates) ? {review_candidates:input.candidates.map(c=>({seat_id:c.seat_id,recommendations:c.recommendations})),
      timing_targets:input.candidates.map(c=>({seat_id:c.seat_id,codes:(input.action_history||[]).filter(h=>h.seat_id===c.seat_id && c.recommendations.includes(h.code)).map(h=>h.code)}))} : {})}
}
function transform(value,binding,decode=false,key='') {
  const lookup = new Map(binding.entries.map(x => decode ? [x.selector,x.id] : [x.id,x.selector]))
  // Exact canonical identifiers are accepted for persisted and injected providers.
  // Unknown values stay unknown: the contract gate rejects them without guessing.
  const select = x => lookup.has(x) ? lookup.get(x) : x
  const candidates=new Map((binding.candidate_entries||[]).map(c=>decode?[c.alias,c.id]:[c.id,c.alias]))
  if(['seat_id','selected_seat_id'].includes(key))return candidates.get(value)||value
  if (fields.has(key) && Array.isArray(value)) return value.map(select)
  if (key === 'reasons_by_id' && value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([id,reason])=>[select(decode && /^\d+$/.test(id) ? Number(id) : id),reason]))
  if (Array.isArray(value)) return value.map(x=>transform(x,binding,decode))
  if (!value || typeof value !== 'object') {
    if(typeof value!=='string')return value
    if(decode)return value.replace(/\bcandidate_\d+\b/g,id=>candidates.get(id)||id)
    for(const [id,alias] of candidates)value=value.replace(new RegExp('\\b'+id.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'\\b','g'),alias)
    return value
  }
  return Object.fromEntries(Object.entries(value).map(([field,item])=>[field,!decode && (field==='evidence_id' || (field==='id' && value.core_facts)) ? select(item) : transform(item,binding,decode,field)]))
}
function encodePrompt(prompt,binding) {
  if (!binding) return prompt
  return prompt.map(message=>{
    if(message.role!=='user') return message
    let input
    try {input=JSON.parse(message.content)} catch{return message}
    input=transform(input,binding)
    if(binding.candidate_entries?.length && Array.isArray(input.candidates)) {
      // Lens is audit context, not a ranking signal in blind review transport.
      input.candidates=input.candidates.map(({seat_lens,...candidate})=>candidate)
      input.candidates.sort((a,b)=>binding.candidate_entries.findIndex(c=>c.alias===a.seat_id)-binding.candidate_entries.findIndex(c=>c.alias===b.seat_id))
    }
    if(input.frozen_direction) input.frozen_direction.version='program_bound'
    if(input.broadcast_version) input.broadcast_version='program_bound'
    return {...message,content:JSON.stringify(input)}
  }).concat([{role:'system',content:'证据引用仅填写本次 evidence.id 的整数序号，程序按冻结映射登记原始编号；不要生成或复写原始证据编号。direction_version与broadcast_version由程序绑定，不需输出。业务判断仍由你完成。'}])
}
function bindOutput(value,binding,operations) {
  if(!binding) return value
  const result=transform(value,binding,true)
  // Applicability comes from trusted versions/history, not the model's prose.
  // Remove only well-shaped annotations on real actions outside this scope;
  // Unknown IDs, malformed rows and invalid references remain for the gate;
  // duplicates/missing rows inside the required scope still fail.
  if (Array.isArray(binding.exchange_prior_codes) && Array.isArray(result.candidate?.recommendations) && Array.isArray(result.addition_basis)) {
    result.addition_basis=result.addition_basis.filter(item=>{
      const outside=item && Number.isInteger(item.code) && isActualAction(item.code) && binding.exchange_prior_codes.includes(item.code) && result.candidate.recommendations.includes(item.code) &&
        typeof item.lens_gap==='string' && item.lens_gap.trim() && typeof item.why_existing_insufficient==='string' && item.why_existing_insufficient.trim() && Array.isArray(item.evidence_refs) && item.evidence_refs.length && item.evidence_refs.every(id=>binding.entries.some(e=>e.id===id))
      if(outside) operations.push({type:'DETERMINISTIC_STRUCTURE',operation:'exclude_existing_action_from_addition_scope',code:item.code,removed_value:structuredClone(item)})
      return !outside
    })
  }
  if (Array.isArray(binding.timing_targets) && Array.isArray(result.candidate_reviews)) {
    for(const row of result.candidate_reviews) {
      const target=binding.timing_targets.find(t=>t.seat_id===row?.seat_id)
      const candidate=binding.review_candidates?.find(c=>c.seat_id===row?.seat_id)
      if(candidate && Array.isArray(candidate.recommendations) && candidate.recommendations.length &&
          (candidate.recommendations.every(isActualAction) || (candidate.recommendations.length===1 && candidate.recommendations[0]===10)) &&
          row.no_action_review && typeof row.no_action_review==='object' && !Array.isArray(row.no_action_review) && !Object.keys(row.no_action_review).length) {
        delete row.no_action_review
        operations.push({type:'DETERMINISTIC_STRUCTURE',operation:'exclude_empty_no_action_review',seat_id:row.seat_id})
      }
      if(!target || !candidate || !Array.isArray(row.timing_reviews))continue
      row.timing_reviews=row.timing_reviews.filter(item=>{
        const outside=item && Number.isInteger(item.code) && isActualAction(item.code) && candidate.recommendations.includes(item.code) && !target.codes.includes(item.code) &&
          ['independent','peer_only','uncertain'].includes(item.assessment) && typeof item.reason==='string' && item.reason.trim()
        if(outside)operations.push({type:'DETERMINISTIC_STRUCTURE',operation:'exclude_unflagged_action_from_timing_scope',seat_id:row.seat_id,code:item.code,removed_value:structuredClone(item)})
        return !outside
      })
    }
  }
  // An empty action set determines applicability, not the business verdict.
  // Never change selection, necessity, evidence, or conflicting nonempty reviews.
  if (Array.isArray(binding.review_candidates) && Array.isArray(result.candidate_reviews)) {
    for (const row of result.candidate_reviews) {
      const own=binding.review_candidates.find(c=>c.seat_id===row?.seat_id)
      if (!own || !Array.isArray(own.recommendations) || !(own.recommendations.length===1 && [10,13].includes(own.recommendations[0])) ||
          !Array.isArray(row.action_reviews) || row.action_reviews.length || row.combination_assessment!=='not_applicable' ||
          !['sufficient','not_applicable'].includes(row.task_coverage)) continue
      if(row.task_coverage!=='not_applicable') {
        operations.push({type:'DETERMINISTIC_STRUCTURE',operation:'derive_empty_action_applicability',seat_id:row.seat_id,before:row.task_coverage,after:'not_applicable'})
        row.task_coverage='not_applicable'
      }
    }
  }
  const candidate=result.candidate || result
  // Normalize only out-of-scope empty annotations, never a nonempty business basis.
  if(Array.isArray(candidate.recommendations) && candidate.recommendations.length && candidate.recommendations.every(isActualAction)) {
    if(candidate.no_action_basis && typeof candidate.no_action_basis==='object' && !Array.isArray(candidate.no_action_basis) && !Object.keys(candidate.no_action_basis).length) {
      delete candidate.no_action_basis
      operations.push({type:'DETERMINISTIC_STRUCTURE',operation:'exclude_empty_no_action_basis_from_actual_candidate'})
    }
    for(const action of Array.isArray(candidate.actions)?candidate.actions:[]) {
      if(!isActualAction(action?.id) || OBJECT_BOUNDARIES[action.id])continue
      for(const field of ['decision_object','commitment_status']) {
        if(action[field]===null || (typeof action[field]==='string' && action[field].trim())) {
          operations.push({type:'DETERMINISTIC_STRUCTURE',operation:'exclude_unrequired_object_annotation',code:action.id,field,removed_value:action[field]})
          delete action[field]
        }
      }
    }
  }
  // Explicit registered selectors in a prose counter-evidence slot are references,
  // not fabricated explanations. Relocate them to the typed reference field.
  const registry=new Set(binding.entries.map(e=>e.id)),selectors=new Map(binding.entries.map(e=>[e.selector,e.id]))
  for(const item of Array.isArray(candidate.label_assessments)?candidate.label_assessments:[]) {
    if(!Array.isArray(item?.counter_evidence) || (item.counter_evidence_refs!==undefined && !Array.isArray(item.counter_evidence_refs)))continue
    const refs=item.counter_evidence.filter(x=>selectors.has(x) || registry.has(x)).map(x=>selectors.get(x)||x)
    if(!refs.length)continue
    const before=structuredClone(item.counter_evidence)
    item.counter_evidence=item.counter_evidence.filter(x=>!selectors.has(x) && !registry.has(x))
    item.counter_evidence_refs=[...new Set([...(item.counter_evidence_refs||[]),...refs])]
    operations.push({type:'DETERMINISTIC_REFERENCE_BINDING',operation:'relocate_registered_counter_evidence_refs',code:item.code,before,refs})
  }
  if(Array.isArray(candidate.actions) && Array.isArray(candidate.label_assessments)) {
    const registered=new Set(binding.entries.map(e=>e.id))
    for(const action of candidate.actions) {
      const paired=candidate.label_assessments.filter(row=>row?.code===action?.id)
      if(paired.length!==1 || candidate.actions.filter(a=>a?.id===action?.id).length!==1)continue
      const label=paired[0]
      for(const [target,source] of [[action,label],[label,action]]) {
        if(Array.isArray(target?.evidence_refs) && target.evidence_refs.length===0 && Array.isArray(source?.evidence_refs) && source.evidence_refs.length && source.evidence_refs.every(id=>registered.has(id))) {
          target.evidence_refs=[...source.evidence_refs]
          operations.push({type:'DETERMINISTIC_REFERENCE_BINDING',operation:'copy_same_action_reference',code:action.id,to:target===action?'actions':'label_assessments',refs:[...source.evidence_refs]})
        }
      }
    }
  }
  if(binding.direction_version && candidate && (Object.hasOwn(candidate,'recommendations') || Object.hasOwn(candidate,'actions'))) candidate.direction_version=binding.direction_version
  if(binding.broadcast_version) result.broadcast_version=binding.broadcast_version
  if(candidate && Object.hasOwn(candidate,'reason') && (Object.hasOwn(candidate,'direction') || Object.hasOwn(candidate,'recommendations'))) {
    const refs = Array.isArray(candidate.evidence_refs) ? [...candidate.evidence_refs] : []
    for(const row of [...(Array.isArray(candidate.factors)?candidate.factors:[]),...(Array.isArray(candidate.actions)?candidate.actions:[]),...(Array.isArray(candidate.label_assessments)?candidate.label_assessments:[]),...(Array.isArray(candidate.no_action_basis?.existing_arrangements)?candidate.no_action_basis.existing_arrangements:[])]) {
      for(const field of ['evidence_refs','counter_evidence_refs']) if(Array.isArray(row?.[field])) refs.push(...row[field])
    }
    if(candidate.evidence_refs === undefined || Array.isArray(candidate.evidence_refs)) candidate.evidence_refs=[...new Set(refs)]
  }
  operations.push({type:'DETERMINISTIC_REFERENCE_BINDING',operation:'bind_frozen_reference_registry',binding:structuredClone(binding),before:structuredClone(value),after:structuredClone(result)})
  return result
}
module.exports={createBinding,encodePrompt,bindOutput,transform}
