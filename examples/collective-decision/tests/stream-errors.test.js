const test = require('node:test'), assert = require('node:assert/strict')
const { requestWithRetry } = require('../src/providers/multi-model-provider')
const policy = { mode: 'liveness', probe_interval_ms: 1000, probe_timeout_ms: 100, consecutive_failures: 3 }
function stream(event) { return new Response('data: '+JSON.stringify(event)+'\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}}) }
const base = {url:'https://example.invalid/v1/chat/completions',init:{},maxRetries:2,requestPolicy:policy,delayImpl:async()=>{}}
test('transient SSE errors retry inside the finite transport budget and preserve diagnostics',async()=>{
 let n=0;const response=await requestWithRetry({...base,fetchImpl:async()=>++n===1?stream({error:{status:502}}):stream({choices:[{delta:{content:'ok'}}]})})
 assert.equal(n,2);assert.equal(response.transport_diagnostics.length,2);assert.equal(response.transport_diagnostics[0].phase,'upstream_error');assert.equal(response.transport_diagnostics[0].timeout_ms,null)
})
test('authentication SSE errors do not retry',async()=>{
 let n=0;await assert.rejects(requestWithRetry({...base,fetchImpl:async()=>{n++;return stream({error:{code:'authentication_error'}})}}),e=>e.code==='MODEL_API_AUTHENTICATION_FAILED' && e.transport_diagnostics.length===1);assert.equal(n,1)
})
test('repeated SSE failures exhaust the configured budget instead of looping',async()=>{
 let n=0;await assert.rejects(requestWithRetry({...base,fetchImpl:async()=>{n++;return stream({error:{status:503}})}}),e=>e.code==='MODEL_API_UPSTREAM_FAILURE' && e.transport_diagnostics.length===3);assert.equal(n,3)
})
