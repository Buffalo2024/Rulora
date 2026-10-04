const test = require('node:test')
const assert = require('node:assert/strict')
const { WebJobManager } = require('../src/web-job-manager')
test('batch admissions serialize and cap occupied queue at 20, execution at 2', async () => {
 const m = new WebJobManager({ concurrency: 10, batchLimit: 99 })
 assert.equal(m.concurrency, 2); assert.equal(m.batchLimit, 20)
 m.initialize = async () => {}; m.pump = () => {}
 m.companies = Array.from({ length: 21 }, (_, i) => ({ company_id: String(i+1).padStart(3, '0') }))
 m.createJob = async ({company_id}) => { await new Promise(resolve => setImmediate(resolve)); const j={job_id:company_id,company_id,status:'queued'};m.jobs.set(company_id,j);return j }
 const input = ids => ({company_ids:ids,user_consent:true,consent_action:'start_analysis'})
 const results = await Promise.allSettled([m.createBatch(input(m.companies.slice(0,20).map(x=>x.company_id))),m.createBatch(input(['021']))])
 assert.equal(results[0].status,'fulfilled');assert.equal(results[1].status,'rejected');assert.match(results[1].reason.message,/容量上限20/);assert.equal(m.jobs.size,20)
 m.jobs.set('old',{job_id:'old',status:'failed',decision_mode:'enterprise_decision_v2',user_consent:true,consent_action:'start_analysis'})
 await assert.rejects(m.resumeJob('old'),/容量已达20/)
})
