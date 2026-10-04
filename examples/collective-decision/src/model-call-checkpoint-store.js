const fs = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')
const { withFileLock } = require('./file-lock')
const { canonicalJson, sha256, writeJsonAtomic } = require('./utils')

class ModelCallCheckpointStore {
  constructor({ rootDirectory, enabled = true, lockTimeoutMs = 900000 } = {}) {
    if (!rootDirectory) throw new Error('model call checkpoint rootDirectory is required')
    this.rootDirectory = path.resolve(rootDirectory)
    this.enabled = enabled === true
    this.lockTimeoutMs = Number(lockTimeoutMs)
    this.events = []
    this.sessionOutputs = new Map()
  }

  async execute({ identity, validate, run, cacheable = () => true }) {
    if (typeof validate !== 'function' || typeof run !== 'function') throw new Error('checkpoint execute requires validate and run')
    const normalizedIdentity = normalizeIdentity(identity)
    const inputSha256 = sha256(canonicalJson(normalizedIdentity))
    if (!this.enabled) return runAndValidate({ run, validate })
    const recordPath = path.join(this.rootDirectory, 'completed', `${inputSha256}.json`)
    const lockPath = path.join(this.rootDirectory, 'locks', `${inputSha256}.lock`)
    await fs.mkdir(path.dirname(lockPath), { recursive: true })
    let staleLockRecovery = null
    return withFileLock(lockPath, async () => {
      let existing = await readOptionalJson(recordPath)
      let reusedBySemanticIdentity = false
      if (!existing && normalizedIdentity.operation === 'monitor') {
        existing = await this.findSemanticMonitorRecord(normalizedIdentity)
        reusedBySemanticIdentity = Boolean(existing)
      }
      if (existing) {
        if (!reusedBySemanticIdentity) verifyRecord(existing, normalizedIdentity, inputSha256)
        await validate(structuredClone(existing.output))
        const existingPath = reusedBySemanticIdentity
          ? path.join(this.rootDirectory, 'completed', `${existing.input_sha256}.json`)
          : recordPath
        this.recordEvent('reused', existing, { input_sha256: inputSha256, checkpoint_reused_by_semantic_identity: reusedBySemanticIdentity })
        this.recordSessionOutput(normalizedIdentity, existing.output, { status: 'reused', input_sha256: inputSha256, record_path: existingPath, checkpoint_reused_by_semantic_identity: reusedBySemanticIdentity, validation_loop: structuredClone(existing.validation_loop || null) })
        return {
          output: structuredClone(existing.output),
          events: [{
            stepId: 'durable_model_call_checkpoint_reuse', owner: 'program',
            startedAt: new Date().toISOString(), completedAt: new Date().toISOString(),
            checkpoint_sha256: inputSha256
          }],
          checkpoint: { status: 'reused', input_sha256: inputSha256, record_path: existingPath, checkpoint_reused_by_semantic_identity: reusedBySemanticIdentity, stale_lock_recovered: Boolean(staleLockRecovery), validation_loop: structuredClone(existing.validation_loop || null) }
        }
      }
      const startedAt = new Date().toISOString()
      await this.appendAudit(inputSha256, { status: 'started', at: startedAt, identity: normalizedIdentity })
      try {
        const result = await run()
        await validate(structuredClone(result.output))
        if (!await cacheable(result)) {
          const skipped = { status: 'skipped_degraded', at: new Date().toISOString() }
          await this.appendAudit(inputSha256, skipped)
          this.events.push({ input_sha256: inputSha256, operation: normalizedIdentity.operation, phase: normalizedIdentity.phase, agent_id: normalizedIdentity.agent?.agent_id, ...skipped })
          return { ...result, checkpoint: { status: 'skipped_degraded', input_sha256: inputSha256 } }
        }
        const record = {
          contract_version: '1.0.0',
          kind: 'immutable_validated_model_call_checkpoint',
          input_sha256: inputSha256,
          identity: normalizedIdentity,
          output: structuredClone(result.output),
          output_sha256: sha256(canonicalJson(result.output)),
          pipeline_events: structuredClone(result.events || []),
          model_provenance: structuredClone(result.output?.model_provenance || null),
          validation_loop: structuredClone(result.output?.model_provenance?.validation_loop || null),
          started_at: startedAt,
          completed_at: new Date().toISOString()
        }
        await writeJsonAtomic(recordPath, record)
        await this.appendAudit(inputSha256, { status: 'completed', at: record.completed_at, output_sha256: record.output_sha256 })
        this.recordEvent('completed', record)
        this.recordSessionOutput(normalizedIdentity, record.output, { status: 'completed', input_sha256: inputSha256, record_path: recordPath })
        return { ...result, checkpoint: { status: 'completed', input_sha256: inputSha256, record_path: recordPath, stale_lock_recovered: Boolean(staleLockRecovery), validation_loop: structuredClone(record.validation_loop) } }
      } catch (error) {
        error.model_checkpoint_identity ||= structuredClone(normalizedIdentity)
        error.model_checkpoint_input_sha256 ||= inputSha256
        error.model_checkpoint_record_path ||= recordPath
        const failure = {
          status: 'failed', at: new Date().toISOString(), code: error.code || 'MODEL_CALL_FAILED',
          message_sha256: sha256(String(error.message || error)), retriable: isRetriableFailure(error)
        }
        await this.appendAudit(inputSha256, failure)
        this.events.push({ input_sha256: inputSha256, ...failure })
        throw error
      }
    }, {
      retries: Math.max(1, Math.ceil(this.lockTimeoutMs / 100)),
      intervalMs: 100,
      staleMs: Math.max(this.lockTimeoutMs * 2, 1800000),
      onStaleRecovered: async details => {
        staleLockRecovery = details
        this.events.push({ status: 'stale_lock_recovered', input_sha256: inputSha256, ...details })
        await this.appendAudit(inputSha256, { status: 'stale_lock_recovered', at: new Date().toISOString(), ...details })
      }
    })
  }

