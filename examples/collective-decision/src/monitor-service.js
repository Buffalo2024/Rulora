const fs = require('node:fs/promises')
const path = require('node:path')
const { PublicSourceCollector } = require('./source-collector')
const { isCalendarDate, readJson, safeId, sha256, writeJsonAtomic } = require('./utils')

class PublicMonitorService {
  constructor({ runtimeDirectory, collector } = {}) {
    if (!runtimeDirectory) throw new Error('monitor runtimeDirectory is required')
    this.runtimeDirectory = path.resolve(runtimeDirectory)
    this.collector = collector || new PublicSourceCollector({
      snapshotDirectory: path.join(this.runtimeDirectory, 'evidence-snapshots')
    })
  }

  async registerFromRun(run) {
    const policy = run?.monitoring_record?.watch_policy
    if (run?.monitoring_record?.mode !== 'active' || !policy) throw new Error('run does not contain an active watch policy')
    if (run?.report?.qa?.production_ready !== true) {
      throw new Error('only production-ready model runs can register active watches')
    }
    if (!Array.isArray(policy.query_templates) || policy.query_templates.length === 0) {
      throw new Error('active watch policy lacks fixed public-source query_templates')
    }
    const baselineCase = run.rulora?.frozen_analysis?.fields?.normalized_case
    if (!baselineCase) throw new Error('run lacks the frozen normalized baseline case')
    await this.importBaselineSnapshots(baselineCase)
    baselineCase.evidence_snapshot_root = this.collector.snapshotDirectory
    return this.register({
      contract_version: '1.0.0',
      watch_id: policy.watch_id,
      status: 'active',
      baseline_run_id: policy.baseline_run_id,
      company: {
        id: policy.target_company_id,
        name: run.report?.company?.name || run.rulora?.frozen_analysis?.subject?.name || run.case_id
      },
      competition_cutoff: policy.competition_cutoff,
      baseline_cutoff: policy.competition_cutoff,
      baseline_case: baselineCase,
      schedule: policy.schedule,
      watch_entities: policy.watch_entities,
      watch_topics: policy.watch_topics,
      source_ids: policy.source_ids,
      query_templates: policy.query_templates,
      known_evidence: Object.fromEntries((run.rulora?.frozen_analysis?.fields?.evidence_registry || [])
        .map(item => [item.id, item.content_sha256])),
      created_at: new Date().toISOString(),
      last_run_at: null,
      last_packet_sha256: null
    })
  }

  async importBaselineSnapshots(baselineCase) {
    const sourceRoot = path.resolve(baselineCase.evidence_snapshot_root || this.collector.snapshotDirectory)
    const targetRoot = path.resolve(this.collector.snapshotDirectory)
    await fs.mkdir(targetRoot, { recursive: true })
    for (const item of baselineCase.evidence || []) {
      if (!item.snapshot_ref) continue
      const source = path.join(sourceRoot, `${item.content_sha256}.bin`)
      const target = path.join(targetRoot, `${item.content_sha256}.bin`)
      if (source === target) continue
      const sourceBytes = await fs.readFile(source)
      if (sha256(sourceBytes) !== item.content_sha256) throw new Error(`baseline evidence snapshot hash mismatch: ${item.id}`)
      try {
        const targetBytes = await fs.readFile(target)
        if (sha256(targetBytes) !== item.content_sha256) throw new Error(`monitor snapshot collision: ${item.id}`)
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
        await fs.writeFile(target, sourceBytes)
      }
    }
  }

