const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { diagnoseCompetitionRecoveryFailure } = require('../src/competition-output-recovery')
const { persistLlmOutputTrace, replayCompetitionOutput } = require('../src/llm-output-trace')

test('LLM trace persists the complete raw model response and hashes', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'llm-trace-'))
  const raw = '{"action_candidate":0}'
  const file = await persistLlmOutputTrace({
    call_id: 'call-1', company_id: '006', stage: 'decision_direction', seat: 'industry_chain_analyst', model: 'test',
    request_hash: 'a'.repeat(64), prompt_version: 'b'.repeat(64), raw_model_response: raw,
    raw_response_sha256: 'c'.repeat(64), recovery_result: { mode: 'json' }, adapter_result: { action_candidate: 0 }, core_validation_result: { pass: true }
  }, { rootDirectory: root })
  const saved = JSON.parse(await fs.readFile(file, 'utf8'))
  assert.equal(saved.raw_model_response, raw)
  assert.equal(saved.company_id, '006')
  assert.equal(saved.core_validation_result.pass, true)
})

test('Recovery failure diagnostic records parse error, attempts, detected fields, and missing fields', () => {
  const diagnostic = diagnoseCompetitionRecoveryFailure('action_candidate = 0 extra prose', { stagePhase: 'decision_direction', operation: 'decideStage' })
  assert.equal(diagnostic.status, 'RECOVERY_FAILED')
  assert.equal(diagnostic.classification, 'TYPE_B')
  assert.ok(diagnostic.json_parse_error)
  assert.ok(diagnostic.detected_fields.includes('action_candidate'))
  assert.deepEqual(diagnostic.missing_core_fields, [])
})

test('offline replay passes through Recovery, Adapter, and Core without a model call', () => {
  const replay = replayCompetitionOutput({
    raw_model_response: '```json\n{"action_candidate":"0"}\n```',
    stage_phase: 'decision_direction', operation: 'decideStage', decision_mode: 'competition_calibrated_v2', expected_agent_id: 'industry_chain_analyst'
  })
  assert.equal(replay.status, 'REPLAY_PASS')
  assert.equal(replay.adapter_result.action_candidate, 0)
  assert.equal(replay.core_validation_result.pass, true)
})

test('offline replay failures classify semantic missing, recovery gap, and conditional ambiguity', () => {
  const typeA = replayCompetitionOutput({ raw_model_response: '仅有风险分析，未给出决策。', stage_phase: 'decision_direction', operation: 'decideStage' })
  const typeB = replayCompetitionOutput({ raw_model_response: 'action_candidate = 0 extra prose', stage_phase: 'decision_direction', operation: 'decideStage' })
  const typeC = replayCompetitionOutput({ raw_model_response: 'risk_up: [2]\nrisk_flat: [3]\nrisk_down: [1]', stage_phase: 'risk_control_advice', operation: 'reviewStage' })
  assert.equal(typeA.classification, 'TYPE_A')
  assert.equal(typeB.classification, 'TYPE_B')
  assert.equal(typeC.classification, 'TYPE_C')
})
