const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { MultiModelProvider } = require('../src/providers/multi-model-provider')
const { ModelCallCheckpointStore } = require('../src/model-call-checkpoint-store')
const { HARD_FAIL, PAUSED_SEAT_FAILURE, REVISE_REQUIRED, classifyCompetitionValidationFailure } = require('../src/competition-validation-loop')

function response(value) {
  return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: typeof value === 'string' ? value : JSON.stringify(value) } }] }) }
}
function providerFor(outputs, traceRoot) {
  let index = 0
  const requests = []
  const provider = new MultiModelProvider({
    config: { contract_version: '1.0.0', profiles: { seat: { provider: 'openai_compatible', base_url: 'https://model.example/v1', api_key: 'secret', model: 'test-model', max_transport_retries: 0 } } },
    environment: { LLM_OUTPUT_TRACE_ROOT: traceRoot },
    fetchImpl: async (url, init) => { requests.push(JSON.parse(init.body)); return response(outputs[index++]) }
  })
  return { provider, requests }
}
const agent = { agent_id: 'adversarial_reviewer', model_profile: 'seat' }

test('Risk with five labels enters one bounded Program-feedback revision and then passes with four', async () => {
  const traceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'risk-loop-trace-'))
  try {
    const { provider, requests } = providerFor([
      { execution_agent: agent.agent_id, risk_control_advice: ['1', '2', '3', '4', '7'] },
      { execution_agent: agent.agent_id, risk_control_advice: ['1', '2', '3', '4', '7'] },
      { execution_agent: agent.agent_id, risk_control_advice: ['1', '2', '3', '4'] }
    ], traceRoot)
    const value = await provider.reviewStage({ agent, phase: 'risk_control_advice', mode: 'competition_calibrated_v2', prompt: [{ role: 'user', content: 'choose risk' }] })
    assert.deepEqual(value.risk_control_advice, ['1', '2', '3', '4'])
    assert.equal(requests.length, 3)
    assert.match(requests[1].messages.at(-1).content, /MAX_ITEMS_4/)
    assert.equal(value.model_provenance.validation_loop.attempt, 2)
    assert.equal(value.model_provenance.validation_loop.history[0].status, REVISE_REQUIRED)
    assert.equal(value.model_provenance.validation_loop.history[1].status, REVISE_REQUIRED)
  } finally { await fs.rm(traceRoot, { recursive: true, force: true }) }
})

test('conditional Risk enters one revision and requires an explicit final set', async () => {
  const traceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'conditional-loop-trace-'))
  try {
    const { provider, requests } = providerFor([
      { risk_up: ['4'], risk_flat: ['3'], risk_down: ['1'] },
      { execution_agent: agent.agent_id, final_risk_control_advice: ['3'] }
    ], traceRoot)
    const value = await provider.reviewStage({ agent, phase: 'risk_control_advice', mode: 'competition_calibrated_v2', prompt: [{ role: 'user', content: 'choose risk' }] })
    assert.deepEqual(value.risk_control_advice, ['3'])
    assert.equal(requests.length, 2)
    assert.match(requests[1].messages.at(-1).content, /FINAL_RISK_SET_REQUIRED/)
  } finally { await fs.rm(traceRoot, { recursive: true, force: true }) }
})

test('recoverable output missing Action enters the bounded seat loop', async () => {
  const classified = classifyCompetitionValidationFailure({ rawResponse: '{"reason":"analysis only"}', stagePhase: 'decision_direction', operation: 'decideStage', error: new Error('Action is missing') })
  assert.equal(classified.status, REVISE_REQUIRED)
  const traceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'action-hard-fail-trace-'))
  try {
    const { provider, requests } = providerFor([{ reason: 'analysis only' }, { reason: 'still missing' }, { execution_agent: agent.agent_id, action_candidate: 0 }], traceRoot)
    const value = await provider.decideStage({ agent, phase: 'decision_direction', mode: 'competition_calibrated_v2', prompt: [{ role: 'user', content: 'choose action' }] })
    assert.equal(value.action_candidate, 0)
    assert.equal(requests.length, 3)
  } finally { await fs.rm(traceRoot, { recursive: true, force: true }) }
})

test('unrecoverable Action output receives bounded seat revision before pause', async () => {
  const classified = classifyCompetitionValidationFailure({ rawResponse: 'hello world', stagePhase: 'decision_direction', operation: 'decideStage', error: new Error('no object') })
  assert.equal(classified.status, REVISE_REQUIRED)
  const traceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'action-unrecoverable-loop-'))
  try {
    const { provider, requests } = providerFor(['hello world', 'still no decision', { execution_agent: agent.agent_id, action_candidate: -1 }], traceRoot)
    const value = await provider.decideStage({ agent, phase: 'decision_direction', mode: 'competition_calibrated_v2', prompt: [{ role: 'user', content: 'choose action' }] })
    assert.equal(value.action_candidate, -1)
    assert.equal(requests.length, 3)
  } finally { await fs.rm(traceRoot, { recursive: true, force: true }) }
})

test('checkpoint persists validation-loop attempt and feedback hash for stage-only resume diagnostics', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'loop-checkpoint-'))
  const traceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'loop-checkpoint-trace-'))
  try {
    const { provider } = providerFor([
      { execution_agent: agent.agent_id, risk_control_advice: ['1', '2', '3', '4', '7'] },
      { execution_agent: agent.agent_id, risk_control_advice: ['1'] }
    ], traceRoot)
    const store = new ModelCallCheckpointStore({ rootDirectory: root })
    const identity = { contract_version: '1.0.0', operation: 'reviewStage', phase: 'competition_risk_decision', agent, case_id: 'case-loop', frozen_case_sha256: 'frozen', prompt_sha256: 'prompt', execution_fingerprint: 'model' }
    const result = await store.execute({
      identity,
      run: async () => ({ output: await provider.reviewStage({ agent, phase: 'risk_control_advice', mode: 'competition_calibrated_v2', prompt: [{ role: 'user', content: 'risk' }] }), events: [] }),
      validate: output => assert.deepEqual(output.risk_control_advice, ['1'])
    })
    assert.equal(result.checkpoint.validation_loop.attempt, 1)
    assert.equal(result.checkpoint.validation_loop.feedback_hashes.length, 1)
    const resumed = await new ModelCallCheckpointStore({ rootDirectory: root }).execute({ identity, run: async () => { throw new Error('must not rerun') }, validate: () => {} })
    assert.equal(resumed.checkpoint.status, 'reused')
    assert.equal(resumed.checkpoint.validation_loop.attempt, 1)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
    await fs.rm(traceRoot, { recursive: true, force: true })
  }
})

test('three invalid calls exhaust the seat loop and pause instead of degrading or hard-failing', async () => {
  const traceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'risk-loop-exhausted-'))
  try {
    const invalid = { execution_agent: agent.agent_id, risk_control_advice: ['1', '2', '3', '4', '7'] }
    const { provider, requests } = providerFor([invalid, invalid, invalid], traceRoot)
    await assert.rejects(
      () => provider.reviewStage({ agent, phase: 'risk_control_advice', mode: 'competition_calibrated_v2', prompt: [{ role: 'user', content: 'choose risk' }] }),
      error => error.code === PAUSED_SEAT_FAILURE && error.validation_result?.attempt === 2
    )
    assert.equal(requests.length, 3)
  } finally { await fs.rm(traceRoot, { recursive: true, force: true }) }
})
