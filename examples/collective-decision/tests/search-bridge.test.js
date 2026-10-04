const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http')
const {startSearchBridge}=require('../src/search-bridge')
test('loopback search bridge forwards only read-only search/config paths',async()=>{
 const upstream=http.createServer((req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({results:[{title:'test'}],query:req.url}))})
 await new Promise(r=>upstream.listen(0,'127.0.0.1',r))
 const bridge=await startSearchBridge(`http://127.0.0.1:${upstream.address().port}`,{port:0})
 try {
  const base=`http://127.0.0.1:${bridge.address().port}`
  const response=await fetch(base+'/search?q=sample&format=json');const data=await response.json()
  assert.equal(data.results.length,1);assert.match(data.query,/q=sample/)
  assert.equal((await fetch(base+'/admin')).status,404)
  assert.equal((await fetch(base+'/search',{method:'POST'})).status,404)
 }finally{bridge.closeAllConnections();upstream.closeAllConnections();await Promise.all([new Promise(r=>bridge.close(r)),new Promise(r=>upstream.close(r))])}
})
