const test=require('node:test'), assert=require('node:assert/strict')
const {validateActions}=require('../src/enterprise-action-contract')
const {failureMessage}=require('../src/runtime-failure')
const make=(id,effect,readiness='ready')=>({id,...(require('../src/enterprise-action-contract').OBJECT_BOUNDARIES[id]||{}),target:'企业整体',scope:'overall',time_range:'未来12个月',action:`动作${id}`,effect,readiness,prerequisites:readiness==='conditional'?['仅对未验证需求的后续增量投入暂缓']:[],evidence_refs:['E1'],direction_relation:'优化经营条件以支持总体方向'})
const check=(actions,code=1)=>validateActions({recommendations:actions.map(a=>a.id),actions,gaps:[],evidence_refs:['E1']},new Set(['E1']),{code,time_range:'未来12个月'})
test('shorter cycles, lower prices and reduced debt do not imply overall contraction',()=>{
 assert.deepEqual(check([make(1,'decrease'),make(7,'decrease'),make(8,'decrease')]),[])
 assert.deepEqual(check([make(3,'increase')],-1),[])
})
test('program never infers direction conflicts from action ID, scope or effect',()=>{
 assert.deepEqual(check([make(4,'pause','conditional'),make(8,'decrease')]),[])
 assert.deepEqual(check([make(4,'pause')]),[])
 assert.deepEqual(check([make(9,'exit','conditional')]),[])
})
test('different action dimensions on one company are not mechanical opposites',()=>{
 assert.deepEqual(check([make(1,'increase'),make(8,'decrease')]),[])
})
test('contract errors in dialogue include the specific failed rule',()=>{
 assert.match(failureMessage({code:'ENTERPRISE_MODEL_CONTRACT_INVALID',validation_errors:['行动scope必须是overall或partial']}),/行动scope必须/)
})
