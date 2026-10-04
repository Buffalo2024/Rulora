const test = require('node:test')
const assert = require('node:assert/strict')
const { extractTask } = require('../src/task-reception')
const { screenSearchHitsWithJev, rankSearchCandidatesWithJev } = require('../src/sources/jev-prefilter')
const { normalizeUserSourceConfig } = require('../src/user-source-config')
const { typeSafeApiKey } = require('../src/sources/jev-key')

test('reception confirms the decision question without demanding extra fields', async () => {
  const result = await extractTask('判断储能业务是否继续投入', { providerLoader: async () => ({ provider: {
    callForJson: async () => ({ question: '判断储能业务是否继续投入', matter: '储能业务继续投入', time_range: '', baseline: '' })
  } }) })
  assert.equal(result.question.question, '判断储能业务是否继续投入')
  assert.deepEqual(result.missing, [])
})

test('Jev prefilter defaults off and makes no request when disabled', async () => {
  let calls = 0
  const found = [{ title: 'Original first' }, { title: 'Original second' }]
  const result = await rankSearchCandidatesWithJev('任务', found, { apiKey: 'test-key', fetchImpl: async () => { calls++; throw new Error('unexpected request') } })
  assert.equal(calls, 0)
  assert.equal(result.preliminary.status, 'disabled')
  assert.deepEqual(result.candidates, found)
})

test('enabled prefilter without key preserves the non-Jev path', async () => {
  const found = [{ title: 'Original first' }, { title: 'Original second' }]
  const result = await rankSearchCandidatesWithJev('任务', found, { enabled: true, apiKey: '', fetchImpl: async () => { throw new Error('unexpected request') } })
  assert.equal(result.preliminary.status, 'not_configured')
  assert.deepEqual(result.candidates, found)
})

test('source configuration keeps Jev explicitly disabled unless selected', () => {
  const input = { search_backend: { type: 'searxng', enabled: true, endpoint: 'http://127.0.0.1:8080' }, websites: [] }
  assert.equal(normalizeUserSourceConfig(input).search_backend.jev_prefilter_enabled, false)
  input.search_backend.jev_prefilter_enabled = true
  assert.equal(normalizeUserSourceConfig(input).search_backend.jev_prefilter_enabled, true)
})

test('TypeSafe key can be read from a server-side secret file without executing its contents', () => {
  const key = typeSafeApiKey({ environment: { TYPESAFE_API_KEY_FILE: '/run/secrets/test.env' }, readFile: () => 'IGNORED=1\nTYPESAFE_API_KEY=test-value\n' })
  assert.equal(key, 'test-value')
  assert.equal(typeSafeApiKey({ environment: { TYPESAFE_API_KEY: 'env-value' }, readFile: () => { throw new Error('should not read') } }), 'env-value')
})

test('Jev search signal preserves every hit without filtering', async () => {
  const evidence = [{ id: 'e1', title: 'A', summary: 'one' }, { id: 'e2', title: 'B', summary: 'two' }]
  const result = await screenSearchHitsWithJev({ matter: '储能' }, evidence, { enabled: true, apiKey: 'test-key', fetchImpl: async () => ({ ok: true, json: async () => ({ model: 'jev-1', answers: { hit_0: { noul: 0.9 }, hit_1: { noul: 0.1 } } }) }) })
  assert.deepEqual(result.signals, { e1: 0.9, e2: 0.1 })
  assert.equal(evidence.length, 2)
})

test('search candidates are ranked before page fetching, with low scores retained as fallback', async () => {
  const found = [{ url: 'https://low.example/a', title: 'Low' }, { url: 'https://high.example/b', title: 'High' }]
  const ranked = await rankSearchCandidatesWithJev('储能前景', found, { enabled: true, apiKey: 'test-key', fetchImpl: async () => ({ ok: true, json: async () => ({ model: 'jev-1', answers: { hit_0: { noul: 0.1 }, hit_1: { noul: 0.9 } } }) }) })
  assert.deepEqual(ranked.candidates.map(item => item.title), ['High', 'Low'])
  assert.equal(ranked.candidates[1].jev_preliminary_relevance, 0.1)
})

test('preliminary screening covers multiple batches of search results', async () => {
  let calls = 0
  const evidence = Array.from({ length: 25 }, (_, index) => ({ id: `e${index}`, title: `Title ${index}` }))
  const result = await screenSearchHitsWithJev('储能', evidence, { enabled: true, apiKey: 'test-key', fetchImpl: async (_url, init) => {
    calls++
    const request = JSON.parse(init.body)
    return { ok: true, json: async () => ({ model: 'jev-1', answers: Object.fromEntries(Object.keys(request.questions).map(key => [key, { noul: 0.5 }])) }) }
  } })
  assert.equal(calls, 2)
  assert.equal(Object.keys(result.signals).length, 25)
})
