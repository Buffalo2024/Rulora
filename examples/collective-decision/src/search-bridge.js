const http = require('node:http')
async function startSearchBridge(upstream, { port = 8080 } = {}) {
  if (!upstream) return null
  const base = new URL(upstream)
  if (!['http:', 'https:'].includes(base.protocol)) throw new Error('Invalid search upstream protocol')
  const server = http.createServer(async (req, res) => {
    const input = new URL(req.url, 'http://localhost')
    if (req.method !== 'GET' || !['/search','/config'].includes(input.pathname)) { res.writeHead(404); res.end(); return }
    try {
      const target = new URL(input.pathname, base)
      target.search = input.search
      const response = await fetch(target, { signal: AbortSignal.timeout(30000), redirect: 'error' })
      const body = await response.text()
      if (Buffer.byteLength(body) > 4 * 1024 * 1024) throw new Error('Search response exceeds budget')
      res.writeHead(response.status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(body)
    } catch { res.writeHead(502, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Search upstream unavailable' })) }
  })
  await new Promise((resolve,reject) => { server.once('error',reject); server.listen(port,'127.0.0.1',resolve) })
  server.unref()
  return server
}
module.exports = { startSearchBridge }
