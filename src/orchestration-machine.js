const crypto = require('node:crypto')

class WorkflowError extends Error {
  constructor(code, message, statusCode = 400, details = null) {
    super(message)
    this.code = code
    this.statusCode = statusCode
    this.details = details
  }
}

/**
 * A program-owned state machine for an LLM-guided conversation.
 * The LLM may interpret a reply and propose fields; only this class decides
 * whether a field, branch, budget gate or final freeze is valid.
 */
class OrchestrationMachine {
  constructor({ repository, scenario, defaults = {} }) {
    if (!repository) throw new Error('repository is required')
    validateScenario(scenario)
    this.repository = repository
    this.scenario = structuredClone(scenario)
    this.defaults = { tokenLimit: finiteLimit(defaults.tokenLimit) }
  }

  async createSession({ id = createId('wf'), subject = {}, sessionKey = '', tokenLimit } = {}) {
    const now = new Date().toISOString()
    const record = {
      id,
      scenarioId: this.scenario.id,
      status: 'active',
      subject: structuredClone(subject),
      sessionKey,
      branchIndex: 0,
      fields: {},
      turns: {},
      usage: { tokenLimit: finiteLimit(tokenLimit ?? this.defaults.tokenLimit), tokensUsed: 0, blocked: false },
      progress: { branchId: this.currentBranchFor(0).id, consecutiveNoProgress: 0, correctionPending: false },
      frozen: null,
      createdAt: now,
      updatedAt: now
    }
    await this.repository.create(record)
    return this.publicState(record)
  }

  openingMessage(subject = {}) {
    const first = this.currentBranchFor(0)
    const prefix = typeof this.scenario.opening === 'function'
      ? this.scenario.opening({ subject: structuredClone(subject) })
      : String(this.scenario.opening || '')
    return { message: `${prefix}${first.openingQuestion}`.trim(), branchId: first.id, isUserTurn: false }
  }

  async getState(id, { sessionKey = '' } = {}) {
    const record = await this.requireRecord(id)
    this.assertSession(record, sessionKey)
    return this.publicState(record)
  }

  async recordUserTurn(id, { turnId, text, sessionKey = '' }) {
    const record = await this.requireRecord(id)
    this.assertSession(record, sessionKey)
    this.assertOpen(record)
    if (!turnId || !String(text || '').trim()) throw new WorkflowError('INVALID_TURN', 'turnId and text are required')
    const normalized = String(text).trim()
    const old = record.turns[turnId]
    if (old) {
      if (old.text !== normalized) throw new WorkflowError('TURN_ID_CONFLICT', 'turnId cannot be reused with different text', 409)
      return { duplicate: true }
    }
    record.turns[turnId] = { text: normalized, createdAt: new Date().toISOString() }
    await this.save(record)
    return { duplicate: false }
  }

  async recordUsage(id, { tokens = 0, operationId, sessionKey = '' }) {
    const record = await this.requireRecord(id)
    this.assertSession(record, sessionKey)
    if (!Number.isFinite(Number(tokens)) || Number(tokens) < 0) throw new WorkflowError('INVALID_USAGE', 'tokens must be non-negative')
    if (!operationId) throw new WorkflowError('INVALID_USAGE', 'operationId is required')
    record.usage.entries ||= {}
    if (!record.usage.entries[operationId]) {
      record.usage.entries[operationId] = Number(tokens)
      record.usage.tokensUsed += Number(tokens)
    }
    if (record.usage.tokenLimit && record.usage.tokensUsed >= record.usage.tokenLimit) record.usage.blocked = true
    await this.save(record)
    return publicUsage(record)
  }

