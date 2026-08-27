'use strict'

class OutputBoundaryError extends Error {
  constructor(stage, message, details = null) {
    super(message)
    this.name = 'OutputBoundaryError'
    this.code = 'OUTPUT_REJECTED'
    this.stage = stage
    this.details = details
  }
}

class OutputBoundary {
  constructor({ recover = value => value, adapt = value => value, validateCore, validateAudit = () => true } = {}) {
    if (typeof validateCore !== 'function') throw new TypeError('validateCore is required')
    this.recover = recover
    this.adapt = adapt
    this.validateCore = validateCore
    this.validateAudit = validateAudit
  }

  async process(raw, context = {}) {
    const recovered = await this.recover(raw, context)
    const adapted = await this.adapt(recovered, context)
    const core = await this.validateCore(adapted, context)
    if (core !== true) throw new OutputBoundaryError('core', 'Core contract rejected the output', core)
    const audit = await this.validateAudit(adapted, context)
    if (audit !== true) throw new OutputBoundaryError('audit', 'Audit contract rejected the output', audit)
    return { value: adapted, accepted: true }
  }
}

module.exports = { OutputBoundary, OutputBoundaryError }
