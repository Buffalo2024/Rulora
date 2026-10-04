const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { resolveEvidenceSnapshotRoot } = require('../src/orchestrator')

test('migrated cases use the adjacent evidence snapshot directory when the recorded absolute path is unavailable', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'rulora-portable-case-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const casePath = path.join(directory, 'case.json')
  const snapshotRoot = path.join(directory, 'evidence-snapshots')
  await fs.mkdir(snapshotRoot)
  await fs.writeFile(casePath, '{}')
  const resolved = await resolveEvidenceSnapshotRoot({
    caseData: { evidence_snapshot_root: '/missing/local/workspace/evidence-snapshots' },
    inputPath: casePath,
    root: directory
  })
  assert.equal(resolved, snapshotRoot)
})
