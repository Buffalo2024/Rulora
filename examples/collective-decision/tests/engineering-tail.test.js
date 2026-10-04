const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { withFileLock } = require('../src/file-lock')
const { finalizeReportQa } = require('../src/report')

test('lock lifecycle writes ownership metadata and releases normally', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'rulora-lock-'))
  const lockPath = path.join(directory, 'node.lock')
  await withFileLock(lockPath, async () => {
    const lock = JSON.parse(await fs.readFile(lockPath, 'utf8'))
    for (const field of ['lock_id', 'owner', 'created_at', 'updated_at', 'heartbeat_at', 'expires_at']) assert.ok(lock[field])
  }, { staleMs: 1000 })
  await assert.rejects(fs.access(lockPath), error => error.code === 'ENOENT')
})

test('stale orphan lock is recovered and recorded', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'rulora-lock-'))
  const lockPath = path.join(directory, 'node.lock')
  await fs.writeFile(lockPath, JSON.stringify({ pid: 99999999, acquired_at: '2000-01-01T00:00:00.000Z' }))
  let recovery = null
  const value = await withFileLock(lockPath, async () => 'ok', {
    staleMs: 10, retries: 2, intervalMs: 1, onStaleRecovered: details => { recovery = details }
  })
  assert.equal(value, 'ok')
  assert.equal(recovery?.stale_lock_recovered, true)
})

test('expired lock owned by a live process remains protected', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'rulora-lock-'))
  const lockPath = path.join(directory, 'node.lock')
  await fs.writeFile(lockPath, JSON.stringify({ pid: process.pid, hostname: os.hostname(), acquired_at: '2000-01-01T00:00:00.000Z' }))
  await assert.rejects(
    withFileLock(lockPath, async () => null, { staleMs: 1, retries: 1, intervalMs: 1 }),
    error => error.code === 'LOCK_TIMEOUT'
  )
})

test('competition final QA treats unknown evidence as audit warning', () => {
  const report = competitionReport({ evidenceRefsValid: false })
  finalizeReportQa(report, { schemaValid: true, providerProductionReady: true })
  assert.equal(report.qa.core_decision_valid, true)
  assert.equal(report.qa.production_ready, true)
  assert.equal(report.qa.provider_production_ready, true)
  assert.deepEqual(report.qa.audit_warnings, [{ warning_type: 'UNKNOWN_EVIDENCE_REF', severity: 'audit' }])
  assert.equal(report.competition_finalization.finalization_status, 'FINALIZED_WITH_WARNING')
})

test('competition final QA still rejects illegal action and risk', () => {
  const invalidAction = competitionReport({ action: 2, frozenAction: 2 })
  finalizeReportQa(invalidAction, { schemaValid: true, providerProductionReady: true })
  assert.equal(invalidAction.qa.production_ready, false)
  assert.ok(invalidAction.qa.core_decision_errors.includes('ACTION_INVALID'))
  const invalidRisk = competitionReport({ risk: '1,10', frozenRisk: ['1', '10'] })
  finalizeReportQa(invalidRisk, { schemaValid: true, providerProductionReady: true })
  assert.equal(invalidRisk.qa.production_ready, false)
  assert.ok(invalidRisk.qa.core_decision_errors.includes('RISK_INVALID'))
})

test('competition final QA records provider production readiness as a distinct gate', () => {
  const report = competitionReport()
  finalizeReportQa(report, { schemaValid: true, providerProductionReady: false })
  assert.equal(report.qa.provider_production_ready, false)
  assert.equal(report.qa.production_ready, false)
})

function competitionReport({ action = 0, frozenAction = action, risk = '3', frozenRisk = risk ? risk.split(',') : [], evidenceRefsValid = true } = {}) {
  return {
    decision_mode: 'competition_calibrated_v2',
    submission_row: { company_id: '024', action, risk_control_advice: risk },
    competition_finalization: { decision_finalized: true, action: frozenAction, risk_control_advice: frozenRisk, warnings: [], finalization_status: 'FINALIZED' },
    debate_summary: { production_eligible: true },
    qa: {
      schema_valid: false, probabilities_valid: true, cutoff_verified: true, source_registry_verified: true,
      evidence_snapshots_verified: true, evidence_refs_valid: evidenceRefsValid, evidence_coverage_sufficient: true,
      fixture_provider: false, degraded: false, production_ready: false
    }
  }
}

test('expired prior-container lease is recovered while unexpired foreign lease is protected',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'foreign-lock-')), file=path.join(dir,'job.lock')
 const metadata={lock_id:'prior-container',pid:1,hostname:'old-container',created_at:new Date(Date.now()-3600000).toISOString(),expires_at:new Date(Date.now()-1000).toISOString()}
 await fs.writeFile(file,JSON.stringify(metadata))
 let recovered
 assert.equal(await withFileLock(file,async()=> 'resumed',{retries:2,intervalMs:1,onStaleRecovered:d=>{recovered=d}}),'resumed')
 assert.equal(recovered.prior_lock_id,'prior-container')
 await fs.writeFile(file,JSON.stringify({...metadata,expires_at:new Date(Date.now()+60000).toISOString()}))
 await assert.rejects(withFileLock(file,async()=>null,{retries:1,intervalMs:1}),{code:'LOCK_TIMEOUT'})
})
