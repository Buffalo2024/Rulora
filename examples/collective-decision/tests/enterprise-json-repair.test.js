const test=require('node:test'),assert=require('node:assert/strict')
const {syntaxDiagnostic,nextCandidateRepair}=require('../src/enterprise-json-repair')
const bad='\n{\n  "direction": 1,\n  "seat_summary": "保持"审慎"判断"\n}\n'
const errors=['输出必须是唯一完整JSON对象'],args={errors,firstErrors:errors,rawOutput:bad,value:null,seatRepair:true}
test('syntax diagnostics locate quote failure without exporting prose or changing output',()=>{
 const d=syntaxDiagnostic(bad);assert.equal(d.kind,'suspected_unescaped_quote');assert.equal(d.field,'seat_summary');assert.equal(d.line,3);assert.equal(d.complete_object_boundary,true)
 assert(!JSON.stringify(d).includes('审慎'));assert.equal(syntaxDiagnostic('{"seat_summary":"保持\\"审慎\\"判断"}'),null)
 assert.equal(syntaxDiagnostic('```json\n'+bad+'\n```').field,'seat_summary')
})
test('extra syntax repair is bounded and cannot bypass identical business gate or truncated output',()=>{
 assert.equal(nextCandidateRepair({...args,attempt:0}).mode,'format_only');assert(nextCandidateRepair({...args,attempt:1}));assert.equal(nextCandidateRepair({...args,attempt:2}),null)
 assert.equal(nextCandidateRepair({...args,attempt:1,value:{direction:999}}),null)
 assert.equal(nextCandidateRepair({...args,attempt:1,rawOutput:bad.trim().slice(0,-1)}),null)
 assert.equal(nextCandidateRepair({...args,attempt:1,seatRepair:false}),null)
})
