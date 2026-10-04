'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { fakeProvider } = require('./fixtures/enterprise-provider')
const { runEnterpriseDecision, validateCandidate } = require('../src/enterprise-decision')
const { ModelCallCheckpointStore } = require('../src/model-call-checkpoint-store')
const { canonicalJson, sha256 } = require('../src/utils')
const sampleRoot = path.join(__dirname, 'fixtures', 'static')

async function readSample(name) {
  return JSON.parse(await fs.readFile(path.join(sampleRoot, name), 'utf8'))
}

async function verifyStaticFixtures() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rulora-static-fixtures-'))
  try {
    const input = await readSample('example-input.json')
    const expected = await readSample('example-output.json')
    const bundle = await readSample('example-snapshots.json')
    const snapshotRoot = path.join(root, 'snapshots')
    await fs.mkdir(snapshotRoot)
    for (const evidence of input.evidence) {
      const text = bundle.snapshots[evidence.snapshot_ref]
      assert.equal(typeof text, 'string')
      assert.equal(sha256(Buffer.from(text, 'utf8')), evidence.content_sha256)
      assert.equal(evidence.snapshot_ref, `${evidence.content_sha256}.bin`)
      await fs.writeFile(path.join(snapshotRoot, evidence.snapshot_ref), text)
    }
    const caseData = { ...input, evidence_snapshot_root: snapshotRoot }
    const provider = fakeProvider()
    const outputDirectory = path.join(root, 'run')
    const first = await runEnterpriseDecision({ caseData, provider, outputDirectory })
    assert.equal(first.status, expected.status)
    assert.deepEqual(first.report, expected.report)
    const firstCalls = provider.calls.length
    assert.equal(firstCalls, expected.first_run_model_calls)
    const replay = await runEnterpriseDecision({ caseData, provider, outputDirectory })
    assert.deepEqual(replay.report, expected.report)
    assert.equal(provider.calls.length - firstCalls, expected.replay_additional_model_calls)

    // A separate store proves the checked-in checkpoint is valid, not the freshly generated cache.
    const checkpoint = await readSample('example-checkpoint.json')
    assert.equal(sha256(canonicalJson(checkpoint.identity)), checkpoint.input_sha256)
    assert.equal(sha256(canonicalJson(checkpoint.output)), checkpoint.output_sha256)
    const storeRoot = path.join(root, 'sample-checkpoint')
    await fs.mkdir(path.join(storeRoot, 'completed'), { recursive: true })
    await fs.writeFile(path.join(storeRoot, 'completed', `${checkpoint.input_sha256}.json`), JSON.stringify(checkpoint))
    const store = new ModelCallCheckpointStore({ rootDirectory: storeRoot })
    const reused = await store.execute({
      identity: checkpoint.identity,
      validate: value => {
        assert.deepEqual(value, checkpoint.output)
        assert.deepEqual(validateCandidate(value, 'direction', new Set(input.evidence.map(item => item.id))), [])
        assert.ok(value.evidence_refs.every(id => input.evidence.some(item => item.id === id)))
      },
      run: () => { throw new Error('Static checkpoint must be reused without a model call') }
    })
    assert.equal(reused.checkpoint.status, 'reused')
    return { synthetic: true, status: first.status, expected_report_matches: true,
      first_run_model_calls: firstCalls, replay_additional_model_calls: provider.calls.length - firstCalls,
      checked_in_checkpoint: reused.checkpoint.status }
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
}
if (require.main === module) verifyStaticFixtures().then(value => console.log(JSON.stringify(value, null, 2))).catch(error => { console.error(error); process.exitCode = 1 })
module.exports = { readSample, verifyStaticFixtures }