  async findSemanticMonitorRecord(identity) {
    const completedDirectory = path.join(this.rootDirectory, 'completed')
    let names = []
    try { names = await fs.readdir(completedDirectory) } catch (error) { if (error.code !== 'ENOENT') throw error }
    const expected = semanticMonitorIdentity(identity)
    for (const name of names.filter(item => item.endsWith('.json')).sort().reverse()) {
      const record = await readOptionalJson(path.join(completedDirectory, name))
      if (record?.identity?.operation !== 'monitor') continue
      if (canonicalJson(semanticMonitorIdentity(record.identity)) === canonicalJson(expected)) return record
    }
    return null
  }

  diagnostics() {
    return {
      enabled: this.enabled,
      completed: this.events.filter(event => event.status === 'completed').length,
      reused: this.events.filter(event => event.status === 'reused').length,
      failed: this.events.filter(event => event.status === 'failed').length,
      events: structuredClone(this.events)
    }
  }

  caseSnapshot() {
    const records = [...this.sessionOutputs.values()].map(item => structuredClone(item))
    const initial = records.filter(item => item.identity.operation === 'decideStage' && item.identity.phase === 'competition_joint_decision')
    const revisions = records.filter(item => item.identity.operation === 'reviewStage' && item.identity.phase === 'competition_joint_decision')
    const actionInitial = records.filter(item => item.identity.operation === 'decideStage' && item.identity.phase === 'competition_action_decision')
    const actionRevisions = records.filter(item => item.identity.operation === 'reviewStage' && item.identity.phase === 'competition_action_decision')
    const riskInitial = records.filter(item => item.identity.operation === 'decideStage' && item.identity.phase === 'competition_risk_decision')
    const riskRevisions = records.filter(item => item.identity.operation === 'reviewStage' && item.identity.phase === 'competition_risk_decision')
    const reviewer = records.find(item => item.identity.operation === 'reviewCalibration') || null
    const compact = items => Object.fromEntries(items.map(item => [item.identity.agent?.agent_id || 'unknown', structuredClone(item.output)]))
    const broadcast = initial.length === 3 ? Object.fromEntries(initial.map(item => {
      const output = item.output || {}
      return [item.identity.agent?.agent_id || 'unknown', {
        seat_id: item.identity.agent?.agent_id || null,
        action_candidate: output.action_candidate ?? null,
        action_confidence: output.action_confidence ?? null,
        risk_set_candidate: structuredClone(output['风控建议'] || []),
        risk_set_confidence: output.set_confidence ?? null,
        key_support: structuredClone(output['证据'] || []),
        key_counter_evidence: structuredClone(output.counter_evidence || [])
      }]
    })) : null
    return {
      completed_nodes: records.map(item => ({
        operation: item.identity.operation,
        phase: item.identity.phase || null,
        seat_id: item.identity.agent?.agent_id || null,
        input_sha256: item.checkpoint.input_sha256,
        checkpoint_status: item.checkpoint.status,
        record_path: item.checkpoint.record_path
        ,checkpoint_reused_by_semantic_identity: item.checkpoint.checkpoint_reused_by_semantic_identity === true,
        validation_loop: structuredClone(item.checkpoint.validation_loop || null)
      })),
      stage: riskInitial.length || riskRevisions.length ? 'risk' : actionInitial.length || actionRevisions.length ? 'action' : 'joint',
      action_finalized: actionInitial.length === 3 && actionRevisions.length === 3,
      risk_completed: riskInitial.length === 3 && riskRevisions.length === 3,
      initial_results: compact(initial.length ? initial : actionInitial),
      broadcast_results: broadcast,
      revision_results: compact(revisions.length ? revisions : actionRevisions),
      action_initial_results: compact(actionInitial),
      action_revision_results: compact(actionRevisions),
      risk_initial_results: compact(riskInitial),
      risk_revision_results: compact(riskRevisions),
      program_intermediate_state: {
        initial_complete: initial.length === 3 || actionInitial.length === 3 && riskInitial.length === 3,
        revisions_complete: revisions.length === 3 || actionRevisions.length === 3 && riskRevisions.length === 3,
        action_finalized: actionInitial.length === 3 && actionRevisions.length === 3,
        risk_completed: riskInitial.length === 3 && riskRevisions.length === 3,
        deterministic_recompute_on_resume: true
      },
      reviewer_state: reviewer ? structuredClone(reviewer.output) : null
    }
  }

