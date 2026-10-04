const test=require('node:test'), assert=require('node:assert/strict')
const policy=require('../src/decision-policy')
test('review policy is a model instruction only; no program semantic classifier or verdict rewrite',()=>{
 assert.deepEqual(Object.keys(policy),['REVIEW_POLICY'])
 assert.match(policy.REVIEW_POLICY,/内部信息/)
})
