'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { main, parseOptions, HELP } = require('../src/cli')

test('CLI has one Collective Decision scenario and rejects retired commands before any execution', async () => {
  for (const command of ['batch-run', 'resume-paused-cases', 'competition-compare', 'build-submission', 'evolve', 'rollback', 'evaluate']) {
    await assert.rejects(main([command]), /Unsupported command/)
  }
  await assert.rejects(main(['run', '--fixture']), /Unsupported option/)
  await assert.rejects(main(['run', '--baseline']), /Unsupported option/)
  await assert.rejects(main(['run', '--archived-legacy']), /Unsupported option/)
  await assert.rejects(main(['run']), /requires --live/)
  assert.equal(await main(['help']), HELP)
  assert.throws(() => parseOptions(['--input', 'a', '--input', 'b'], ['input']), /Duplicate/)
})

test('CLI rejects an explicit old mode even with live opt-in', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rulora-collective-cli-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const input = path.join(root, 'case.json')
  await fs.writeFile(input, JSON.stringify({ decision_mode: 'competition_calibrated_v2' }))
  await assert.rejects(main(['run', '--input', input, '--out-dir', root, '--live']), /Only enterprise_decision_v2/)
})

test('CLI demo runs the Collective Decision enterprise contract with offline replay', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rulora-collective-cli-demo-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const result = await main(['demo', '--out-dir', root])
  assert.equal(result.protocol, '5.3.0-action-object-boundaries')
  assert.equal(result.replay_additional_model_calls, 0)
  assert.equal(result.status, 'approved')
})
