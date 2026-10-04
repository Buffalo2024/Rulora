const test=require('node:test'),assert=require('node:assert/strict')
const {createBinding,encodePrompt,bindOutput}=require('../src/enterprise-reference-binding')
const {adaptEnterpriseOutput}=require('../src/enterprise-output-protocol')
const prompt=[{role:'system',content:'contract'},{role:'user',content:JSON.stringify({evidence:[{id:'cninfo:1225580498',core_facts:[{evidence_id:'cninfo:1225580498',quote:'事实'}]},{id:'gov:12',core_facts:[]}],allowed_evidence_ids:['cninfo:1225580498','gov:12'],frozen_direction:{version:'trusted-direction',code:1},broadcast_version:'trusted-broadcast',own:{evidence_refs:['gov:12']},differences:[{evidence_refs:['cninfo:1225580498']}]})}]
test('anonymous review binds original seats exactly and never selects or assembles a candidate',()=>{
 const input={question:{subject:'company'},stage:'condition',evidence:[],candidate_identity_policy:'anonymous_transport',candidates:[{seat_id:'chain_risk',recommendations:[2,4]},{seat_id:'technology_fit',recommendations:[4]}],action_history:[{seat_id:'chain_risk',code:4}]}
 const messages=[{role:'user',content:JSON.stringify(input)}],binding=createBinding(messages),wire=JSON.parse(encodePrompt(messages,binding)[0].content)
 assert(wire.candidates.every(c=>/^candidate_\d+$/.test(c.seat_id)))
 assert.equal(JSON.stringify(wire).includes('chain_risk'),false)
 const chosen=wire.candidates[0],operations=[],output=bindOutput({selected_seat_id:chosen.seat_id,candidate_reviews:wire.candidates.map(c=>({seat_id:c.seat_id})),review_reason:`${chosen.seat_id} has the stronger execution boundary; candidate_99 is unknown`},binding,operations)
 assert.equal(output.selected_seat_id,binding.candidate_entries.find(c=>c.alias===chosen.seat_id).id)
 assert(output.review_reason.includes(output.selected_seat_id));assert(output.review_reason.includes('candidate_99'))
 assert.equal(bindOutput({selected_seat_id:'candidate_99'},binding,[]).selected_seat_id,'candidate_99')
 assert.deepEqual(input.candidates[0].recommendations,[2,4])
 input.candidates.reverse();assert.deepEqual(createBinding([{role:'user',content:JSON.stringify(input)}]).candidate_entries,binding.candidate_entries)
 assert.equal(createBinding(messages,{anonymizeCandidates:false}).candidate_entries,undefined)
})
test('wire uses selectors for evidence, excerpts, own and peer references',()=>{
 const binding=createBinding(prompt),input=JSON.parse(encodePrompt(prompt,binding)[1].content)
 assert.deepEqual(input.allowed_evidence_ids,[1,2]);assert.equal(input.evidence[0].id,1)
 assert.equal(input.evidence[0].core_facts[0].evidence_id,1)
 assert.deepEqual(input.own.evidence_refs,[2]);assert.deepEqual(input.differences[0].evidence_refs,[1])
 assert.equal(input.frozen_direction.version,'program_bound');assert.equal(input.broadcast_version,'program_bound')
 assert.equal(JSON.parse(prompt[1].content).evidence[0].id,'cninfo:1225580498')
})
test('adapter binds trusted versions and derives reference union without changing action choices',()=>{
 const binding=createBinding(prompt),raw={review_decision:'revise',candidate:{recommendations:[2],reason:'必要措施',actions:[{id:2,evidence_refs:[1]}],label_assessments:[{code:2,evidence_refs:[2]}],factors:[{evidence_refs:[1],counter_evidence_refs:[2]}],direction_version:'wrong'}}
 const adapted=adaptEnterpriseOutput(raw,{referenceBinding:binding})
 assert.equal(adapted.value.broadcast_version,'trusted-broadcast');assert.equal(adapted.value.candidate.direction_version,'trusted-direction')
 assert.deepEqual(adapted.value.candidate.evidence_refs,['cninfo:1225580498','gov:12'])
 assert.equal(adapted.value.candidate.actions[0].id,2);assert.equal(adapted.value.candidate.label_assessments[0].code,2)
 assert.equal(raw.candidate.direction_version,'wrong');assert.equal(adapted.operations[0].binding.sha256,binding.sha256)
 assert.deepEqual(JSON.parse(adapted.normalized_response),adapted.value)
})
test('screen reasons and IDs map exactly; unknown IDs and indices are never repaired',()=>{
 const binding=createBinding(prompt),ops=[]
 const output=bindOutput({relevant_evidence_ids:[1,99,'cninfo:1225480498'],reasons_by_id:{1:'相关',99:'未知'}},binding,ops)
 assert.deepEqual(output.relevant_evidence_ids,['cninfo:1225580498',99,'cninfo:1225480498'])
 assert.equal(output.reasons_by_id['cninfo:1225580498'],'相关');assert.equal(output.reasons_by_id['99'],'未知')
})
test('registry fingerprint changes when evidence identity changes and ordering stays stable',()=>{
 const binding=createBinding(prompt),input=JSON.parse(prompt[1].content)
 input.evidence.reverse();assert.equal(createBinding([{role:'user',content:JSON.stringify(input)}]).sha256,binding.sha256)
 input.evidence[0].id='different';assert.notEqual(createBinding([{role:'user',content:JSON.stringify(input)}]).sha256,binding.sha256)
})
test('explicit references can be copied within the same uniquely paired action, never from the whole candidate',()=>{
 const binding=createBinding(prompt),raw={recommendations:[2],reason:'必要',evidence_refs:[2],actions:[{id:2,evidence_refs:[]}],label_assessments:[{code:2,evidence_refs:[1]}]}
 const a=adaptEnterpriseOutput(raw,{referenceBinding:binding}).value;assert.deepEqual(a.actions[0].evidence_refs,['cninfo:1225580498'])
 raw.label_assessments[0].evidence_refs=[];assert.deepEqual(adaptEnterpriseOutput(raw,{referenceBinding:binding}).value.actions[0].evidence_refs,[])
 raw.label_assessments[0].evidence_refs=[99];assert.deepEqual(adaptEnterpriseOutput(raw,{referenceBinding:binding}).value.actions[0].evidence_refs,[])
})

test('anonymous review removes lens from transport while preserving audit prompt and actions',()=>{
 const prompt=[{role:'user',content:JSON.stringify({stage:'condition',candidate_identity_policy:'anonymous_transport',question:{},evidence:[],candidates:[{seat_id:'chain_risk',seat_lens:'upstream concentration and transmission',recommendations:[4],actions:[{id:4,target:'equipment',action:'staged purchase'}]}]})}]
 const binding=createBinding(prompt),encoded=encodePrompt(prompt,binding),wire=JSON.parse(encoded[0].content)
 assert.equal(wire.candidates[0].seat_lens,undefined)
 assert.equal(JSON.parse(prompt[0].content).candidates[0].seat_lens,'upstream concentration and transmission')
 assert.deepEqual(wire.candidates[0].actions,[{id:4,target:'equipment',action:'staged purchase'}])
})
