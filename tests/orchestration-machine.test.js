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

test('a new controller recovers a validated checkpoint and continues without replaying accepted work', async () => {
  const repository = new MemoryRepository()
  const firstController = new OrchestrationMachine({ repository, scenario })
  await firstController.createSession({ id: 'wf', sessionKey: 's' })
  await firstController.recordUserTurn('wf', { sessionKey: 's', turnId: 't1', text: 'first' })
  await firstController.submitFields('wf', { sessionKey: 's', sourceTurnId: 't1', fields: { a1: 'aa' } })

  const recoveredController = new OrchestrationMachine({ repository, scenario })
  const checkpoint = await recoveredController.recoverSession('wf', { sessionKey: 's' })
  assert.equal(checkpoint.currentBranch.id, 'b')
  assert.deepEqual(checkpoint.completedFields, ['a1'])

  await recoveredController.recordUserTurn('wf', { sessionKey: 's', turnId: 't2', text: 'second' })
  await recoveredController.submitFields('wf', { sessionKey: 's', sourceTurnId: 't2', fields: { b1: 'bb' } })
  const frozen = await recoveredController.freeze('wf', { sessionKey: 's' })
  assert.deepEqual(frozen.fields, { a1: 'aa', b1: 'bb' })
})

test('recovery rejects a checkpoint that conflicts with the scenario state', async () => {
  const repository = new MemoryRepository()
  const machine = new OrchestrationMachine({ repository, scenario })
  await machine.createSession({ id: 'wf' })
  const corrupted = await repository.get('wf')
  corrupted.branchIndex = 99
  await repository.save(corrupted)
  await assert.rejects(() => machine.recoverSession('wf'), error => error instanceof WorkflowError && error.code === 'INVALID_CHECKPOINT')
})

test('recovery rejects a checkpoint that skips required accepted work', async () => {
  const repository = new MemoryRepository()
  const machine = new OrchestrationMachine({ repository, scenario })
  await machine.createSession({ id: 'wf' })
  const corrupted = await repository.get('wf')
  corrupted.branchIndex = 1
  corrupted.progress.branchId = 'b'
  await repository.save(corrupted)
  await assert.rejects(() => machine.recoverSession('wf'), error => error instanceof WorkflowError && error.code === 'INVALID_CHECKPOINT')
})

test('scenario field ids are unique so recovered evidence cannot be reinterpreted by another branch', () => {
  const invalidScenario = structuredClone(scenario)
  invalidScenario.branches[1].fields.a1 = { schema: { type: 'string' } }
  assert.throws(
    () => new OrchestrationMachine({ repository: new MemoryRepository(), scenario: invalidScenario }),
    /duplicate field id/
  )
})
