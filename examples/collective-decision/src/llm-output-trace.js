const fs = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')
const { canonicalJson, sha256, writeJsonAtomic } = require('./utils')
const { recoverCompetitionOutput, diagnoseCompetitionRecoveryFailure } = require('./competition-output-recovery')
const { adaptCompetitionActionOutput, adaptCompetitionReviewerOutput, adaptCompetitionRiskOutput, adaptCompetitionSeatOutput } = require('./competition-output-adapter')

async function persistLlmOutputTrace(trace, { rootDirectory = process.env.LLM_OUTPUT_TRACE_ROOT || path.join(process.cwd(), '.runtime', 'llm-output-traces') } = {}) {
  const value = {
    contract_version: '1.0.0',
    recorded_at: new Date().toISOString(),
    ...structuredClone(trace)
  }
  await fs.mkdir(rootDirectory, { recursive: true })
  const filePath = path.join(rootDirectory, `${safe(value.company_id || 'unknown')}-${safe(value.call_id || crypto.randomUUID())}.json`)
  await writeJsonAtomic(filePath, value)
  return filePath
}

function replayCompetitionOutput({ raw_model_response, stage_phase = null, operation = null, decision_mode = 'competition_calibrated_v2', expected_agent_id = null, adapter_context = null } = {}) {
  const raw = String(raw_model_response ?? '')
  let recovered
  try {
    recovered = recoverCompetitionOutput(raw, { stagePhase: stage_phase, operation })
  } catch (error) {
    return {
      status: 'REPLAY_FAILED',
      classification: error.output_recovery_diagnostic?.classification || 'TYPE_A',
      recovery_result: error.output_recovery_diagnostic || diagnoseCompetitionRecoveryFailure(raw, { stagePhase: stage_phase, operation }),
      adapter_result: null,
      core_validation_result: { pass: false, reason: 'recovery_failed' }
    }
  }
  try {
    let adapted
    if (operation === 'reviewCalibration') adapted = adaptCompetitionReviewerOutput(recovered.value, adapter_context || {})
    else if (['decideStage', 'reviewStage'].includes(operation) && ['competition_calibrated', 'competition_calibrated_v2'].includes(decision_mode)) {
      adapted = decision_mode === 'competition_calibrated_v2'
        ? stage_phase === 'decision_direction'
          ? adaptCompetitionActionOutput(recovered.value, { expectedAgentId: expected_agent_id })
          : adaptCompetitionRiskOutput(recovered.value, { expectedAgentId: expected_agent_id })
        : adaptCompetitionSeatOutput(recovered.value, { expectedAgentId: expected_agent_id })
    } else adapted = { value: recovered.value, warnings: [], normalized_response: canonicalJson(recovered.value) }
    return {
      status: 'REPLAY_PASS',
      classification: 'PASS',
      recovery_result: recovered.output_recovery,
      adapter_result: structuredClone(adapted.value),
      core_validation_result: { pass: true, warnings: [...(adapted.warnings || [])] }
    }
  } catch (error) {
    return {
      status: 'REPLAY_FAILED',
      classification: 'TYPE_B',
      recovery_result: recovered.output_recovery,
      adapter_result: null,
      core_validation_result: { pass: false, reason: String(error.message || error), code: error.code || 'ADAPTER_REJECTED' }
    }
  }
}

function traceIdentity({ messages, agent, operation, stagePhase, model, profileId, outputInstruction }) {
  const requestHash = sha256(canonicalJson({ messages, model, profile_id: profileId, operation, stage: stagePhase }))
  return {
    call_id: crypto.randomUUID(),
    company_id: findCompanyId(messages),
    stage: stagePhase || operation,
    seat: agent?.agent_id || null,
    model: String(model || ''),
    request_hash: requestHash,
    prompt_version: sha256(String(outputInstruction || '')),
    prompt_sha256: sha256(canonicalJson(messages))
  }
}

function findCompanyId(messages) {
  for (const message of messages || []) {
    const text = String(message?.content || '')
    const matches = [...text.matchAll(/"(?:company_id|case_id|id)"\s*:\s*"([^"\n]+)"/g)]
    for (const match of matches) {
      const value = String(match[1])
      const company = value.match(/(?:contest-)?(\d{3})(?:-|$)/)?.[1] || (/^\d{3}$/.test(value) ? value : null)
      if (company) return company
    }
  }
  return null
}

function safe(value) { return String(value).replace(/[^a-zA-Z0-9._-]/g, '_') }

module.exports = { persistLlmOutputTrace, replayCompetitionOutput, traceIdentity }
