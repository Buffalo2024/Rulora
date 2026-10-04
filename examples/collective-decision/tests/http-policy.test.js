const test = require('node:test')
const assert = require('node:assert/strict')
const { validatePublicUrl } = require('../src/sources/http-client')
const { validateEvidenceRegistry } = require('../src/evidence-registry')
const { GovernmentPolicyAdapter } = require('../src/sources/government-policy-adapter')
const config = require('../config/enterprise-sources.json')

test('HTTP requires explicit host opt-in and keeps public URL boundaries', () => {
  assert.throws(() => validatePublicUrl('http://www.gov.cn/a'))
  assert.equal(validatePublicUrl('http://www.gov.cn/a', false, ['gov.cn'], ['gov.cn']).protocol, 'http:')
  for (const url of ['http://gov.cn.example.com/a', 'http://example.com/a', 'http://u:p@www.gov.cn/a', 'http://127.0.0.1/a', 'file:///tmp/a']) {
    assert.throws(() => validatePublicUrl(url, false, ['gov.cn'], ['gov.cn']))
  }
  assert.throws(() => validatePublicUrl('http://127.0.0.1/a', false, null, ['127.0.0.1']))
})

test('government HTTP collection preserves URLs and registry snapshot requirements', async () => {
  const url = 'http://www.gov.cn/gongbao/content/2022/content_5710609.htm'
  const adapter = new GovernmentPolicyAdapter({ httpClient: {
    json: async () => ({ code: 200, searchVO: { catMap: { policy: { listVO: [{ id: 'test', url, title: '政策', summary: '摘要', pubtimeStr: '2022-01-01' }] } } } }),
    text: async (received, options) => {
      assert.equal(received, url)
      assert.deepEqual(options.httpAllowedHosts, ['gov.cn'])
      return { text: '<body>政策正文</body>', response: { url: 'https://www.gov.cn/final' } }
    }
  } })
  const result = await adapter.collect({ query: '政策', start_date: '2022-01-01', end_date: '2026-09-28' })
  const item = { ...result.evidence[0], snapshot_ref: 'snapshot.bin', ingestion_mode: 'validated_manual_import' }
  assert.equal(item.source_url, url)
  assert.equal(item.retrieved_url, 'https://www.gov.cn/final')
  const check = (e, c = config) => validateEvidenceRegistry([e], { sourceConfig: c, productionMode: true }).filter(x => !x.startsWith('at least '))
  assert.deepEqual(check(item), [])
  const strict = structuredClone(config)
  delete strict.sources.find(s => s.id === 'government_policy').http_allowed_hosts
  assert(check(item, strict).some(x => x.includes('URL')))
  assert(check({ ...item, source_url: 'http://gov.cn.example.com/a' }).some(x => x.includes('URL')))
  assert(check({ ...item, content_sha256: '' }).some(x => x.includes('hash')))
  assert(check({ ...item, snapshot_ref: '' }).some(x => x.includes('snapshot')))
})