  async register(definition) {
    validateWatch(definition)
    const watchPath = this.watchPath(definition.watch_id)
    try {
      await fs.access(watchPath)
      throw new Error(`watch already exists: ${definition.watch_id}`)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    await writeJsonAtomic(watchPath, definition)
    return structuredClone(definition)
  }

  async run(watchId, { asOfDate = new Date().toISOString().slice(0, 10) } = {}) {
    const watchPath = this.watchPath(watchId)
    const watch = await readJson(watchPath)
    validateWatch(watch)
    if (watch.status !== 'active') throw new Error(`watch ${watch.watch_id} is ${watch.status}`)
    if (!isCalendarDate(asOfDate)) throw new Error('watch observation as_of_date must be a real calendar date')
    if (asOfDate < watch.baseline_cutoff) throw new Error('watch observation cannot be before the immutable baseline cutoff')
    if (asOfDate > new Date().toISOString().slice(0, 10)) throw new Error('watch observation cannot be in the future')
    const request = {
      contract_version: '1.0.0',
      request_id: `${watch.watch_id}-${new Date().toISOString().replace(/[:.]/g, '-')}`,
      company: watch.company,
      as_of_date: asOfDate,
      queries: watch.query_templates.map(query => ({ ...query, end_date: asOfDate }))
    }
    const packet = await this.collector.collect(request)
    const known = watch.known_evidence || {}
    const newEvidence = packet.evidence.filter(item => known[item.id] !== item.content_sha256)
    const changedEvidence = newEvidence.filter(item => known[item.id])
    const newlyPublished = newEvidence.filter(item => !known[item.id])
    for (const item of packet.evidence) known[item.id] = item.content_sha256
    const packetPath = path.join(this.runtimeDirectory, 'evidence-packets', `${safeId(request.request_id)}.json`)
    await writeJsonAtomic(packetPath, packet)
    const triggerReanalysis = newEvidence.some(item => ['A', 'B'].includes(item.evidence_grade))
    let reanalysisCasePath = null
    if (triggerReanalysis) {
      const baselineCase = structuredClone(watch.baseline_case)
      const byId = new Map((baselineCase.evidence || []).map(item => [item.id, item]))
      for (const item of packet.evidence) byId.set(item.id, item)
      const reanalysisCase = {
        ...baselineCase,
        case_id: `${baselineCase.case_id}-monitor-${asOfDate}`,
        parent_case_id: baselineCase.case_id,
        baseline_run_id: watch.baseline_run_id,
        as_of_date: asOfDate,
        competition_cutoff: asOfDate,
        evidence_snapshot_root: this.collector.snapshotDirectory,
        evidence: [...byId.values()],
        monitoring: { ...baselineCase.monitoring, mode: 'active', baseline_run_id: watch.baseline_run_id }
      }
      reanalysisCasePath = path.join(this.runtimeDirectory, 'reanalysis-cases', `${safeId(request.request_id)}.json`)
      await writeJsonAtomic(reanalysisCasePath, reanalysisCase)
    }
    const result = {
      contract_version: '1.0.0',
      watch_id: watch.watch_id,
      baseline_run_id: watch.baseline_run_id,
      packet_path: packetPath,
      packet_sha256: packet.packet_sha256,
      new_evidence_ids: newEvidence.map(item => item.id),
      newly_published_ids: newlyPublished.map(item => item.id),
      changed_content_ids: changedEvidence.map(item => item.id),
      observation_as_of_date: asOfDate,
      baseline_cutoff: watch.baseline_cutoff,
      trigger_reanalysis: triggerReanalysis,
      reanalysis_case_path: reanalysisCasePath,
      quarantined_count: packet.quarantined.length,
      source_runs: packet.source_runs,
      completed_at: new Date().toISOString()
    }
    const resultPath = path.join(this.runtimeDirectory, 'monitor-runs', `${safeId(request.request_id)}.json`)
    await writeJsonAtomic(resultPath, result)
    await writeJsonAtomic(watchPath, {
      ...watch,
      known_evidence: known,
      last_run_at: result.completed_at,
      last_packet_sha256: packet.packet_sha256,
      last_observation_date: asOfDate,
      last_result_sha256: sha256(result)
    })
    return { result, resultPath }
  }

  watchPath(watchId) {
    return path.join(this.runtimeDirectory, 'watches', `${safeId(watchId)}.json`)
  }
}

function validateWatch(watch) {
  if (!watch || watch.contract_version !== '1.0.0') throw new Error('watch contract_version must be 1.0.0')
  safeId(watch.watch_id)
  if (!watch.baseline_run_id) throw new Error('watch baseline_run_id is required')
  if (!watch.company?.id || !watch.company?.name) throw new Error('watch company is required')
  if (!isCalendarDate(watch.competition_cutoff)) throw new Error('watch competition_cutoff is required')
  if (!isCalendarDate(watch.baseline_cutoff || watch.competition_cutoff)) throw new Error('watch baseline_cutoff is required')
  if (!watch.baseline_case?.case_id || !Array.isArray(watch.baseline_case?.evidence)) throw new Error('watch frozen baseline_case is required')
  if (!Array.isArray(watch.query_templates) || watch.query_templates.length === 0) throw new Error('watch query_templates are required')
  return true
}

module.exports = { PublicMonitorService, validateWatch }
