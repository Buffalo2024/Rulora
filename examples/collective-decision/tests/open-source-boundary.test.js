'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { createWebServer } = require('../src/web-server')

test('Collective Decision frozen protocol and round limits match the open configuration', () => {
  const config = require('../config/enterprise-decision.json')
  assert.equal(config.deliberation_version, require('../src/enterprise-deliberation').VERSION)
  assert.equal(config.deliberation_version, '5.3.0-action-object-boundaries')
  assert.deepEqual(config.max_exchange_rounds, { direction: 6, condition: 10 })
  for (const file of ['public-sources', 'enterprise-sources', 'enterprise-manual-sources']) {
    assert(require(`../config/${file}.json`).sources.every(source => source.production_ingest_enabled === false))
  }
})

test('display unlock is unavailable without an explicitly configured password', async t => {
  const { server } = await createWebServer({ manager: { initialize: async () => {} }, privacyPassword: '' })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  t.after(() => new Promise(resolve => server.close(resolve)))
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/privacy/unlock`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'anything' })
  })
  assert.equal(response.status, 503)
})

test('offline Collective Decision demo replays without calling successful seats again', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rulora-open-collective-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const summary = await require('../examples/enterprise-collective').runDemo(root)
  assert.equal(summary.synthetic, true)
  assert.equal(summary.replay_report_identical, true)
  assert.equal(summary.replay_additional_model_calls, 0)
  assert(summary.first_run_model_calls > 0)
})