  async submitFields(id, { fields, sourceTurnId, sessionKey = '' }) {
    const record = await this.requireRecord(id)
    this.assertSession(record, sessionKey)
    this.assertOpen(record)
    const branch = this.currentBranch(record)
    if (!sourceTurnId || !record.turns[sourceTurnId]) throw new WorkflowError('UNKNOWN_SOURCE_TURN', 'sourceTurnId must reference a recorded user turn')
    if (!fields || typeof fields !== 'object' || Array.isArray(fields)) throw new WorkflowError('INVALID_FIELDS', 'fields must be an object')

    const accepted = []
    const rejected = []
    for (const [fieldId, value] of Object.entries(fields)) {
      const definition = branch.fields[fieldId]
      if (!definition) {
        rejected.push({ fieldId, reason: 'NOT_IN_CURRENT_BRANCH' })
        continue
      }
      const issue = validateValue(value, definition)
      if (issue) {
        rejected.push({ fieldId, reason: issue })
        continue
      }
      record.fields[fieldId] = { value: structuredClone(value), sourceTurnId, updatedAt: new Date().toISOString() }
      accepted.push(fieldId)
    }
    const missing = branch.requiredFields.filter(fieldId => !record.fields[fieldId])
    let next = { branchCompleted: false, readyForOutput: false, nextQuestion: null }
    if (missing.length === 0) next = this.advance(record)
    else if (accepted.length > 0) this.resetProgress(record, branch.id)
    await this.save(record)
    return { accepted, rejected, missing, ...next, state: this.publicState(record) }
  }

  async recordNoProgress(id, { sourceTurnId, sessionKey = '' }) {
    const record = await this.requireRecord(id)
    this.assertSession(record, sessionKey)
    this.assertOpen(record)
    if (!sourceTurnId || !record.turns[sourceTurnId]) throw new WorkflowError('UNKNOWN_SOURCE_TURN', 'sourceTurnId must reference a recorded user turn')
    record.progress.consecutiveNoProgress += 1
    const branch = this.currentBranch(record)
    let action = 'reask'
    if (record.progress.consecutiveNoProgress === 2) {
      record.progress.correctionPending = true
      action = 'correct'
    } else if (record.progress.consecutiveNoProgress >= 3 && record.progress.correctionPending) {
      record.status = 'human_handoff'
      action = 'human_handoff'
    }
    await this.save(record)
    return { action, branchId: branch.id, nextQuestion: action === 'human_handoff' ? null : branch.openingQuestion, state: this.publicState(record) }
  }

  async freeze(id, { sessionKey = '' }) {
    const record = await this.requireRecord(id)
    this.assertSession(record, sessionKey)
    if (record.status !== 'ready_for_output') throw new WorkflowError('NOT_READY_TO_FREEZE', 'all branches must be completed before freeze', 409)
    record.status = 'frozen'
    record.frozen = {
      scenarioId: this.scenario.id,
      subject: structuredClone(record.subject),
      fields: Object.fromEntries(Object.entries(record.fields).map(([key, item]) => [key, structuredClone(item.value)])),
      evidence: Object.fromEntries(Object.entries(record.fields).map(([key, item]) => [key, item.sourceTurnId])),
      frozenAt: new Date().toISOString()
    }
    await this.save(record)
    return structuredClone(record.frozen)
  }

  reportContract() {
    return structuredClone(this.scenario.output || {})
  }

  currentBranch(record) {
    return this.currentBranchFor(record.branchIndex)
  }

  currentBranchFor(index) {
    return this.scenario.branches[index]
  }

  advance(record) {
    const completed = this.currentBranch(record)
    record.branchIndex += 1
    if (record.branchIndex >= this.scenario.branches.length) {
      record.status = 'ready_for_output'
      this.resetProgress(record, null)
      return { branchCompleted: true, readyForOutput: true, nextQuestion: null, completedBranchId: completed.id }
    }
    const nextBranch = this.currentBranch(record)
    this.resetProgress(record, nextBranch.id)
    return { branchCompleted: true, readyForOutput: false, nextQuestion: nextBranch.openingQuestion, completedBranchId: completed.id }
  }

