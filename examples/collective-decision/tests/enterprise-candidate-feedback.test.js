const test = require('node:test'), assert = require('node:assert/strict')
const {candidateFeedback} = require('../src/enterprise-candidate-feedback')
const {nextCandidateRepair} = require('../src/enterprise-json-repair')
const {transform} = require('../src/enterprise-reference-binding')
const {validateExchange} = require('../src/enterprise-deliberation')
test('addition feedback locates outside references, preserves the rejected candidate and encodes selectors',()=>{
 const value={review_decision:'revise',revision_kind:'substantive',review_summary:'独立判断',broadcast_version:'v1',candidate:{recommendations:[2,3],evidence_refs:['E1']},addition_basis:[{code:3,lens_gap:'本席缺口',why_existing_insufficient:'既有措施不足',evidence_refs:['E2']}]}
 const before=structuredClone(value), errors=validateExchange(value,{own:{recommendations:[2]},stage:'condition',broadcastVersion:'v1',validate:()=>[]})
 assert(errors.some(e=>e.includes('候选内证据')))
 const repair=nextCandidateRepair({attempt:0,errors,firstErrors:errors,value,seatRepair:true})
 const finding=repair.feedback.findings[0]
 assert.equal(finding.path,'/addition_basis/0/evidence_refs');assert.deepEqual(finding.rejected.evidence_refs,['E2'])
 assert.deepEqual(finding.candidate.evidence_refs,['E1']);assert.deepEqual(value,before)
 const wire=transform(repair.feedback,{entries:[{id:'E1',selector:1},{id:'E2',selector:2}]})
 assert.deepEqual(wire.findings[0].rejected.evidence_refs,[2]);assert.deepEqual(wire.findings[0].candidate.evidence_refs,[1])
 assert.equal(nextCandidateRepair({attempt:1,errors,firstErrors:errors,value,seatRepair:true}),null)
 assert.deepEqual(validateExchange(value,{own:{recommendations:[2]},stage:'condition',broadcastVersion:'v1',validate:()=>[]}),errors)
})
test('valid subset and absent optional annotations do not invent findings; nonempty basis is never erased',()=>{
 const value={candidate:{recommendations:[2],evidence_refs:['E1'],no_action_basis:{why_sufficient:'真实依据'}},addition_basis:[{code:2,evidence_refs:['E1']}]}
 const before=structuredClone(value),feedback=candidateFeedback(value)
 assert.equal(feedback.findings.length,1);assert.equal(feedback.findings[0].code,'NO_ACTION_BASIS_NOT_APPLICABLE')
 assert.deepEqual(value,before)
 assert.deepEqual(candidateFeedback({recommendations:[13],no_action_basis:{why_sufficient:'真实依据'}}).findings,[])
})
