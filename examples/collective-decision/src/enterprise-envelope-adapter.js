const { canonicalJson } = require('./utils')
const EXCHANGE_FIELDS = ['review_decision','revision_kind','review_summary','broadcast_version','addition_basis']
const CANDIDATE_FIELDS = ['direction','recommendations','reason','evidence_refs','gaps','assumptions','factors','seat_summary','direction_version','actions','label_assessments','combination_reason','no_action_basis']
const object = value => value && typeof value === 'object' && !Array.isArray(value)
function move(source, target, field, from, to, operations) {
  if (!Object.hasOwn(source, field)) return
  if (Object.hasOwn(target, field) && canonicalJson(target[field]) !== canonicalJson(source[field])) {
    throw Object.assign(new Error(`输出字段层级冲突：${from}.${field}与${to}.${field}不一致；不得自动选择`),{code:'MODEL_SCHEMA_FAILURE'})
  }
  const original=structuredClone(source[field])
  target[field]=original
  delete source[field]
  operations.push({type:'SAFE_NORMALIZATION',operation:'relocate_unique_contract_field',from:`${from}.${field}`,to:`${to}.${field}`,value:original})
}
function normalizeEnterpriseEnvelope(value, operation, operations) {
  if (!object(value) || operation !== 'enterpriseDecisionReview') return value
  if (object(value.candidate)) {
    for(const field of EXCHANGE_FIELDS) move(value.candidate,value,field,'candidate','exchange',operations)
  }
  const misplaced=CANDIDATE_FIELDS.filter(field=>Object.hasOwn(value,field))
  if(misplaced.length) {
    if(value.candidate === undefined && ['revise','undetermined'].includes(value.review_decision)) {
      value.candidate={}
      operations.push({type:'SAFE_NORMALIZATION',operation:'wrap_flat_candidate_fields',fields:misplaced})
    }
    if(object(value.candidate)) for(const field of misplaced) move(value,value.candidate,field,'exchange','candidate',operations)
    // Null/maintain is not converted into a different business verdict.
  }
  if(value.review_decision === 'revise' && !Object.hasOwn(value,'revision_kind')) {
    value.revision_kind='substantive'
    operations.push({type:'PROGRAM_CONTROL_DEFAULT',operation:'default_conservative_revision_kind',derived_value:'substantive',reason:'未声明仅润色时继续正常修订校验，不绕过广播或业务门禁'})
  }
  return value
}
module.exports={normalizeEnterpriseEnvelope,EXCHANGE_FIELDS,CANDIDATE_FIELDS}
