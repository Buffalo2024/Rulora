class PipelineError extends Error {
  constructor(code, message, details = null) {
    super(message)
    this.code = code
    this.details = details
  }
}

/**
 * Minimal sequential pipeline used to make model/program ownership explicit.
 * A step returns a new value; an optional program gate accepts or rejects it.
 */
class HybridPipeline {
  constructor({ id, steps = [] }) {
    if (!id) throw new Error('pipeline id is required')
    this.id = id
    this.steps = steps
  }

  async run(input, context = {}) {
    let value = structuredClone(input)
    const events = []
    for (const step of this.steps) {
      if (!step.id || !['model', 'program'].includes(step.owner) || typeof step.run !== 'function') {
        throw new PipelineError('INVALID_STEP', `invalid step: ${step.id || 'unknown'}`)
      }
      const startedAt = new Date().toISOString()
      value = await step.run(structuredClone(value), context)
      if (step.validate) {
        const verdict = await step.validate(structuredClone(value), context)
        if (verdict !== true) {
          throw new PipelineError('GATE_REJECTED', `step rejected by gate: ${step.id}`, verdict)
        }
      }
      events.push({ stepId: step.id, owner: step.owner, startedAt, completedAt: new Date().toISOString() })
    }
    return { pipelineId: this.id, output: value, events }
  }
}

module.exports = { HybridPipeline, PipelineError }
