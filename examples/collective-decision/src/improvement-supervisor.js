const path = require('node:path')
const { loadProvider } = require('./provider-loader')
const { ProviderSupervisor } = require('./provider-supervisor')
const { DeterministicBaselineProvider } = require('./providers/deterministic-baseline-provider')
const { improvementProposalPrompt } = require('./prompts')
const { assertSchema, loadSchemaValidators } = require('./schema-validator')
const { projectRoot } = require('./rulora-loader')
const { readJson, sha256 } = require('./utils')

async function executeImprovementSupervisor({ state, evolutionEvent, config, allowFixture = false, allowBaseline = false, mode = 'business' }) {
  if (String(mode).startsWith('competition_')) throw Object.assign(new Error('improvement model calls are disabled in Competition Mode'), { code: 'COMPETITION_IMPROVEMENT_DISABLED' })
  if (!evolutionEvent?.spawned?.slot_id) throw new Error('improvement supervisor requires a spawned challenger event')
  const root = projectRoot()
  const [agentsConfig, executionConfig, schemas] = await Promise.all([
    readJson(path.join(root, 'config', 'agents.json')),
    readJson(path.join(root, 'config', 'execution.json')),
    loadSchemaValidators(root)
  ])
  const configuredAgent = agentsConfig.roles.find(item => item.id === 'improvement_supervisor')
  if (!configuredAgent) throw new Error('improvement_supervisor role is missing')
  const agent = { ...configuredAgent, agent_id: configuredAgent.id, version: 1 }
  const targetSlotId = evolutionEvent.spawned.slot_id
  const allowedMutations = config.role_mutation_pool?.[targetSlotId] || []
  if (!allowedMutations.length) throw new Error(`no approved improvement factors for ${targetSlotId}`)
  const scorecardPayload = {
    checkpoint: evolutionEvent.checkpoint,
    evaluated_cases: evolutionEvent.evaluated_cases,
    active: (state.active || []).filter(item => item.participates_in_debate === true).map(item => ({ slot_id: item.slot_id, agent_id: item.agent_id, version: item.version, metrics: item.metrics })),
    feedback: (state.user_feedback || []).slice(-20)
  }
  const scorecardSha256 = sha256(scorecardPayload)
  const loaded = await loadProvider({ allowFixture, allowBaseline })
  const provider = new ProviderSupervisor({
    failClosed: !allowFixture && !allowBaseline,
    failureDomain: 'enterprise',
    primary: loaded.provider,
    fallback: new DeterministicBaselineProvider(),
    config: executionConfig,
    validateOutput: (operation, value) => {
      if (operation !== 'proposeImprovement') return value
      assertSchema(schemas.improvementProposal, value, 'improvement proposal')
      const errors = validateImprovementProposal(value, { targetSlotId, allowedMutations, checkpoint: evolutionEvent.checkpoint, evaluatedCases: evolutionEvent.evaluated_cases, scorecardSha256 })
      if (errors.length) throw new Error(`improvement proposal gate rejected: ${errors.join('; ')}`)
      return value
    }
  })
  const proposal = await provider.proposeImprovement({
    agent,
    targetSlotId,
    allowedMutations,
    checkpoint: evolutionEvent.checkpoint,
    evaluatedCases: evolutionEvent.evaluated_cases,
    scorecardSha256,
    prompt: improvementProposalPrompt({ agent, evolutionEvent, state, allowedMutations, scorecardSha256 })
  })
  return {
    proposal,
    diagnostics: provider.diagnostics(),
    provider_mode: loaded.mode,
    provider_production_ready: loaded.productionReady === true,
    scorecard_sha256: scorecardSha256
  }
}

function validateImprovementProposal(proposal, { targetSlotId, allowedMutations, checkpoint, evaluatedCases, scorecardSha256 }) {
  const errors = []
  if (proposal?.['执行员'] !== 'improvement_supervisor') errors.push('executor must be improvement_supervisor')
  if (proposal?.['目标席位'] !== targetSlotId) errors.push('target seat differs from the program-selected lowest-performing seat')
  if (!allowedMutations.includes(proposal?.['选择因子'])) errors.push('selected factor is outside the approved mutation pool')
  if (proposal?.['评估依据']?.checkpoint !== checkpoint) errors.push('checkpoint mismatch')
  if (proposal?.['评估依据']?.evaluated_cases !== evaluatedCases) errors.push('evaluated case count mismatch')
  if (proposal?.['评估依据']?.scorecard_sha256 !== scorecardSha256) errors.push('scorecard hash mismatch')
  return errors
}

module.exports = { executeImprovementSupervisor, validateImprovementProposal }
