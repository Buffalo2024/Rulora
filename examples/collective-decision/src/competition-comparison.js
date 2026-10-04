const fs = require('node:fs/promises')
const path = require('node:path')
const { buildSubmissionSupervisorRecord } = require('./submission-supervisor')
const { readJson, sha256, writeJsonAtomic } = require('./utils')

async function buildDeterministicComparisonReport({ championPath, challengerRunPaths, outputPath, championScore = null, priorScore = null }) {
  const championPayload = await readJson(path.resolve(championPath))
  const championRows = Array.isArray(championPayload) ? championPayload : championPayload.rows
  if (!Array.isArray(championRows)) throw new Error('Champion JSON must be an array or contain rows[]')
  const challengerRuns = await Promise.all(challengerRunPaths.map(file => readJson(path.resolve(file))))
  const record = buildSubmissionSupervisorRecord({ championScore, priorScore, championRows, challengerRuns })
  record.provenance = {
    champion_sha256: sha256(championPayload),
    challenger_run_sha256: challengerRuns.map(run => ({ run_id: run.run_id, sha256: sha256(run) })),
    generated_at: new Date().toISOString()
  }
  await fs.mkdir(path.dirname(path.resolve(outputPath)), { recursive: true })
  await writeJsonAtomic(path.resolve(outputPath), record)
  return record
}

module.exports = { buildDeterministicComparisonReport }