  resetProgress(record, branchId) {
    record.progress = { branchId, consecutiveNoProgress: 0, correctionPending: false }
  }

  assertSession(record, sessionKey) {
    if (record.sessionKey && record.sessionKey !== sessionKey) throw new WorkflowError('SESSION_MISMATCH', 'session does not own this workflow', 403)
  }

  assertOpen(record) {
    if (record.status === 'human_handoff') throw new WorkflowError('HUMAN_HANDOFF_REQUIRED', 'workflow has been handed off', 409)
    if (record.usage.blocked) throw new WorkflowError('TOKEN_BUDGET_EXHAUSTED', 'workflow token budget has been reached', 409)
    if (record.status !== 'active') throw new WorkflowError('WORKFLOW_NOT_ACTIVE', `workflow is ${record.status}`, 409)
  }

  async requireRecord(id) {
    const record = await this.repository.get(id)
    if (!record) throw new WorkflowError('NOT_FOUND', 'workflow session not found', 404)
    return record
  }

  async save(record) {
    record.updatedAt = new Date().toISOString()
    await this.repository.save(record)
  }

  publicState(record) {
    const branch = record.status === 'active' ? this.currentBranch(record) : null
    return {
      id: record.id,
      status: record.status,
      currentBranch: branch ? { id: branch.id, label: branch.label, requiredFields: [...branch.requiredFields], openingQuestion: branch.openingQuestion } : null,
      usage: publicUsage(record),
      progress: { correctionRequired: record.progress.correctionPending, humanHandoff: record.status === 'human_handoff' },
      completedFields: Object.keys(record.fields),
      readyForOutput: record.status === 'ready_for_output' || record.status === 'frozen'
    }
  }
}

function validateScenario(scenario) {
  if (!scenario || typeof scenario !== 'object') throw new Error('scenario is required')
  if (!scenario.id || !Array.isArray(scenario.branches) || scenario.branches.length === 0) throw new Error('scenario must include id and non-empty branches')
  for (const branch of scenario.branches) {
    if (!branch.id || !branch.openingQuestion || !Array.isArray(branch.requiredFields) || !branch.fields) throw new Error(`invalid branch: ${branch.id || 'unknown'}`)
    for (const fieldId of branch.requiredFields) if (!branch.fields[fieldId]) throw new Error(`required field missing definition: ${fieldId}`)
  }
}

function validateValue(value, definition) {
  const schema = definition.schema || definition
  if (schema.type === 'string') {
    if (typeof value !== 'string') return 'EXPECTED_STRING'
    const content = value.trim()
    if (schema.minLength && content.length < schema.minLength) return 'TOO_SHORT'
    if (schema.maxLength && content.length > schema.maxLength) return 'TOO_LONG'
    if (schema.enum && !schema.enum.includes(content)) return 'NOT_IN_ENUM'
  }
  if (schema.type === 'boolean' && typeof value !== 'boolean') return 'EXPECTED_BOOLEAN'
  if (schema.type === 'array') {
    if (!Array.isArray(value)) return 'EXPECTED_ARRAY'
    if (schema.minItems && value.length < schema.minItems) return 'TOO_FEW_ITEMS'
    if (schema.maxItems && value.length > schema.maxItems) return 'TOO_MANY_ITEMS'
  }
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return 'EXPECTED_OBJECT'
    for (const key of schema.required || []) if (value[key] === undefined || value[key] === null || value[key] === '') return `MISSING_${key}`
  }
  return null
}

function publicUsage(record) {
  return { tokenLimit: record.usage.tokenLimit, tokensUsed: record.usage.tokensUsed, blocked: record.usage.blocked }
}

function finiteLimit(value) {
  const number = Number(value)
  return Number.isInteger(number) && number > 0 ? number : null
}

function createId(prefix) {
  return `${prefix}_${crypto.randomUUID()}`
}

module.exports = { OrchestrationMachine, WorkflowError }
