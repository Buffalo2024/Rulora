const { FileRepository } = require('./file-repository')
const { sha256 } = require('./utils')

const TERMINAL = new Set(['committed', 'compliance_rejected', 'failed', 'paused_upstream', 'paused_seat_failure', 'schema_failure', 'program_failure', 'review'])
const ALLOWED_TRANSITIONS = Object.freeze({
  initialized: new Set(['analysis_running']),
  analysis_running: new Set(['evidence_ready']),
  evidence_ready: new Set(['monitoring_running']),
  monitoring_running: new Set(['debating']),
  debating: new Set(['concluding']),
  concluding: new Set(['report_running']),
  report_running: new Set(['committed'])
})

class RunLedger {
  constructor(rootDirectory) {
    this.repository = new FileRepository(rootDirectory)
  }

  async create({ runId, caseId, inputSha256 }) {
    return this.repository.create({
      id: runId,
      contract_version: '1.0.0',
      run_id: runId,
      case_id: caseId,
      input_sha256: inputSha256,
      status: 'initialized',
      events: [{ status: 'initialized', at: new Date().toISOString() }],
      failure: null
    })
  }

  async transition(runId, status, details = {}) {
    const record = await this.repository.get(runId)
    if (!record) throw new Error(`run ledger not found: ${runId}`)
    if (TERMINAL.has(record.status)) throw new Error(`run ${runId} is already terminal: ${record.status}`)
    if (!ALLOWED_TRANSITIONS[record.status]?.has(status)) {
      const error = new Error(`illegal run transition for ${runId}: ${record.status} -> ${status}`)
      error.code = 'ILLEGAL_RUN_TRANSITION'
      throw error
    }
    const event = { status, at: new Date().toISOString(), details: structuredClone(details) }
    return this.repository.save({ ...record, status, events: [...record.events, event] })
  }

  async fail(runId, error, stage = 'unknown') {
    return this.stop(runId, 'failed', error, stage)
  }

  async stop(runId, status, error, stage = 'unknown') {
    if (!TERMINAL.has(status) || status === 'committed') throw new Error(`invalid run stop status: ${status}`)
    const record = await this.repository.get(runId)
    if (!record || TERMINAL.has(record.status)) return record
    const failure = {
      stage,
      code: error.code || 'RUN_FAILED',
      retriable: isRetriable(error),
      message_sha256: sha256(error.message),
      occurred_at: new Date().toISOString()
    }
    return this.repository.save({
      ...record,
      status,
      failure,
      events: [...record.events, { status, at: failure.occurred_at, details: failure }]
    })
  }
}

function isRetriable(error) {
  return ['CAS_CONFLICT', 'ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN', 'ENOSPC'].includes(error.code) || /timeout|temporar|rate.?limit/i.test(error.message)
}

module.exports = { ALLOWED_TRANSITIONS, RunLedger, isRetriable }