  recordEvent(status, record, extra = {}) {
    this.events.push({
      status,
      input_sha256: record.input_sha256,
      output_sha256: record.output_sha256 || null,
      operation: record.identity?.operation || null,
      phase: record.identity?.phase || null,
      agent_id: record.identity?.agent?.agent_id || null,
      at: new Date().toISOString(),
      ...extra
    })
  }

  recordSessionOutput(identity, output, checkpoint) {
    const key = [identity.operation, identity.phase || '', identity.agent?.agent_id || ''].join('|')
    this.sessionOutputs.set(key, { identity: structuredClone(identity), output: structuredClone(output), checkpoint: structuredClone(checkpoint) })
  }

  async appendAudit(inputSha256, event) {
    const directory = path.join(this.rootDirectory, 'audit', inputSha256)
    await fs.mkdir(directory, { recursive: true })
    const file = path.join(directory, `${Date.now()}-${process.pid}-${crypto.randomUUID()}.json`)
    await writeJsonAtomic(file, { contract_version: '1.0.0', input_sha256: inputSha256, ...event })
  }
}

function isRetriableFailure(error) {
  for (let current = error; current; current = current.cause) {
    if (current.retryable === true && current.is_model_transport_failure === true) return true
    if ([502, 503, 504].includes(Number(current.http_status))) return true
    if (['MODEL_API_TIMEOUT', 'MODEL_API_NETWORK_FAILURE', 'ECONNRESET', 'ETIMEDOUT'].includes(current.code)) return true
    if (/timeout|connection reset|temporary upstream unavailable|temporar|\b50[234]\b/i.test(String(current.message || ''))) return true
  }
  return false
}

function normalizeIdentity(identity) {
  if (!identity || identity.contract_version !== '1.0.0') throw new Error('checkpoint identity must use contract_version 1.0.0')
  const normalized = structuredClone(identity)
  delete normalized.api_key
  delete normalized.authorization
  return normalized
}

function semanticMonitorIdentity(identity) {
  return {
    contract_version: identity.contract_version,
    operation: identity.operation,
    phase: identity.phase,
    agent: identity.agent,
    case_id: identity.case_id,
    frozen_case_sha256: identity.frozen_case_sha256,
    monitoring_record_sha256: identity.monitoring_record_sha256
  }
}

async function runAndValidate({ run, validate }) {
  const result = await run()
  await validate(structuredClone(result.output))
  return { ...result, checkpoint: { status: 'disabled' } }
}

async function readOptionalJson(filePath) {
  try { return JSON.parse(await fs.readFile(filePath, 'utf8')) } catch (error) { if (error.code === 'ENOENT') return null; throw error }
}

function verifyRecord(record, identity, inputSha256) {
  if (record.contract_version !== '1.0.0' || record.kind !== 'immutable_validated_model_call_checkpoint') throw new Error('invalid model call checkpoint contract')
  if (record.input_sha256 !== inputSha256 || sha256(canonicalJson(record.identity)) !== inputSha256 || canonicalJson(record.identity) !== canonicalJson(identity)) throw new Error('model call checkpoint identity mismatch')
  if (sha256(canonicalJson(record.output)) !== record.output_sha256) throw new Error('model call checkpoint output hash mismatch')
}

module.exports = { ModelCallCheckpointStore }
