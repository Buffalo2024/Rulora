const test = require('node:test')
const assert = require('node:assert/strict')
const { MemoryRepository, OrchestrationMachine, WorkflowError } = require('../src')

const scenario = {
  id: 'test-scenario',
  branches: [
    {
      id: 'a',
      label: 'A',
      openingQuestion: 'A?',
      requiredFields: ['a1'],
      fields: { a1: { schema: { type: 'string', minLength: 2, maxLength: 10 } } }
    },
    {
      id: 'b',
      label: 'B',
      openingQuestion: 'B?',
      requiredFields: ['b1'],
      fields: { b1: { schema: { type: 'string', minLength: 2, maxLength: 10 } } }
    }
  ]
}

function createMachine(options = {}) {
  return new OrchestrationMachine({ repository: new MemoryRepository(), scenario, defaults: options })
}

test('program advances only after required fields are accepted', async () => {
  const machine = createMachine()
  await machine.createSession({ id: 'wf', sessionKey: 's' })
  await machine.recordUserTurn('wf', { sessionKey: 's', turnId: 't1', text: 'answer' })
  const rejected = await machine.submitFields('wf', { sessionKey: 's', sourceTurnId: 't1', fields: { a1: 'x' } })
  assert.equal(rejected.branchCompleted, false)
  assert.deepEqual(rejected.accepted, [])
  const accepted = await machine.submitFields('wf', { sessionKey: 's', sourceTurnId: 't1', fields: { a1: 'ok' } })
  assert.equal(accepted.branchCompleted, true)
  assert.equal(accepted.state.currentBranch.id, 'b')
})

test('no-progress counter resets per branch and hands off after correction fails', async () => {
  const machine = createMachine()
  await machine.createSession({ id: 'wf', sessionKey: 's' })
  for (let index = 1; index <= 3; index += 1) {
    const turnId = `t${index}`
    await machine.recordUserTurn('wf', { sessionKey: 's', turnId, text: `off topic ${index}` })
    const result = await machine.recordNoProgress('wf', { sessionKey: 's', sourceTurnId: turnId })
    assert.equal(result.action, ['reask', 'correct', 'human_handoff'][index - 1])
  }
  const state = await machine.getState('wf', { sessionKey: 's' })
  assert.equal(state.status, 'human_handoff')
})

test('completed workflow freezes fields with evidence turn ids', async () => {
  const machine = createMachine()
  await machine.createSession({ id: 'wf', sessionKey: 's' })
  await machine.recordUserTurn('wf', { sessionKey: 's', turnId: 't1', text: 'first' })
  await machine.submitFields('wf', { sessionKey: 's', sourceTurnId: 't1', fields: { a1: 'aa' } })
  await machine.recordUserTurn('wf', { sessionKey: 's', turnId: 't2', text: 'second' })
  await machine.submitFields('wf', { sessionKey: 's', sourceTurnId: 't2', fields: { b1: 'bb' } })
  const frozen = await machine.freeze('wf', { sessionKey: 's' })
  assert.deepEqual(frozen.fields, { a1: 'aa', b1: 'bb' })
  assert.deepEqual(frozen.evidence, { a1: 't1', b1: 't2' })
})

test('token gate is idempotent by operation id', async () => {
  const machine = createMachine({ tokenLimit: 100 })
  await machine.createSession({ id: 'wf' })
  await machine.recordUsage('wf', { operationId: 'call-1', tokens: 60 })
  await machine.recordUsage('wf', { operationId: 'call-1', tokens: 60 })
  const usage = await machine.recordUsage('wf', { operationId: 'call-2', tokens: 40 })
  assert.equal(usage.tokensUsed, 100)
  assert.equal(usage.blocked, true)
})
