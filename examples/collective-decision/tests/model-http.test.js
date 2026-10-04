const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http')
const {createModelFetch,DEFAULT_MODEL_TIMEOUT_MS}=require('../src/model-http')
test('model HTTP has no shorter hidden headers/body timer and preserves the caller deadline',async()=>{
 let options,captured
 const signal=AbortSignal.timeout(1000)
 const request=createModelFetch({AgentImpl:class{constructor(v){options=v}},fetchImpl:async(url,init)=>{captured=init;return {ok:true}}})
 await request('https://example.invalid',{signal,method:'POST',body:'json'})
 assert.deepEqual(options,{headersTimeout:0,bodyTimeout:0,connect:{timeout:600000}})
 assert.equal(captured.signal,signal);assert.equal(captured.body,'json');assert.equal(DEFAULT_MODEL_TIMEOUT_MS,600000)
})
test('real model HTTP response body still obeys the overall AbortSignal deadline',async()=>{
 const server=http.createServer((req,res)=>{res.writeHead(200);res.write('{');res.on('error',()=>{})})
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
 const request=createModelFetch()
 try{
  const response=await request(`http://127.0.0.1:${server.address().port}`,{signal:AbortSignal.timeout(100)})
  await assert.rejects(response.text(),e=>['AbortError','TimeoutError'].includes(e.name))
 }finally{await request.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}
})
