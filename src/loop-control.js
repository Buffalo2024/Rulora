'use strict'

class LoopControlError extends Error {
  constructor(code, message, details = null) {
    super(message)
    this.name = 'LoopControlError'
    this.code = code
    this.details = details
  }
}

class LoopControl {
  constructor({ kind = 'constraint_revision', maxAttempts = 3, maxNoProgress = 2 } = {}) {
    if (!['network_reconnect', 'constraint_revision', 'business_broadcast'].includes(kind)) {
      throw new TypeError('kind must be network_reconnect, constraint_revision, or business_broadcast')
    }
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1) throw new TypeError('maxAttempts must be a positive integer')
    if (!Number.isInteger(maxNoProgress) || maxNoProgress < 1) throw new TypeError('maxNoProgress must be a positive integer')
    this.kind = kind
    this.maxAttempts = maxAttempts
    this.maxNoProgress = maxNoProgress
    this.attempts = 0
    this.noProgress = 0
    this.status = 'active'
  }

  record({ progressed }) {
    if (this.status !== 'active') throw new LoopControlError('LOOP_CLOSED', 'Loop is no longer active')
    this.attempts += 1
    this.noProgress = progressed ? 0 : this.noProgress + 1
    if (this.noProgress >= this.maxNoProgress) this.status = 'human_handoff'
    else if (this.attempts >= this.maxAttempts) this.status = 'exhausted'
    return this.snapshot()
  }

  snapshot() {
    return { kind: this.kind, attempts: this.attempts, noProgress: this.noProgress, status: this.status,
      remainingAttempts: Math.max(0, this.maxAttempts - this.attempts) }
  }
}

module.exports = { LoopControl, LoopControlError }
