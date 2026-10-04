const test = require('node:test')
const assert = require('node:assert/strict')
const { WebJobManager } = require('../src/web-job-manager')
const { SearxngWebAdapter } = require('../src/sources/searxng-web-adapter')

test('enterprise collection uses verified sources and optional configured web search, never the retired nine-site list', () => {
  const manager = new WebJobManager({ root: '/private/tmp/enterprise-source-policy-test' })
  manager.builtInSources = [{ id: 'cninfo', automatic: true }, { id: 'government_policy', automatic: true }, { id: 'gdelt', automatic: false }, { id: 'web_search', automatic: false }]
  manager.userSourceConfig = { search_backend: { enabled: false }, websites: [] }
  const args = ['job', { id: 'c', name: '甲公司' }, '2026-09-24', { subject: '甲公司', matter: '人工智能投资' }]
  assert.deepEqual(manager.enterpriseCollectionRequest(...args).queries.map(item => item.source_id), ['cninfo', 'government_policy', 'cninfo', 'cninfo'])
  assert.deepEqual(manager.enterpriseCollectionRequest(...args).queries.filter(item => item.query_id.includes('cninfo-report')).map(item => item.query), ['甲公司2026年半年度报告', '甲公司2025年年度报告'])
  assert.ok(manager.enterpriseCollectionRequest(...args).queries.every(item => item.start_date === '2021-09-24' && item.end_date === '2026-09-24'))
  const decisionRequest = manager.enterpriseCollectionRequest('job', { id: 'c', name: '甲公司' }, '2026-09-24', { subject: '甲公司', question: '对该企业进行经营决策应该使用什么策略' })
  assert.equal(decisionRequest.queries.find(item => item.source_id === 'government_policy').query, '经营决策')
  assert.equal(decisionRequest.queries.find(item => item.source_id === 'government_policy').max_records, 8)
  const industryRequest = manager.enterpriseCollectionRequest('job', { id: 'c', name: '甲公司', industry: '计算机、通信和其他电子设备制造业' }, '2026-09-24', { subject: '甲公司', question: '对该企业进行经营决策应该使用什么策略' }, [], 'targeted', 1)
  assert.equal(industryRequest.queries.find(item => item.source_id === 'government_policy').query, '电子设备')
  manager.userSourceConfig.search_backend.enabled = true
  assert.deepEqual(manager.enterpriseCollectionRequest(...args).queries.map(item => item.source_id), ['cninfo', 'government_policy', 'web_search', 'cninfo', 'cninfo'])
})

test('open web search fetches original public page and carries a full snapshot', async () => {
  const seen = []
  const adapter = new SearxngWebAdapter({ searchBackend: { enabled: true, endpoint: 'http://127.0.0.1:8080' }, httpClient: {
    async json(url) { seen.push(String(url)); return { results: [{ url: 'https://example.com/article', title: '行业新闻' }] } },
    async text(url) { seen.push(String(url)); return { text: '<html><head><title>行业新闻</title><meta property="article:published_time" content="2026-09-20"></head><body><article>' + '产业发展趋势。'.repeat(30) + '</article></body></html>' } }
  } })
  const result = await adapter.collect({ query: '产业趋势', end_date: '2026-09-24', max_records: 1 })
  assert.equal(result.evidence.length, 1)
  assert.equal(result.evidence[0].source_id, 'web_search')
  assert.equal(result.evidence[0].publisher, 'example.com')
  assert.ok(result.evidence[0]._snapshot_base64)
  assert.equal(seen.length, 2)
})

test('configured search defaults on while preserving an explicit off choice', () => {
  const {normalizeUserSourceConfig}=require('../src/user-source-config')
  assert.equal(normalizeUserSourceConfig({search_backend:{endpoint:'http://127.0.0.1:8080'},websites:[]}).search_backend.enabled,true)
  assert.equal(normalizeUserSourceConfig({search_backend:{endpoint:'http://127.0.0.1:8080',enabled:false},websites:[]}).search_backend.enabled,false)
  assert.equal(normalizeUserSourceConfig({search_backend:{},websites:[]},{}).search_backend.enabled,false)
})
