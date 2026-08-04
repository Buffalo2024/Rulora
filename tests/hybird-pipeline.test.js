const test = require('node:test')
const assert = require('node:assert/strict')
const { HybirdPipeline, PipelineError } = require('../src')

test('pipeline records explicit model/program ownership', async () => {
  const pipeline = new HybirdPipeline({
    id: 'demo',
    steps: [
      { id: 'understand', owner: 'model', run: async value => ({ n: value.n + 1 }) },
      { id: 'validate', owner: 'program', run: async value => value, validate: async value => value.n === 2 }
    ]
  })
  const result = await pipeline.run({ n: 1 })
  assert.equal(result.output.n, 2)
  assert.deepEqual(result.events.map(event => event.owner), ['model', 'program'])
})

test('program gate rejects an invalid model candidate', async () => {
  const pipeline = new HybirdPipeline({
    id: 'demo',
    steps: [
      { id: 'create', owner: 'model', run: async () => ({ text: 'too long' }) },
      { id: 'gate', owner: 'program', run: async value => value, validate: async () => ({ reason: 'overflow' }) }
    ]
  })
  await assert.rejects(
    pipeline.run({}),
    error => error instanceof PipelineError && error.code === 'GATE_REJECTED'
  )
})
