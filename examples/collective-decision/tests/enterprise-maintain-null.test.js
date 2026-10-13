const test=require('node:test'),assert=require('node:assert/strict')
const {adaptEnterpriseOutput}=require('../src/enterprise-output-protocol')
const {validateExchange}=require('../src/enterprise-deliberation')
const adapt=raw=>adaptEnterpriseOutput(raw,{operation:'enterpriseDecisionReview'})
const own={direction:0,reason:'已核验依据',evidence_refs:['E1'],gaps:[],assumptions:[],factors:[],seat_summary:'原意见'}
const context=stage=>({stage,own,peers:[],broadcastVersion:'v1',validate:()=>['本测试不允许替代候选']})
const maintain=()=>({review_decision:'maintain',review_summary:'保留本席原意见',broadcast_version:'v1'})

test('captured maintain omission normalizes once and passes both stage gates with own unchanged',()=>{
 for(const stage of ['direction','condition']) {
  const raw=maintain(),before=structuredClone(raw),originalOwn=structuredClone(own),result=adapt(raw)
  assert.deepEqual(validateExchange(result.value,context(stage)),[])
  assert.equal(result.value.review_decision,'maintain');assert.equal(result.value.candidate,null)
  assert.deepEqual(raw,before);assert.deepEqual(own,originalOwn)
  assert.deepEqual(result.operations,[{type:'SAFE_NORMALIZATION',operation:'restore_empty_maintain_candidate_slot',field:'candidate',derived_value:null,reason:'明确maintain且没有替代候选或新增行动内容；原完整候选保持不变'}])
  assert.deepEqual(adapt(result.value).operations,[])
 }
})
test('maintain never discards an explicit replacement candidate',()=>{
 const raw={...maintain(),candidate:{...own,direction:1}},result=adapt(raw)
 assert.deepEqual(result.value.candidate,raw.candidate)
 assert(validateExchange(result.value,context('direction')).some(e=>e.includes('candidate:null')))
 assert.deepEqual(result.operations,[])
})
test('maintain with flat business assertions retains them and fails closed',()=>{
 for(const fields of [{direction:1},{recommendations:[4]},{actions:[]},{reason:'新业务判断'}]) {
  const raw={...maintain(),...fields},result=adapt(raw)
  assert.deepEqual(result.value,raw)
  assert(validateExchange(result.value,context('direction')).length)
  assert.deepEqual(result.operations,[])
 }
})
test('revise and undetermined omissions still require a real candidate',()=>{
 for(const review_decision of ['revise','undetermined']) {
  const result=adapt({...maintain(),review_decision})
  assert.equal(Object.hasOwn(result.value,'candidate'),false)
  assert(validateExchange(result.value,context('direction')).length)
  assert(!result.operations.some(x=>x.operation==='restore_empty_maintain_candidate_slot'))
 }
})
test('unknown fields or claimed additions cannot obtain a derived null slot',()=>{
 for(const fields of [{addition_basis:[{code:4}]},{addition_basis:{code:4}},{unexpected:'内容'},{revision_kind:'substantive'}]) {
  const raw={...maintain(),...fields},result=adapt(raw)
  assert.deepEqual(result.value,raw)
  assert(validateExchange(result.value,context('condition')).length)
  assert.deepEqual(result.operations,[])
 }
 const result=adapt({...maintain(),addition_basis:[]})
 assert.deepEqual(validateExchange(result.value,context('condition')),[])
})
test('normalization cannot bypass broadcast binding or required review summary',()=>{
 for(const fields of [{broadcast_version:'wrong'},{review_summary:''}]) {
  const result=adapt({...maintain(),...fields})
  assert(validateExchange(result.value,context('direction')).length)
 }
 const result=adapt({...maintain(),candidate:null})
 assert.deepEqual(result.operations,[])
})
