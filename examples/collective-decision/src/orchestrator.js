const path = require('node:path')
const fs = require('node:fs/promises')
const { MemorySaver } = require('@langchain/langgraph')
const { validateCase, validateCreditStrategy, validateIndustryPlan, validateMonitorAssessment, validateOpinion, validateStageDecision } = require('./contracts')
const {
  CompetitionCallBudget,
  buildExactSetCandidatePool,
  buildReviewerCandidatePool,
  calibrateActionCandidate,
  finalizeCalibratedDecision,
  isCalibratedCompetition,
  normalizeMode,
  validateCalibrationReview,
  validateCompetitionModeConfig
} = require('./competition-mode')
const { buildBoundedDecisionStageGraph, buildClusterGraph } = require('./cluster-graph')
const { validateDebateConfig } = require('./debate')
const { FileRepository } = require('./file-repository')
const { verifyEvidenceSnapshots } = require('./evidence-registry')
const { aggregateOpinions, applyDebateConclusionPolicy, applyInsufficientEvidencePolicy } = require('./judge')
const { buildMonitoringRecord } = require('./monitoring')
const { ModelCallCheckpointStore } = require('./model-call-checkpoint-store')
const { PAUSED_SEAT_FAILURE } = require('./competition-validation-loop')
const { PopulationStore } = require('./population-store')
const { PublicSourceCollector, deduplicateEvidence } = require('./source-collector')
const { compactText, competitionActionPrompt, competitionCalibrationPrompt, competitionJointCalibrationPrompt, competitionRiskPrompt, industryPlanningPrompt, monitoringPrompt, selfImpactReviewPrompt, stageDecisionPrompt } = require('./prompts')
const { UserSourceConfigStore } = require('./user-source-config')
const { loadProvider } = require('./provider-loader')
const { ProviderSupervisor } = require('./provider-supervisor')
const { DeterministicBaselineProvider } = require('./providers/deterministic-baseline-provider')
const { artifactPaths, buildReport, finalizeReportQa, persistArtifacts } = require('./report')
const { RISK_CONTROL_ADVICE_DEFINITION_VERSION, describeRiskControlAdvice } = require('./risk-control-advice')
const { loadRulora, projectRoot } = require('./rulora-loader')
const { analysisScenario, deliveryScenario } = require('./scenario')
const { RunLedger } = require('./run-ledger')
const { assertSchema, loadSchemaValidators } = require('./schema-validator')
const { nowId, readJson, safeId, sha256, writeJsonAtomic } = require('./utils')
const { normalizeGdeltArticleUrl } = require('./sources/gdelt-adapter')

async function runCase({ inputPath, outputDirectory, allowFixture = false, allowBaseline = false, task = null, onProgress = null, mode = 'business', champion = null, reuseFrozenEvidence = false, evidenceChanged = false, modelCallCheckpointRoot = null, manualActionDirection = null, allowArchivedLegacy = false }) {
  if (!allowArchivedLegacy && !allowFixture && !allowBaseline) throw Object.assign(new Error('旧经营执行入口已存档；在线企业决策请使用新入口，历史重放需显式allowArchivedLegacy。'), { code: 'LEGACY_EXECUTION_DISABLED' })
  const root = projectRoot()
  const decisionMode = normalizeMode(mode)
  const calibratedCompetition = isCalibratedCompetition(decisionMode)
  const operatorTask = normalizeOperatorTask(task)
  let progressRunId = null
  const emitProgress = event => notifyProgress(onProgress, {
    case_id: event.case_id || null,
    run_id: progressRunId,
    ...event
  })
  const [inputCaseData, agentsConfig, debateConfig, decisionConfig, monitoringConfig, sourceConfig, executionConfig, competitionModeConfig] = await Promise.all([
    readJson(path.resolve(inputPath)),
    readJson(path.join(root, 'config', 'agents.json')),
    readJson(path.join(root, 'config', 'debate.json')),
    readJson(path.join(root, 'config', 'decision.json')),
    readJson(path.join(root, 'config', 'monitoring.json')),
    readJson(path.join(root, 'config', 'public-sources.json')),
    readJson(path.join(root, 'config', 'execution.json')),
    readJson(path.join(root, 'config', 'competition-mode.json'))
  ])
  const userSourceConfig = await new UserSourceConfigStore({ filePath: path.join(root, '.runtime', 'web-ui', 'user-public-sources.json') }).load()
  sourceConfig.sources = [
    ...(sourceConfig.sources || []),
    ...userSourceConfig.websites.map(source => ({
      ...source,
      production_ingest_enabled: source.enabled !== false,
      default_grade: source.default_grade || 'C'
    }))
  ]
  const competitionPolicy = validateCompetitionModeConfig(competitionModeConfig, calibratedCompetition ? decisionMode : 'competition_calibrated')
  const competitionBudget = calibratedCompetition ? new CompetitionCallBudget({
    reusedEvidence: reuseFrozenEvidence,
    limits: {
      planner: competitionPolicy.max_planner_calls_per_case,
      initial_seat: competitionPolicy.max_initial_seat_calls_per_case,
      revision: competitionPolicy.max_revision_calls_per_case,
      calibration_reviewer: competitionPolicy.max_calibration_reviewer_calls_per_case,
      improvement: competitionPolicy.max_improvement_calls_per_case,
      evidence_collection: reuseFrozenEvidence
        ? competitionPolicy.max_evidence_collection_rounds_reused_frozen
        : competitionPolicy.max_evidence_collection_rounds_first_collection
    }
  }) : null
  const productionMode = !allowFixture && !allowBaseline
  const schemas = await loadSchemaValidators(root)
  validateDebateConfig(debateConfig)
  const populationStore = new PopulationStore({
    filePath: path.join(root, '.runtime', 'population.json'),
    roles: agentsConfig.roles
  })
  const population = await populationStore.load()
  const debateAgents = population.active.filter(agent => agent.participates_in_debate === true && agent.participates_in_prediction !== false)
  const planningAgent = population.active.find(agent => agent.stage === 'industry_chain_planning')
  const monitorAgent = population.active.find(agent => agent.stage === 'information_collection_monitoring')
  const chainAgent = debateAgents.find(agent => agent.agent_id === 'industry_chain_analyst')
  const improvementSupervisor = population.active.find(agent => agent.stage === 'periodic_improvement')
  const calibrationReviewer = population.active.find(agent => agent.stage === 'competition_calibration')
  const shadowChallengers = (population.challengers || []).filter(agent => agent.status === 'shadow')
  if (!planningAgent || !chainAgent || !monitorAgent || !improvementSupervisor || !calibrationReviewer || debateAgents.length !== 3) throw new Error('agent architecture must contain one research planner, one evidence monitor, three debate seats, one calibration reviewer, and one improvement supervisor')
  const {
    provider: primaryProvider,
    source: providerSource,
    fixture,
    mode: providerMode,
    productionReady: providerProductionReady,
    executionFingerprint
  } = await loadProvider({ allowFixture, allowBaseline })
  let evidenceIds = new Set()
  let evidenceGrades = new Map()
  const provider = new ProviderSupervisor({
    primary: primaryProvider,
    fallback: new DeterministicBaselineProvider(),
    config: calibratedCompetition ? { ...executionConfig, maximum_primary_protocol_retries: 0 } : executionConfig,
    validateOutput: (operation, value, args) => {
      let errors = []
      if (operation === 'planIndustry') {
        assertSchema(schemas.industryPlan, value, 'industry plan')
        errors = validateIndustryPlan(value, args.agent)
      }
      if (['decideStage', 'reviewStage'].includes(operation)) {
        const decisionSchema = decisionMode === 'competition_calibrated_v2'
          ? args.phase === 'decision_direction' ? schemas.competitionActionDecision : schemas.competitionRiskDecision
          : calibratedCompetition ? schemas.competitionCoreDecision : schemas.stageDecision
        assertSchema(decisionSchema, value, `${operation} output`)
        if (calibratedCompetition && !schemas.competitionAuditDecision(value)) appendProtocolWarning(value, 'OPTIONAL_FIELD_INVALID')
        if (!calibratedCompetition) assertSchema(schemas.debateBroadcast, value, `${operation} broadcast`)
        errors = validateStageDecision(value, {
          agent: args.agent,
          phase: args.phase,
          evidenceIds,
          frozenDirection: args.frozenDirection,
          allowedAdviceCodes: args.allowedAdviceCodes,
          mode: decisionMode
        })
      }
      if (operation === 'reviewCalibration') {
        assertSchema(schemas.competitionCoreDecision, value, 'competition calibration core decision')
        if (!schemas.competitionCalibrationReview(value)) appendProtocolWarning(value, 'FULL_SCHEMA_MISMATCH')
        errors = validateCalibrationReview(value, { candidatePool: args.candidatePool, actionCalibration: args.actionCalibration, champion: args.champion })
      }
      if (operation === 'monitor') errors = validateMonitorAssessment(value, args.agent, evidenceIds)
      if (errors.length) throw new Error(`${operation} output gate rejected: ${errors.join('; ')}`)
      return value
    },
    failClosed: calibratedCompetition
  })
  const { core, source: ruloraSource } = loadRulora()
  const checkpointConfig = executionConfig.model_call_checkpoints || {}
  const modelCallCheckpoints = new ModelCallCheckpointStore({
    rootDirectory: path.resolve(modelCallCheckpointRoot || process.env.MODEL_CALL_CHECKPOINT_ROOT || path.join(root, checkpointConfig.root_directory || '.runtime/model-call-checkpoints')),
    enabled: productionMode && checkpointConfig.enabled_in_production === true,
    lockTimeoutMs: checkpointConfig.lock_timeout_ms || 900000
  })
  let industryPlan = inputCaseData.industry_plan
  let planningEvents = []
  if (!industryPlan) {
    if (competitionBudget) competitionBudget.consume('planner')
    const planned = await withAgentProgress({
      onProgress: emitProgress,
      agent: planningAgent,
      stage: 'public_evidence_planning_and_intake',
      phase: 'industry_chain_planning',
      operation: 'plan_industry_chain'
    }, () => planIndustryOne({
      core,
      provider,
      agent: planningAgent,
      caseData: withOperatorTask(inputCaseData, operatorTask),
      planSchema: schemas.industryPlan,
      modelCallCheckpoints,
      executionFingerprint
    }))
    industryPlan = planned.output
    planningEvents = planned.events
  } else {
    assertSchema(schemas.industryPlan, industryPlan, 'supplied industry plan')
    const suppliedPlanAgent = industryPlan['执行员'] === monitorAgent.agent_id ? monitorAgent : planningAgent
    const planErrors = validateIndustryPlan(industryPlan, suppliedPlanAgent)
    if (planErrors.length) throw new Error(`industry plan gate rejected: ${planErrors.join('; ')}`)
  }
  if (competitionBudget && inputCaseData.collection_request) competitionBudget.consume('evidence_collection')
  const { caseData, intake } = await prepareEvidenceCase({ inputCaseData: { ...inputCaseData, industry_plan: industryPlan }, root, industryPlan })
  assertSchema(schemas.case, caseData, 'company case')
  const caseErrors = validateCase(caseData, { sourceConfig, productionMode })
  if (caseErrors.length) throw new Error(`case gate rejected: ${caseErrors.join('; ')}`)
  const snapshotRoot = await resolveEvidenceSnapshotRoot({ caseData, inputPath, root })
  const snapshotErrors = await verifyEvidenceSnapshots(caseData.evidence, {
    snapshotRoot,
    productionMode
  })
  if (snapshotErrors.length) throw new Error(`evidence snapshot gate rejected: ${snapshotErrors.join('; ')}`)
  evidenceIds = new Set(caseData.evidence.map(item => item.id))
  evidenceGrades = new Map(caseData.evidence.map(item => [item.id, item.evidence_grade]))
  const modelCaseData = withOperatorTask(caseData, operatorTask)
  const runId = safeId(`${caseData.case_id}-${nowId()}`)
  progressRunId = runId
  const runLedger = new RunLedger(path.join(root, '.runtime', 'runs'))
  await runLedger.create({ runId, caseId: caseData.case_id, inputSha256: sha256(caseData) })
  await emitProgress({
    type: 'run_created',
    case_id: caseData.case_id,
    company_id: caseData.company?.company_id || null,
    company_name: caseData.company?.company_name || caseData.company?.name || null,
    stage: 'session_initialization',
    evidence_count: caseData.evidence.length
  })
  let currentStage = 'session_initialization'
  const repository = new FileRepository(path.join(root, '.runtime', 'sessions'))
  const analysisMachine = new core.OrchestrationMachine({ repository, scenario: analysisScenario })
  const analysisSessionId = `${runId}-analysis`
  try {
    await analysisMachine.createSession({ id: analysisSessionId, subject: caseData.company })
    await commitBranch(analysisMachine, analysisSessionId, 'public_evidence_planning_and_intake', {
      industry_plan: industryPlan,
      normalized_case: caseData,
      evidence_registry: caseData.evidence,
      evidence_intake: intake
    })
  } catch (error) {
    await runLedger.fail(runId, error, currentStage)
    await emitProgress({ type: 'run_failed', stage: currentStage, error_code: error.code || 'RUN_FAILED', message: error.message })
    throw error
  }

  const graph = buildClusterGraph({
    public_evidence_planning_and_intake: async context => {
      currentStage = 'public_evidence_planning_and_intake'
      await emitProgress({ type: 'stage_started', stage: currentStage, phase: 'evidence_intake' })
      await runLedger.transition(runId, 'analysis_running', { stage: currentStage })
      await runLedger.transition(runId, 'evidence_ready', { stage: currentStage, evidence_count: caseData.evidence.length })
      await emitProgress({ type: 'stage_completed', stage: currentStage, phase: 'evidence_intake', evidence_count: caseData.evidence.length })
      return { ...context, industry_plan: industryPlan, evidence_intake: intake, pipeline_events: [...context.pipeline_events, ...planningEvents] }
    },
    information_collection_monitoring: async context => {
      currentStage = 'information_collection_monitoring'
      await emitProgress({ type: 'stage_started', stage: currentStage, phase: 'public_information_monitoring' })
      await runLedger.transition(runId, 'monitoring_running', { stage: currentStage })
      const monitoringRecord = buildMonitoringRecord({
        caseData,
        monitoringConfig,
        sourceConfig,
        baselineChainOpinion: industryPlanToMonitoringChain(industryPlan),
        runId
      })
      const monitorResult = await withAgentProgress({
        onProgress: emitProgress,
        agent: monitorAgent,
        stage: currentStage,
        phase: 'public_information_monitoring',
        operation: 'monitor_public_evidence'
      }, () => monitorOne({ core, provider, agent: monitorAgent, caseData: modelCaseData, monitoringRecord, evidenceIds, modelCallCheckpoints, executionFingerprint }))
      const enrichedMonitoringRecord = { ...monitoringRecord, model_assessment: monitorResult.output }
      await commitBranch(analysisMachine, analysisSessionId, 'information_collection_monitoring', {
        monitoring_record: enrichedMonitoringRecord,
        monitor_assessment: monitorResult.output
      })
      await emitProgress({ type: 'stage_completed', stage: currentStage, phase: 'public_information_monitoring' })
      return {
        ...context,
        monitoring_record: enrichedMonitoringRecord,
        monitor_assessment: monitorResult.output,
        pipeline_events: [...context.pipeline_events, ...monitorResult.events]
      }
    },
    group_debate: async context => {
      currentStage = 'group_debate'
      await emitProgress({ type: 'stage_started', stage: currentStage, phase: 'decision_direction' })
      await runLedger.transition(runId, 'debating', { stage: currentStage })
      const debateCaseData = {
        ...modelCaseData,
        public_evidence_intake: context.evidence_intake,
        monitor_assessment: context.monitor_assessment,
        monitoring_record: context.monitoring_record
      }
      const debate = await runTwoStageDebate({
        core,
        provider,
        agents: debateAgents,
        caseData: debateCaseData,
        industryPlan: caseData.industry_plan,
        evidenceIds,
        evidenceGrades,
        config: debateConfig,
        opinionSchema: schemas.opinion,
        stageDecisionSchema: schemas.stageDecision,
        competitionStageDecisionSchema: schemas.competitionCoreDecision,
        competitionActionDecisionSchema: schemas.competitionActionDecision,
        competitionRiskDecisionSchema: schemas.competitionRiskDecision,
        calibrationReviewSchema: schemas.competitionCoreDecision,
        calibrationReviewer,
        decisionMode,
        competitionBudget,
        champion,
        modelCallCheckpoints,
        executionFingerprint,
        onProgress: emitProgress,
        manualActionDirection
      })
      const eligibleShadowChallengers = calibratedCompetition ? [] : shadowChallengers
      const shadow = await withGroupProgress({
        onProgress: emitProgress,
        agents: eligibleShadowChallengers,
        stage: currentStage,
        phase: 'shadow_validation',
        operation: 'run_shadow_challengers'
      }, () => runShadowChallengers({
        core,
        provider,
        challengers: eligibleShadowChallengers,
        reviewers: debateAgents,
        caseData: debateCaseData,
        evidenceIds,
        evidenceGrades,
        config: debateConfig,
        opinionSchema: schemas.opinion,
        stageDecisionSchema: schemas.stageDecision,
        industryPlan: caseData.industry_plan
      }))
      await commitBranch(analysisMachine, analysisSessionId, 'group_debate', {
        panel_opinions: debate.final_opinions,
        revised_opinions: debate.final_opinions,
        debate_record: debate.record,
        shadow_opinions: shadow.opinions
      })
      await emitProgress({ type: 'stage_completed', stage: currentStage, phase: 'debate_complete' })
      return {
        ...context,
        opinions: debate.final_opinions,
        revised_opinions: debate.final_opinions,
        debate_record: debate.record,
        competition_finalization: debate.competition_finalization || null,
        shadow_opinions: shadow.opinions,
        shadow_runs: shadow.runs,
        pipeline_events: [
          ...context.pipeline_events,
          ...debate.events,
          ...shadow.events
        ]
      }
    },
    conclusion_output: async context => {
      currentStage = 'conclusion_output'
      await emitProgress({ type: 'stage_started', stage: currentStage, phase: 'aggregate_and_render' })
      await runLedger.transition(runId, 'concluding', { stage: currentStage })
      const pooledConsensus = aggregateOpinions(context.revised_opinions, debateAgents, decisionConfig, evidenceGrades)
      let consensus
      if (calibratedCompetition) {
        consensus = applyCompetitionFinalization(pooledConsensus, context.competition_finalization)
      } else {
        consensus = applyDebateConclusionPolicy(
          pooledConsensus,
          context.revised_opinions,
          context.debate_record.termination,
          decisionConfig,
          debateConfig
        )
        consensus = applyTwoStageOutcome(consensus, context.debate_record.two_stage_outcome, decisionConfig)
        if (consensus.evidence_coverage < decisionConfig.minimum_evidence_coverage) consensus = applyInsufficientEvidencePolicy(consensus, decisionConfig)
      }
      const decisionStrategy = buildDeterministicCreditStrategy({
        consensus,
        caseData,
        debateTermination: context.debate_record.termination,
        evidenceIds,
        decisionMode
      })
      await commitBranch(analysisMachine, analysisSessionId, 'conclusion_output', { consensus, decision_strategy: decisionStrategy })
      const frozenAnalysis = await analysisMachine.freeze(analysisSessionId, {})
      const integrity = {
        normalized_case_sha256: sha256(caseData),
        frozen_normalized_case_sha256: sha256(frozenAnalysis.fields.normalized_case),
        evidence_ledger_sha256: sha256(caseData.evidence),
        frozen_evidence_ledger_sha256: sha256(frozenAnalysis.fields.evidence_registry),
        evidence_id_count: evidenceIds.size
      }
      if (integrity.normalized_case_sha256 !== integrity.frozen_normalized_case_sha256 || integrity.evidence_ledger_sha256 !== integrity.frozen_evidence_ledger_sha256) {
        throw new Error('information propagation integrity gate rejected: frozen case or evidence ledger changed')
      }
      const analysisHash = sha256(frozenAnalysis)
      const report = buildReport({
        runId,
        caseData,
        consensus,
        opinions: context.revised_opinions,
        critiques: [],
        debateRecord: context.debate_record,
        decisionStrategy,
        monitoringRecord: context.monitoring_record,
        ruloraSource,
        providerSource,
        fixture,
        providerMode,
        providerProductionReady,
        sourceComplianceVerified: productionMode,
        snapshotVerified: snapshotErrors.length === 0 && productionMode,
        degraded: provider.diagnostics().degraded || caseData.industry_plan_degraded === true || consensus.evidence_insufficient === true
      })
      report.decision_mode = decisionMode
      report.competition_finalization = context.competition_finalization || null
      report.risk_control_advice_details = {
        definition_version: RISK_CONTROL_ADVICE_DEFINITION_VERSION,
        source_field: 'submission_row.risk_control_advice',
        display_only: true,
        items: describeRiskControlAdvice(consensus.risk_control_advice)
      }
      report.provenance.analysis_snapshot_sha256 = analysisHash
      report.provenance.evidence_ledger_sha256 = integrity.evidence_ledger_sha256
      assertSchema(schemas.report, report, 'decision risk report candidate')
      finalizeReportQa(report, { schemaValid: true, providerProductionReady })
      assertSchema(schemas.report, report, 'decision risk report')
      const deliveryMachine = new core.OrchestrationMachine({ repository, scenario: deliveryScenario })
      const deliverySessionId = `${runId}-delivery`
      await deliveryMachine.createSession({ id: deliverySessionId, subject: caseData.company })
      await commitBranch(deliveryMachine, deliverySessionId, 'frozen_analysis', {
        analysis_snapshot: frozenAnalysis,
        analysis_sha256: analysisHash
      })
      await commitBranch(deliveryMachine, deliverySessionId, 'delivery_qa', { report })
      const frozenDelivery = await deliveryMachine.freeze(deliverySessionId, {})
      const run = {
        contract_version: '2.0.0',
        run_id: runId,
        case_id: caseData.case_id,
        operator_task: operatorTask,
        decision_mode: decisionMode,
        evidence_changed: evidenceChanged === true,
        input_sha256: sha256(caseData),
        population_generation: population.generation,
        active_agents: population.active.map(agent => ({
          agent_id: agent.agent_id,
          version: agent.version,
          method_family: agent.method_family,
          model_profile: agent.model_profile,
          stage: agent.stage,
          participates_in_prediction: agent.participates_in_prediction,
          participates_in_debate: agent.participates_in_debate,
          evolution_eligible: agent.evolution_eligible,
          weight: agent.weight,
          mutation: agent.mutation
        })),
        opinions: context.opinions,
        revised_opinions: context.revised_opinions,
        shadow_opinions: context.shadow_opinions,
        shadow_runs: context.shadow_runs,
        monitoring_record: context.monitoring_record,
        evidence_intake: context.evidence_intake,
        monitor_assessment: context.monitor_assessment,
        debate_record: context.debate_record,
        decision_strategy: decisionStrategy,
        consensus,
        competition_finalization: context.competition_finalization || null,
        report,
        pipeline_events: context.pipeline_events,
        execution_diagnostics: {
          ...provider.diagnostics(),
          normalization_applied: context.competition_finalization?.warnings?.includes('SCHEMA_NORMALIZED') ? ['competition_output_adapter'] : [],
          warnings: structuredClone(context.competition_finalization?.warnings || []),
          finalization_status: context.competition_finalization?.finalization_status || (calibratedCompetition ? 'FINALIZED' : null),
          model_call_checkpoints: modelCallCheckpoints.diagnostics()
        },
        information_integrity: integrity,
        rulora: {
          source: ruloraSource,
          analysis_session_id: analysisSessionId,
          delivery_session_id: deliverySessionId,
          frozen_analysis: frozenAnalysis,
          frozen_delivery: frozenDelivery
        },
        created_at: new Date().toISOString()
      }
      await emitProgress({
        type: 'stage_completed',
        stage: currentStage,
        phase: 'aggregate_and_render',
        action: consensus.action,
        risk_control_advice: consensus.risk_control_advice
      })
      return { ...context, consensus, report, run }
    }
  }, { checkpointer: new MemorySaver() })
  try {
    const graphResult = await graph.invoke({
      context: { pipeline_events: [], evidence_intake: intake },
      stage_events: []
    }, { configurable: { thread_id: runId } })
    const run = graphResult.context.run
    run.cluster_events = graphResult.stage_events
    run.artifacts = artifactPaths(path.resolve(outputDirectory), run.run_id)
    currentStage = 'artifact_commit'
    await emitProgress({ type: 'stage_started', stage: currentStage, phase: 'persist_artifacts' })
    await runLedger.transition(runId, 'report_running', { stage: currentStage })
    const persisted = await persistArtifacts(path.resolve(outputDirectory), run)
    await runLedger.transition(runId, 'committed', { manifest_sha256: sha256(persisted.manifest) })
    await emitProgress({
      type: 'run_completed',
      stage: 'committed',
      phase: 'complete',
      action: run.consensus.action,
      risk_control_advice: run.consensus.risk_control_advice,
      production_ready: run.report.qa.production_ready,
      artifacts: run.artifacts
    })
    return run
  } catch (error) {
    const originalCode = error.code || 'RUN_FAILED'
    const executionStatus = classifyExecutionFailure(error)
    const checkpointPath = await persistCaseExecutionCheckpoint({
      root, caseData, decisionMode, currentStage, runId, error, originalCode,
      executionStatus, modelCallCheckpoints, provider, competitionBudget
    })
    error.original_code = originalCode
    error.code = executionStatus
    error.case_checkpoint_path = checkpointPath
    await runLedger.stop(runId, executionStatus.toLowerCase(), error, currentStage)
    await emitProgress({ type: 'run_failed', stage: currentStage, error_code: executionStatus, message: error.message, checkpoint_path: checkpointPath })
    throw error
  }
}

function classifyExecutionFailure(error) {
  if (findErrorCause(error, item => item.code === PAUSED_SEAT_FAILURE)) return PAUSED_SEAT_FAILURE
  if (findErrorCause(error, item => item.code === 'ACTION_UNRESOLVED')) return 'PAUSED_ACTION_UNRESOLVED'
  if (findErrorCause(error, item => item.is_model_transport_failure === true && item.retryable === true && (
    [502, 503, 504].includes(Number(item.http_status)) ||
    ['MODEL_API_TIMEOUT', 'MODEL_API_NETWORK_FAILURE', 'ECONNRESET', 'ETIMEDOUT'].includes(item.code) ||
    /timeout|connection reset|temporary upstream unavailable|temporar/i.test(String(item.message || ''))
  ))) return 'PAUSED_UPSTREAM'
  if (findErrorCause(error, item => item.code === 'MODEL_SCHEMA_FAILURE' || /JSON Schema rejected|single-pass JSON gate rejected|stage response.*contract|checkpoint gate rejected/i.test(String(item.message || '')))) return 'SCHEMA_FAILURE'
  if (findErrorCause(error, item => ['COMPETITION_BUDGET_EXCEEDED', 'ILLEGAL_RUN_TRANSITION', 'ILLEGAL_BATCH_TRANSITION'].includes(item.code) || /program.*gate|Program Finalization/i.test(String(item.message || '')))) return 'PROGRAM_FAILURE'
  return 'REVIEW'
}

function findErrorCause(error, predicate) {
  for (let current = error; current; current = current.cause) if (predicate(current)) return current
  return null
}

async function persistCaseExecutionCheckpoint({ root, caseData, decisionMode, currentStage, runId, error, originalCode, executionStatus, modelCallCheckpoints, provider, competitionBudget }) {
  const failed = findErrorCause(error, item => item.model_checkpoint_identity) || error
  const raw = findErrorCause(error, item => typeof item.raw_model_response === 'string')
  const normalized = findErrorCause(error, item => typeof item.normalized_model_response === 'string')
  const normalization = findErrorCause(error, item => Array.isArray(item.normalization_operations))
  const validation = findErrorCause(error, item => item.validation_result)
  const snapshot = modelCallCheckpoints.caseSnapshot()
  const diagnostics = provider.diagnostics()
  const identity = failed.model_checkpoint_identity || null
  const output = {
    contract_version: '1.0.0',
    company_id: String(caseData.company?.id || caseData.company?.company_id || '').padStart(3, '0'),
    case_id: caseData.case_id,
    run_id: runId,
    mode: decisionMode,
    status: executionStatus,
    evidence_hash: sha256(caseData.evidence || []),
    evidence_changed: false,
    completed_nodes: snapshot.completed_nodes,
    current_node: identity?.phase || currentStage,
    seat_id: identity?.agent?.agent_id || null,
    call_type: identity?.operation || null,
    stage: identity?.phase || currentStage,
    seat: identity?.agent?.agent_id || null,
    attempt: validation?.validation_result?.attempt ?? null,
    validation_status: validation?.validation_result?.status || null,
    feedback_hash: validation?.validation_result?.feedback_hash || null,
    initial_results: snapshot.initial_results,
    broadcast_results: snapshot.broadcast_results,
    revision_results: snapshot.revision_results,
    program_intermediate_state: snapshot.program_intermediate_state,
    reviewer_state: snapshot.reviewer_state,
    decision_finalized: false,
    logical_call_count: diagnostics.logical_model_calls,
    transport_attempt_count: diagnostics.transport_attempts,
    transport_retry_count: diagnostics.transport_retries,
    resumed_calls: snapshot.completed_nodes.filter(item => item.checkpoint_status === 'reused').length,
    duplicate_successful_calls: 0,
    competition_budget: competitionBudget?.snapshot() || null,
    failure: {
      code: originalCode,
      cause_code: findErrorCause(error, item => item !== error && item.code)?.code || null,
      message_sha256: sha256(String(error.message || error)),
      raw_response_sha256: raw?.raw_response_sha256 || null,
      normalized_response_sha256: normalized?.normalized_response_sha256 || null
    },
    raw_model_response: raw?.raw_model_response || null,
    normalized_model_response: normalized?.normalized_model_response || null,
    normalization_operations: structuredClone(normalization?.normalization_operations || []),
    updated_at: new Date().toISOString()
  }
  const checkpointPath = path.join(root, '.runtime', 'case-resume-checkpoints', `${safeId(caseData.case_id)}.json`)
  await writeJsonAtomic(checkpointPath, output)
  return checkpointPath
}

async function createIndustryPlan({ caseData, allowFixture = false, allowBaseline = false, modelCallCheckpointRoot = null }) {
  const root = projectRoot()
  const [agentsConfig, executionConfig, schemas] = await Promise.all([
    readJson(path.join(root, 'config', 'agents.json')),
    readJson(path.join(root, 'config', 'execution.json')),
    loadSchemaValidators(root)
  ])
  const population = await new PopulationStore({
    filePath: path.join(root, '.runtime', 'population.json'),
    roles: agentsConfig.roles
  }).load()
  const planningAgent = population.active.find(agent => agent.stage === 'industry_chain_planning')
  if (!planningAgent) throw new Error('independent industry research planning agent is missing')
  const loaded = await loadProvider({ allowFixture, allowBaseline })
  const provider = new ProviderSupervisor({
    failClosed: !allowFixture && !allowBaseline,
    failureDomain: 'enterprise',
    primary: loaded.provider,
    fallback: new DeterministicBaselineProvider(),
    config: executionConfig,
    validateOutput: (operation, value, args) => {
      if (operation !== 'planIndustry') return value
      assertSchema(schemas.industryPlan, value, 'industry plan')
      const errors = validateIndustryPlan(value, args.agent)
      if (errors.length) throw new Error(`industry plan gate rejected: ${errors.join('; ')}`)
      return value
    }
  })
  const { core } = loadRulora()
  const checkpointConfig = executionConfig.model_call_checkpoints || {}
  const modelCallCheckpoints = new ModelCallCheckpointStore({
    rootDirectory: path.resolve(modelCallCheckpointRoot || process.env.MODEL_CALL_CHECKPOINT_ROOT || path.join(root, checkpointConfig.root_directory || '.runtime/model-call-checkpoints')),
    enabled: !allowFixture && !allowBaseline && checkpointConfig.enabled_in_production === true,
    lockTimeoutMs: checkpointConfig.lock_timeout_ms || 900000
  })
  const result = await planIndustryOne({ core, provider, agent: planningAgent, caseData, planSchema: schemas.industryPlan, modelCallCheckpoints, executionFingerprint: loaded.executionFingerprint })
  return {
    industry_plan: result.output,
    events: result.events,
    diagnostics: { ...provider.diagnostics(), model_call_checkpoints: modelCallCheckpoints.diagnostics() },
    provider_production_ready: loaded.productionReady === true
  }
}

async function prepareEvidenceCase({ inputCaseData, root, industryPlan }) {
  const startedAt = new Date().toISOString()
  const caseData = structuredClone(inputCaseData)
  caseData.evidence = (caseData.evidence || []).map(item => item.source_id === 'gdelt'
    ? { ...item, source_url: normalizeGdeltArticleUrl(item.source_url) }
    : item)
  let collectedPacket = null
  if (caseData.collection_request) {
    const userSourceConfig = await new UserSourceConfigStore({ filePath: path.join(root, '.runtime', 'web-ui', 'user-public-sources.json') }).load()
    const request = applyIndustryPlanToCollectionRequest({
      request: { ...structuredClone(caseData.collection_request), company: caseData.company, as_of_date: caseData.as_of_date },
      industryPlan,
      company: caseData.company,
      configuredSources: userSourceConfig.websites
    })
    const collector = new PublicSourceCollector({ snapshotDirectory: path.join(root, '.runtime', 'evidence-snapshots'), userSourceConfig })
    collectedPacket = await collector.collect(request)
    if (collectedPacket.status === 'awaiting_manual_assistance') {
      const pending = collectedPacket.manual_assistance_requests.map(item => `${item.assistance_id} (${item.source_id}) -> ${item.response_template_path}`).join('; ')
      const error = new Error(`manual public-data assistance required before analysis: ${pending}`)
      error.code = 'MANUAL_ASSISTANCE_REQUIRED'
      error.assistance_requests = collectedPacket.manual_assistance_requests
      throw error
    }
    caseData.evidence = deduplicateEvidence([...(caseData.evidence || []), ...collectedPacket.evidence])
    caseData.evidence_snapshot_root = collectedPacket.snapshot_root
  }
  caseData.industry_plan = structuredClone(industryPlan)
  return {
    caseData,
    intake: {
      contract_version: '1.0.0',
      mode: collectedPacket ? 'live_collection_plus_supplied_packet' : 'verified_supplied_packet',
      public_information_only: true,
      evidence_count: caseData.evidence?.length || 0,
      collected_packet_sha256: collectedPacket?.packet_sha256 || null,
      source_runs: collectedPacket?.source_runs || [],
      started_at: startedAt,
      completed_at: new Date().toISOString()
    }
  }
}

function applyIndustryPlanToCollectionRequest({ request, industryPlan, company, configuredSources = [] }) {
  const requirements = industryPlan?.['证据需求'] || []
  const termsByType = new Map()
  for (const requirement of requirements) {
    for (const sourceType of requirement.preferred_source_types || []) {
      const terms = termsByType.get(sourceType) || []
      terms.push(...(requirement.query_terms || []))
      termsByType.set(sourceType, [...new Set(terms)].slice(0, 8))
    }
  }
  const queries = (request.queries || []).map((query, index) => {
    const sourceType = {
      cninfo: 'company_disclosure',
      government_policy: 'government_policy',
      gdelt: 'reputable_media',
      national_statistics: 'government_statistics',
      credit_china: 'government_credit',
      tianyancha: 'enterprise_registry',
      chinaprice: 'official_market_data'
    }[query.source_id]
    const planTerms = termsByType.get(sourceType) || []
    return {
      ...query,
      query_id: query.query_id || `base:${query.source_id}:${index + 1}`,
      query_terms: [...new Set([...(query.query_terms || []), ...planTerms])].slice(0, 8),
      industry_plan_bound: true,
      query_origin: 'base_coverage'
    }
  })
  const builtInAutomaticSourcesByType = {
    company_disclosure: ['cninfo'],
    government_policy: ['government_policy'],
    reputable_media: ['gdelt']
  }
  const configuredAutomaticSourcesByType = {}
  for (const source of configuredSources.filter(item => item.enabled !== false)) {
    const current = configuredAutomaticSourcesByType[source.source_type] || []
    configuredAutomaticSourcesByType[source.source_type] = [...new Set([...current, source.id])]
  }
  const manualSourceByType = {
    government_statistics: 'national_statistics',
    government_credit: 'credit_china',
    enterprise_registry: 'tianyancha',
    official_market_data: 'chinaprice'
  }
  const dataCategoryBySource = {
    cninfo: 'enterprise_disclosure',
    government_policy: 'policy',
    gdelt: 'supply_chain_event',
    national_statistics: 'regional_economy',
    credit_china: 'penalty_dishonesty',
    tianyancha: 'enterprise_registry',
    chinaprice: 'commodity_price'
  }
  const templateBySource = new Map(queries.map(query => [query.source_id, query]))
  const plannedCounts = new Map()
  const coverageGaps = []
  for (const requirement of requirements) {
    const terms = [...new Set((requirement.query_terms || []).map(String).map(value => value.trim()).filter(Boolean))]
    const sourceTypes = [...new Set((requirement.preferred_source_types || []).map(String))]
    const builtInAutomaticSources = [...new Set(sourceTypes.flatMap(type => builtInAutomaticSourcesByType[type] || []))]
    const configuredAutomaticSources = [...new Set(sourceTypes.flatMap(type => configuredAutomaticSourcesByType[type] || []))]
    // One configured site is sufficient as the primary route when no built-in
    // adapter exists. When a built-in route exists, configured sites are only
    // supplementary and capped to avoid fan-out explosions.
    const automaticSources = builtInAutomaticSources.length
      ? [...builtInAutomaticSources, ...configuredAutomaticSources.slice(0, 2)]
      : configuredAutomaticSources.slice(0, 1)
    const manualSources = [...new Set(sourceTypes.map(type => manualSourceByType[type]).filter(Boolean))]
    // preferred_source_types are alternatives. Use registered automatic
    // adapters first; request one manual source only when no automatic route
    // can satisfy this required evidence requirement.
    const routedSources = automaticSources.length ? automaticSources : manualSources.slice(0, 1)
    if (!routedSources.length) {
      coverageGaps.push({
        requirement_id: requirement.requirement_id,
        claim_scope: requirement.claim_scope,
        required: requirement.required === true,
        preferred_source_types: sourceTypes,
        query_terms: terms,
        reason: 'no_registered_automatic_adapter_for_preferred_source_types'
      })
      continue
    }
    for (const sourceId of routedSources) {
      const count = plannedCounts.get(sourceId) || 0
      const manualSource = Object.values(manualSourceByType).includes(sourceId)
      const configuredSource = configuredSources.find(item => item.id === sourceId)
      const configuredPrimary = Boolean(configuredSource) && builtInAutomaticSources.length === 0 && sourceId === automaticSources[0]
      if (count >= (manualSource ? 1 : 2) || !terms.length) continue
      const template = templateBySource.get(sourceId) || request.queries?.[0] || {}
      const focus = terms.slice(0, 2)
      queries.push({
        source_id: sourceId,
        query_id: `plan:${requirement.requirement_id}:${sourceId}`,
        query: buildPlannedQuery(sourceId, company.name, focus),
        start_date: template.start_date,
        end_date: request.as_of_date,
        max_records: sourceId === 'gdelt' ? 5 : 4,
        fetch_documents: sourceId === 'gdelt' ? undefined : true,
        required: (manualSource || configuredPrimary) && requirement.required === true,
        min_evidence: (manualSource || configuredPrimary) && requirement.required === true ? 1 : 0,
        data_category: configuredSource?.data_category || dataCategoryBySource[sourceId],
        query_terms: terms.slice(0, 8),
        requirement_id: requirement.requirement_id,
        claim_scope: requirement.claim_scope,
        plan_requirement_required: requirement.required === true,
        industry_plan_bound: true,
        query_origin: manualSource ? 'industry_plan_manual_requirement' : configuredSource ? 'industry_plan_configured_website' : 'industry_plan_requirement'
      })
      plannedCounts.set(sourceId, count + 1)
    }
  }
  return {
    ...request,
    queries: queries.map(query => Object.fromEntries(Object.entries(query).filter(([, value]) => value !== undefined))),
    planned_coverage_gaps: coverageGaps,
    industry_plan_sha256: sha256(industryPlan)
  }
}

function buildPlannedQuery(sourceId, companyName, terms) {
  if (sourceId === 'government_policy') return terms.join(' ')
  return [companyName, ...terms].filter(Boolean).join(' ')
}

async function planIndustryOne({ core, provider, agent, caseData, planSchema, modelCallCheckpoints = null, executionFingerprint = null }) {
  const prompt = industryPlanningPrompt({ agent, caseData })
  const pipeline = new core.HybridPipeline({
    id: `industry-plan-${agent.agent_id}`,
    steps: [
      {
        id: 'model_industry_plan',
        owner: 'model',
        run: () => provider.planIndustry({ agent, caseData: structuredClone(caseData), prompt })
      },
      {
        id: 'program_industry_plan_gate',
        owner: 'program',
        run: plan => {
          if (planSchema) assertSchema(planSchema, plan, 'industry plan')
          const errors = validateIndustryPlan(plan, agent)
          if (errors.length) throw new Error(`industry plan gate rejected: ${errors.join('; ')}`)
          return plan
        }
      }
    ]
  })
  if (!modelCallCheckpoints) return pipeline.run({})
  const fallbackOffset = provider.diagnostics().fallback_events.length
  return modelCallCheckpoints.execute({
    identity: {
      contract_version: '1.0.0', output_protocol_version: '2.0.0-rigid-gates', operation: 'planIndustry', phase: 'industry_planning',
      agent: { agent_id: agent.agent_id, version: agent.version, method_family: agent.method_family, model_profile: agent.model_profile },
      case_id: caseData.case_id, frozen_case_sha256: sha256({ case_id: caseData.case_id, as_of_date: caseData.as_of_date, company: caseData.company }),
      prompt_sha256: sha256(prompt), execution_fingerprint: executionFingerprint
    },
    run: () => pipeline.run({}),
    validate: plan => {
      if (planSchema) assertSchema(planSchema, plan, 'checkpointed industry plan')
      const errors = validateIndustryPlan(plan, agent)
      if (errors.length) throw new Error(`industry plan checkpoint gate rejected: ${errors.join('; ')}`)
    },
    cacheable: () => !provider.diagnostics().fallback_events.slice(fallbackOffset).some(event => event.operation === 'planIndustry' && event.agent_id === agent.agent_id)
  })
}

function industryPlanToMonitoringChain(industryPlan) {
  return {
    chain_map: {
      nodes: (industryPlan?.['产业链']?.nodes || []).map(node => ({ id: node.id, label: node.name })),
      edges: industryPlan?.['产业链']?.edges || []
    }
  }
}

async function monitorOne({ core, provider, agent, caseData, monitoringRecord, evidenceIds, modelCallCheckpoints = null, executionFingerprint = null }) {
  const checkpointMonitoringRecord = stableMonitoringRecord(monitoringRecord)
  const prompt = monitoringPrompt({ agent, caseData, monitoringRecord: checkpointMonitoringRecord })
  const pipeline = new core.HybridPipeline({
    id: `monitor-${agent.agent_id}`,
    steps: [
      {
        id: 'model_monitor_candidate',
        owner: 'model',
        run: () => provider.monitor({
          agent,
          caseData: structuredClone(caseData),
          monitoringRecord: structuredClone(checkpointMonitoringRecord),
          prompt
        })
      },
      {
        id: 'program_non_voting_monitor_gate',
        owner: 'program',
        run: assessment => {
          const errors = validateMonitorAssessment(assessment, agent, evidenceIds)
          if (errors.length) throw new Error(`monitor assessment gate rejected: ${errors.join('; ')}`)
          return assessment
        }
      }
    ]
  })
  if (!modelCallCheckpoints) return pipeline.run({})
  const fallbackOffset = provider.diagnostics().fallback_events.length
  return modelCallCheckpoints.execute({
    identity: {
      contract_version: '1.0.0', operation: 'monitor', phase: 'information_collection_monitoring',
      agent: { agent_id: agent.agent_id, version: agent.version, method_family: agent.method_family, model_profile: agent.model_profile },
      case_id: caseData.case_id,
      frozen_case_sha256: sha256({ case_id: caseData.case_id, as_of_date: caseData.as_of_date, company: caseData.company, evidence: caseData.evidence, industry_plan: caseData.industry_plan }),
      monitoring_record_sha256: sha256(checkpointMonitoringRecord),
      prompt_sha256: sha256(prompt), execution_fingerprint: executionFingerprint
    },
    run: () => pipeline.run({}),
    validate: assessment => {
      const errors = validateMonitorAssessment(assessment, agent, evidenceIds)
      if (errors.length) throw new Error(`monitor checkpoint gate rejected: ${errors.join('; ')}`)
    },
    cacheable: () => !provider.diagnostics().fallback_events.slice(fallbackOffset).some(event => event.operation === 'monitor' && event.agent_id === agent.agent_id)
  })
}

function stableMonitoringRecord(record) {
  const value = structuredClone(record)
  delete value.run_id
  delete value.created_at
  delete value.updated_at
  if (value.watch_policy) {
    delete value.watch_policy.watch_id
    delete value.watch_policy.baseline_run_id
  }
  return value
}

async function runTwoStageDebate(args) {
  if (args.agents.length !== 3) throw new Error('two-stage debate requires exactly three fixed seats')
  const calibratedCompetition = isCalibratedCompetition(args.decisionMode || 'business')
  if (args.decisionMode === 'competition_calibrated') return runCalibratedJointDebate(args)
  const seatIds = args.agents.map(agent => agent.agent_id)
  await notifyProgress(args.onProgress, { type: 'phase_started', stage: 'group_debate', phase: 'decision_direction_initial' })
  const directionRuns = await allSettledOrThrow(args.agents.map(agent => decideStageOne({
    ...args,
    agent,
    phase: 'decision_direction',
    frozenDirection: null,
    stageDecisionSchema: calibratedCompetition ? args.competitionActionDecisionSchema : args.stageDecisionSchema
  })))
  const direction = await runDecisionStage({
    ...args,
    agents: args.agents,
    phase: 'decision_direction',
    initialDecisions: directionRuns.map(item => item.output),
    frozenDirection: null,
    stageDecisionSchema: calibratedCompetition ? args.competitionActionDecisionSchema : args.stageDecisionSchema
  })
  let actionCalibration = calibratedCompetition
    ? calibrateActionCandidate({ initialDecisions: direction.initial_decisions, finalDecisions: direction.final_decisions })
    : null
  if (calibratedCompetition && !actionCalibration?.calibrated_direction && args.manualActionDirection) {
    const selected = String(args.manualActionDirection)
    if (!['risk_up', 'risk_flat', 'risk_down'].includes(selected)) throw new Error('人工裁决的经营方向无效。')
    const actionMap = { risk_up: -1, risk_flat: 0, risk_down: 1 }
    actionCalibration = {
      ...actionCalibration,
      proposed_direction: selected,
      proposed_action: String(actionMap[selected]),
      calibrated_direction: selected,
      calibrated_action: String(actionMap[selected]),
      threshold_passed: true,
      manual_adjudication: {
        applied: true,
        direction: selected,
        action: String(actionMap[selected]),
        source: 'human_operator',
        reason: 'three_seat_action_unresolved',
        recorded_at: new Date().toISOString()
      }
    }
    await notifyProgress(args.onProgress, { type: 'manual_action_adjudicated', stage: 'group_debate', phase: 'decision_direction', result: selected, action: actionMap[selected] })
  }
  const directionOutcome = calibratedCompetition
    ? {
        value: actionCalibration.calibrated_direction,
        votes: Object.fromEntries(actionCalibration.support.candidates.map(item => [item.value, item.post_broadcast_support_count])),
        unanimous: actionCalibration.support.candidates.some(item => item.post_broadcast_support_count === 3),
        majority_available: actionCalibration.support.candidates.some(item => item.post_broadcast_support_count >= 2),
        provisional: false,
        rule: 'program_decision_threshold_calibration'
      }
    : majorityDirectionDecisions(direction.final_decisions)
  await notifyProgress(args.onProgress, {
    type: 'phase_completed',
    stage: 'group_debate',
    phase: 'decision_direction',
    unanimous: directionOutcome.unanimous,
    majority_available: directionOutcome.majority_available,
    result: directionOutcome.value
  })
  await notifyProgress(args.onProgress, {
    type: 'action_calibration_completed',
    stage: 'group_debate',
    phase: 'decision_direction',
    action: actionCalibration?.calibrated_action ?? null,
    threshold_passed: actionCalibration?.threshold_passed ?? null
  })
  if (calibratedCompetition && !actionCalibration?.calibrated_direction) {
    const error = new Error('三席经营方向未形成可冻结结论，程序已在风控措施阶段前暂停。')
    error.code = 'ACTION_UNRESOLVED'
    error.action_candidates = structuredClone(actionCalibration?.support?.candidates || [])
    throw error
  }
  await notifyProgress(args.onProgress, { type: 'phase_started', stage: 'group_debate', phase: 'risk_control_advice_initial' })
  const adviceRuns = await allSettledOrThrow(args.agents.map(agent => decideStageOne({
    ...args,
    agent,
    phase: 'risk_control_advice',
    frozenDirection: directionOutcome.value,
    stageDecisionSchema: calibratedCompetition ? args.competitionRiskDecisionSchema : args.stageDecisionSchema
  })))
  const advice = await runDecisionStage({
    ...args,
    agents: args.agents,
    phase: 'risk_control_advice',
    initialDecisions: adviceRuns.map(item => item.output),
    frozenDirection: directionOutcome.value,
    stageDecisionSchema: calibratedCompetition ? args.competitionRiskDecisionSchema : args.stageDecisionSchema
  })
  const candidatePool = calibratedCompetition
    ? buildExactSetCandidatePool({ initialDecisions: advice.initial_decisions, finalDecisions: advice.final_decisions })
    : null
  const adviceOutcome = calibratedCompetition
    ? {
        values: [...(candidatePool.candidates[0]?.value || [])],
        candidate_sets: candidatePool.candidates,
        unanimous: candidatePool.candidates.some(item => item.post_broadcast_support_count === 3),
        majority_available: candidatePool.candidates.some(item => item.post_broadcast_support_count >= 2),
        provisional: false,
        rule: 'exact_set_candidate_pool_no_label_union'
      }
    : majorityAdviceDecisions(advice.final_decisions)
  await notifyProgress(args.onProgress, {
    type: 'phase_completed',
    stage: 'group_debate',
    phase: 'risk_control_advice',
    unanimous: adviceOutcome.unanimous,
    majority_available: adviceOutcome.majority_available,
    result: adviceOutcome.values
  })
  await notifyProgress(args.onProgress, {
    type: 'risk_calibration_completed',
    stage: 'group_debate',
    phase: 'risk_control_advice',
    candidate_count: candidatePool?.candidates?.length || 0,
    preferred_candidate_set_id: candidatePool?.preferred_candidate_set_id || null
  })
  const finalOpinions = args.agents.map(agent => buildCompatibilityOpinion({
    agent,
    caseData: args.caseData,
    industryPlan: args.industryPlan || args.caseData.industry_plan,
    direction: direction.final_decisions.find(item => item['执行员'] === agent.agent_id),
    advice: advice.final_decisions.find(item => item['执行员'] === agent.agent_id)
  }))
  const opinionAuditWarnings = []
  for (const opinion of finalOpinions) {
    const agent = args.agents.find(item => item.agent_id === opinion.agent_id)
    if (calibratedCompetition) opinionAuditWarnings.push(...gateCompetitionOpinion(opinion, agent, args.evidenceIds, args.opinionSchema))
    else gateOpinion(opinion, agent, args.evidenceIds, args.opinionSchema)
  }
  if (calibratedCompetition) opinionAuditWarnings.push(...auditPrimaryEvidence(finalOpinions, args.evidenceGrades))
  else gatePrimaryEvidence(finalOpinions, args.evidenceGrades)
  let competitionFinalization = null
  let calibrationEvents = []
  if (calibratedCompetition) {
    const review = await runCalibrationReviewer({
      ...args,
      stageDecisionSchema: args.competitionRiskDecisionSchema,
      direction,
      advice,
      actionCalibration,
      candidatePool
    })
    competitionFinalization = finalizeCalibratedDecision({
      actionCalibration, candidatePool, review: review.output, champion: args.champion, budget: args.competitionBudget, decisionMode: args.decisionMode,
      warnings: [...opinionAuditWarnings, ...[
        ...direction.initial_decisions, ...direction.final_decisions, ...advice.initial_decisions, ...advice.final_decisions, review.output
      ].flatMap(item => Array.isArray(item?.warnings) ? item.warnings : [])]
    })
    await notifyProgress(args.onProgress, {
      type: 'champion_gate_completed',
      stage: 'competition_calibration',
      phase: 'champion_gate',
      gate: competitionFinalization.champion_gate?.recommended_status || null,
      decision_finalized: competitionFinalization.decision_finalized === true,
      finalization_status: competitionFinalization.finalization_status || null
    })
    calibrationEvents = review.events
  }
  const clean = directionOutcome.unanimous && adviceOutcome.unanimous
  const manualAdjudicationRequired = calibratedCompetition ? false : direction.termination.requires_human_review === true || advice.termination.requires_human_review === true
  const rounds = [
    { ...direction.round, phase: 'decision_direction' },
    { ...advice.round, phase: 'risk_control_advice' }
  ].map((round, index) => ({ ...round, global_round: index + 1 }))
  const termination = {
    ...advice.termination,
    status: calibratedCompetition ? 'program_finalized' : clean ? 'clean_exit' : manualAdjudicationRequired ? 'adjudication_required' : 'majority_exit',
    reason: calibratedCompetition ? 'single_pass_calibration_and_program_finalization' : clean ? 'two_stage_unanimous' : manualAdjudicationRequired ? 'major_disagreement_requires_adjudication' : 'two_stage_single_vote_majority',
    production_eligible: !manualAdjudicationRequired,
    clean_gate_satisfied: clean,
    forced_conclusion: false,
    majority_resolution: !clean && !manualAdjudicationRequired,
    rounds_completed: rounds.length,
    clean_round_streak: clean ? 1 : 0,
    required_clean_round_streak: 1,
    maximum_automated_rounds_before_forced_conclusion: 1,
    direction_rounds: 1,
    advice_rounds: 1,
    requires_human_review: manualAdjudicationRequired,
    unresolved_important_ids: manualAdjudicationRequired ? ['major-disagreement'] : [],
    unresolved_high_severity_ids: direction.termination.requires_human_review ? ['major-disagreement:decision_direction'] : [],
    unanswered_challenge_ids: []
  }
  if (calibratedCompetition) {
    termination.decision_finalized = true
    termination.max_debate_rounds = 1
    termination.max_revision_per_seat = 1
    termination.max_review_rounds = 1
    termination.max_calibration_rounds = 1
    termination.max_evidence_refresh_after_freeze = 0
  }
  return {
    final_opinions: finalOpinions,
    events: [...directionRuns.flatMap(item => item.events), ...direction.events, ...adviceRuns.flatMap(item => item.events), ...advice.events, ...calibrationEvents],
    competition_finalization: competitionFinalization,
    record: {
      contract_version: args.decisionMode === 'competition_calibrated_v2' ? '7.0.0' : calibratedCompetition ? '6.0.0' : '5.0.0',
      decision_mode: args.decisionMode || 'business',
      participant_agent_ids: seatIds,
      same_seats_in_both_stages: true,
      action_first_conditioned_risk: calibratedCompetition,
      context_format: 'compact_json',
      raw_model_output_forwarded: false,
      rules: structuredClone(args.config),
      phases: { decision_direction: direction, risk_control_advice: advice },
      rounds,
      two_stage_outcome: { direction: directionOutcome, advice: adviceOutcome, manual_adjudication_required: manualAdjudicationRequired },
      competition_calibration: competitionFinalization,
      termination
    }
  }
}

async function runCalibratedJointDebate(args) {
  const phase = 'competition_joint_decision'
  const schema = args.competitionStageDecisionSchema
  const seatIds = args.agents.map(agent => agent.agent_id)
  await notifyProgress(args.onProgress, { type: 'phase_started', stage: 'group_debate', phase: 'joint_independent_decision' })
  const initialRuns = await allSettledOrThrow(args.agents.map(agent => decideStageOne({
    ...args,
    agent,
    phase,
    frozenDirection: null,
    stageDecisionSchema: schema
  })))
  const joint = await runDecisionStage({
    ...args,
    phase,
    initialDecisions: initialRuns.map(item => item.output),
    frozenDirection: null,
    stageDecisionSchema: schema
  })
  const direction = derivedStageRecord(joint, 'decision_direction')
  const advice = derivedStageRecord(joint, 'risk_control_advice')
  const actionCalibration = calibrateActionCandidate({
    initialDecisions: direction.initial_decisions,
    finalDecisions: direction.final_decisions
  })
  const candidatePool = buildExactSetCandidatePool({
    initialDecisions: advice.initial_decisions,
    finalDecisions: advice.final_decisions
  })
  const directionOutcome = {
    value: actionCalibration.calibrated_direction,
    votes: Object.fromEntries(actionCalibration.support.candidates.map(item => [item.value, item.post_broadcast_support_count])),
    unanimous: actionCalibration.support.candidates.some(item => item.post_broadcast_support_count === 3),
    majority_available: actionCalibration.support.candidates.some(item => item.post_broadcast_support_count >= 2),
    provisional: false,
    rule: 'program_decision_threshold_calibration'
  }
  const adviceOutcome = {
    values: [...(candidatePool.candidates[0]?.value || [])],
    candidate_sets: candidatePool.candidates,
    unanimous: candidatePool.candidates.some(item => item.post_broadcast_support_count === 3),
    majority_available: candidatePool.candidates.some(item => item.post_broadcast_support_count >= 2),
    provisional: false,
    rule: 'exact_set_candidate_pool_no_label_union'
  }
  const finalOpinions = args.agents.map(agent => buildCompatibilityOpinion({
    agent,
    caseData: args.caseData,
    industryPlan: args.industryPlan || args.caseData.industry_plan,
    direction: direction.final_decisions.find(item => item['执行员'] === agent.agent_id),
    advice: advice.final_decisions.find(item => item['执行员'] === agent.agent_id)
  }))
  const opinionAuditWarnings = []
  for (const opinion of finalOpinions) {
    const agent = args.agents.find(item => item.agent_id === opinion.agent_id)
    opinionAuditWarnings.push(...gateCompetitionOpinion(opinion, agent, args.evidenceIds, args.opinionSchema))
  }
  opinionAuditWarnings.push(...auditPrimaryEvidence(finalOpinions, args.evidenceGrades))
  const review = await runCalibrationReviewer({
    ...args,
    direction,
    advice,
    actionCalibration,
    candidatePool
  })
  const competitionFinalization = finalizeCalibratedDecision({
    actionCalibration,
    candidatePool,
    review: review.output,
    champion: args.champion,
    budget: args.competitionBudget,
    warnings: [...opinionAuditWarnings, ...[...joint.initial_decisions, ...joint.final_decisions, review.output]
      .flatMap(item => Array.isArray(item?.warnings) ? item.warnings : [])]
  })
  const clean = directionOutcome.unanimous && adviceOutcome.unanimous
  const termination = {
    status: 'program_finalized',
    reason: 'single_joint_broadcast_revision_calibration_and_program_finalization',
    production_eligible: true,
    clean_gate_satisfied: clean,
    forced_conclusion: false,
    majority_resolution: !clean,
    rounds_completed: 1,
    clean_round_streak: clean ? 1 : 0,
    required_clean_round_streak: 1,
    maximum_automated_rounds_before_forced_conclusion: 1,
    direction_rounds: 1,
    advice_rounds: 1,
    joint_rounds: 1,
    same_joint_round: true,
    requires_human_review: false,
    unresolved_important_ids: [],
    unresolved_high_severity_ids: [],
    unanswered_challenge_ids: [],
    decision_finalized: true,
    max_debate_rounds: 1,
    max_revision_per_seat: 1,
    max_review_rounds: 1,
    max_calibration_rounds: 1,
    max_evidence_refresh_after_freeze: 0
  }
  await notifyProgress(args.onProgress, {
    type: 'phase_completed',
    stage: 'group_debate',
    phase: 'joint_decision',
    unanimous: clean,
    action: competitionFinalization.action,
    risk_control_advice: competitionFinalization.risk_control_advice
  })
  return {
    final_opinions: finalOpinions,
    events: [...initialRuns.flatMap(item => item.events), ...joint.events, ...review.events],
    competition_finalization: competitionFinalization,
    record: {
      contract_version: '6.1.0',
      decision_mode: 'competition_calibrated',
      participant_agent_ids: seatIds,
      same_seats_in_both_stages: true,
      joint_action_and_risk_call: true,
      context_format: 'compact_json',
      raw_model_output_forwarded: false,
      rules: structuredClone(args.config),
      phases: { joint_decision: joint, decision_direction: direction, risk_control_advice: advice },
      rounds: [{ ...joint.round, phase: 'joint_decision', global_round: 1 }],
      two_stage_outcome: { direction: directionOutcome, advice: adviceOutcome, manual_adjudication_required: false },
      competition_calibration: competitionFinalization,
      termination
    }
  }
}

function derivedStageRecord(joint, phase) {
  const project = decision => phase === 'decision_direction'
    ? {
        execution_agent: decision.execution_agent,
        action_candidate: decision.action_candidate,
        action_confidence: decision.action_confidence,
        action_reason: structuredClone(decision.action_reason || []),
        transmission_evidence: structuredClone(decision.transmission_evidence || []),
        threshold_evidence: structuredClone(decision.threshold_evidence || []),
        counter_evidence: structuredClone(decision.counter_evidence || []),
        '执行员': decision['执行员'],
        '经营调整方向': decision['经营调整方向'],
        '逻辑': structuredClone(decision['逻辑']),
        '证据': structuredClone(decision['证据'])
      }
    : {
        execution_agent: decision.execution_agent,
        set_confidence: decision.set_confidence,
        label_assessments: structuredClone(decision.label_assessments || []),
        '执行员': decision['执行员'],
        '风控建议': structuredClone(decision['风控建议'] || []),
        '逻辑': structuredClone(decision['逻辑']),
        '证据': structuredClone(decision['证据'])
      }
  return {
    contract_version: '1.0.0',
    phase,
    participant_agent_ids: [...joint.participant_agent_ids],
    initial_decisions: joint.initial_decisions.map(project),
    difference_packet: structuredClone(joint.difference_packet),
    final_decisions: joint.final_decisions.map(project),
    changed_seat_ids: [...joint.changed_seat_ids],
    frozen_seat_ids: [...joint.frozen_seat_ids],
    review_output_count: joint.review_output_count,
    vote: structuredClone(joint.vote),
    round: structuredClone(joint.round),
    termination: structuredClone(joint.termination),
    events: []
  }
}

async function runCalibrationReviewer({ core, provider, calibrationReviewer, caseData, industryPlan, direction, advice, actionCalibration, candidatePool, champion, calibrationReviewSchema, competitionBudget, onProgress, modelCallCheckpoints, executionFingerprint, decisionMode = 'competition_calibrated' }) {
  if (!calibrationReviewer) throw new Error('competition calibration reviewer is missing')
  const reviewCandidatePool = buildReviewerCandidatePool({ actionCalibration, candidatePool, champion })
  await notifyProgress(onProgress, {
    type: 'reviewer_candidate_pool_created',
    stage: 'competition_calibration',
    phase: 'reviewer_selection',
    candidate_pool: reviewCandidatePool
  })
  const result = await withAgentProgress({
    onProgress,
    agent: calibrationReviewer,
    stage: 'competition_calibration',
    phase: 'single_pass_calibration',
    operation: 'review_frozen_competition_candidates'
  }, async () => {
    competitionBudget.consume('calibration_reviewer')
    const promptBuilder = decisionMode === 'competition_calibrated_v2' ? competitionJointCalibrationPrompt : competitionCalibrationPrompt
    const prompt = promptBuilder({
      agent: calibrationReviewer,
      frozenCase: caseData,
      industryPlan: industryPlan || caseData.industry_plan,
      initialOutputs: { action: direction.initial_decisions, risk: advice.initial_decisions },
      postBroadcastOutputs: { action: direction.final_decisions, risk: advice.final_decisions },
      actionCalibration,
      candidatePool,
      reviewCandidatePool,
      champion
    })
    const pipeline = new core.HybridPipeline({
      id: `competition-calibration-${caseData.case_id}`,
      steps: [
        {
          id: 'model_single_pass_calibration',
          owner: 'model',
          run: () => provider.reviewCalibration({
            agent: calibrationReviewer,
            mode: decisionMode,
            prompt,
            candidatePool: structuredClone(candidatePool),
            reviewCandidatePool: structuredClone(reviewCandidatePool),
            actionCalibration: structuredClone(actionCalibration),
            champion: champion ? structuredClone(champion) : null
          })
        },
        {
          id: 'program_calibration_permission_gate',
          owner: 'program',
          run: review => {
            assertSchema(calibrationReviewSchema, review, 'competition calibration review')
            const errors = validateCalibrationReview(review, { candidatePool, actionCalibration, champion, reviewCandidatePool })
            if (errors.length) throw new Error(`competition calibration gate rejected: ${errors.join('; ')}`)
            return review
          }
        }
      ]
    })
    if (!modelCallCheckpoints) return pipeline.run({})
    return modelCallCheckpoints.execute({
      identity: stageCheckpointIdentity({
        operation: 'reviewCalibration', phase: decisionMode === 'competition_calibrated_v2' ? 'competition_joint_calibration' : 'competition_calibration', agent: calibrationReviewer,
        caseData, prompt, frozenDirection: null, executionFingerprint, decisionMode
      }),
      run: () => pipeline.run({}),
      validate: value => {
        assertSchema(calibrationReviewSchema, value, 'checkpointed competition calibration review')
        const errors = validateCalibrationReview(value, { candidatePool, actionCalibration, champion, reviewCandidatePool })
        if (errors.length) throw new Error(`competition calibration checkpoint gate rejected: ${errors.join('; ')}`)
      }
    })
  })
  await notifyProgress(onProgress, {
    type: 'reviewer_selection_completed',
    stage: 'competition_calibration',
    phase: 'reviewer_selection',
    selected_action_candidate_id: result.output?.selected_action_candidate_id || null,
    selected_risk_candidate_id: result.output?.selected_risk_candidate_id || null,
    challenge_level: result.output?.challenge_level || result.output?.challenge_strength || null
  })
  return result
}

async function decideStageOne({ core, provider, agent, phase, caseData, industryPlan, evidenceIds, stageDecisionSchema, frozenDirection, modelCallCheckpoints, executionFingerprint, onProgress, decisionMode = 'business', competitionBudget = null }) {
  return withAgentProgress({
    onProgress,
    agent,
    stage: 'group_debate',
    phase: `${phase}_initial`,
    operation: 'independent_decision'
  }, async () => {
    const mode = decisionMode
    if (competitionBudget) competitionBudget.consume('initial_seat', 1, decisionMode === 'competition_calibrated_v2' ? `${phase}:${agent.agent_id}` : agent.agent_id)
    const promptArgs = { agent, phase, caseData, industryPlan: industryPlan || caseData.industry_plan, frozenDirection, mode }
    const prompt = decisionMode === 'competition_calibrated_v2'
      ? phase === 'decision_direction' ? competitionActionPrompt(promptArgs) : competitionRiskPrompt(promptArgs)
      : stageDecisionPrompt(promptArgs)
    const pipeline = new core.HybridPipeline({
      id: `stage-decision-${phase}-${agent.agent_id}`,
      steps: [
        {
          id: 'model_stage_decision',
          owner: 'model',
          run: () => provider.decideStage({
            agent,
            phase,
            caseData: structuredClone(caseData),
            industryPlan: structuredClone(industryPlan || caseData.industry_plan),
            frozenDirection,
            mode,
            prompt
          })
        },
        {
          id: 'program_four_module_gate',
          owner: 'program',
          run: decision => {
            assertSchema(stageDecisionSchema, decision, `${phase} decision`)
            const errors = validateStageDecision(decision, { agent, phase, evidenceIds, frozenDirection, mode })
            if (errors.length) throw new Error(`${phase} decision gate rejected: ${errors.join('; ')}`)
            return decision
          }
        }
      ]
    })
    if (!modelCallCheckpoints) return pipeline.run({})
    const fallbackOffset = provider.diagnostics().fallback_events.length
    return modelCallCheckpoints.execute({
      identity: stageCheckpointIdentity({ operation: 'decideStage', phase, agent, caseData, prompt, frozenDirection, executionFingerprint, decisionMode: mode }),
      run: () => pipeline.run({}),
      validate: decision => gateStageCheckpointOutput({ decision, agent, phase, evidenceIds, stageDecisionSchema, frozenDirection, mode }),
      cacheable: () => !provider.diagnostics().fallback_events.slice(fallbackOffset).some(event => event.operation === 'decideStage' && event.agent_id === agent.agent_id)
    })
  })
}

async function runDecisionStage({ core, provider, agents, phase, initialDecisions, caseData, evidenceIds, evidenceGrades, stageDecisionSchema, frozenDirection, modelCallCheckpoints, executionFingerprint, onProgress, decisionMode = 'business', competitionBudget = null }) {
  const graph = buildBoundedDecisionStageGraph({
    evaluate_initial: async context => {
      const signatures = context.initialDecisions.map(decision => stageDecisionSignature(decision, phase))
      return { ...context, signatures, route: ['competition_calibrated', 'competition_calibrated_v2'].includes(decisionMode) ? 'self_review' : new Set(signatures).size === 1 ? 'freeze_initial' : 'self_review' }
    },
    freeze_initial: async context => ({ ...context, result: {
      contract_version: '1.0.0', phase, participant_agent_ids: agents.map(agent => agent.agent_id),
      initial_decisions: structuredClone(context.initialDecisions), difference_packet: null,
      final_decisions: structuredClone(context.initialDecisions), changed_seat_ids: [],
      frozen_seat_ids: agents.map(agent => agent.agent_id), review_output_count: 0,
      round: { round: 1, stage: 'independent_answer_alignment', review_output_count: 0, clean: true },
      termination: { status: 'clean_exit', reason: 'initial_unanimous', requires_human_review: false }, events: []
    } }),
    self_review: async context => {
      await notifyProgress(onProgress, { type: 'phase_started', stage: 'group_debate', phase: `${phase}_self_review` })
      const differencePacket = buildStageDifferencePacket({ phase, decisions: context.initialDecisions })
      const evidenceIndex = buildStageEvidenceIndex(caseData, context.initialDecisions)
      const allAdviceCodes = ['risk_control_advice', 'competition_joint_decision'].includes(phase) ? new Set(context.initialDecisions.flatMap(item => item['风控建议'] || []).map(String)) : null
      const frozenAdviceCodes = phase === 'risk_control_advice' && !['competition_calibrated', 'competition_calibrated_v2'].includes(decisionMode) ? [...allAdviceCodes].filter(code => context.initialDecisions.every(item => (item['风控建议'] || []).includes(code))) : []
      const reviewRuns = await allSettledOrThrow(agents.map(agent => {
        const ownDecision = context.initialDecisions.find(item => item['执行员'] === agent.agent_id)
        return reviewStageOne({
          core, provider, agent, phase, ownDecision,
          peerDecisions: context.initialDecisions.filter(item => item['执行员'] !== agent.agent_id),
          differencePacket, evidenceIndex, evidenceIds, stageDecisionSchema, frozenDirection,
          allowedAdviceCodes: allAdviceCodes, frozenAdviceCodes,
          modelCallCheckpoints,
          executionFingerprint,
          caseData,
          onProgress,
          decisionMode,
          competitionBudget
        })
      }))
      return { ...context, differencePacket, reviewRuns }
    },
    freeze_reviewed: async context => {
      const finalDecisions = context.reviewRuns.map(item => item.output)
      const finalSignatures = finalDecisions.map(decision => stageDecisionSignature(decision, phase))
      const unanimous = new Set(finalSignatures).size === 1
      const vote = phase === 'decision_direction'
        ? majorityDirectionDecisions(finalDecisions)
        : phase === 'risk_control_advice'
          ? majorityAdviceDecisions(finalDecisions)
          : majorityJointDecisions(finalDecisions)
      const requiresHumanReview = phase === 'competition_joint_decision' ? false : !unanimous && !vote.majority_available
      return { ...context, result: {
        contract_version: '1.0.0', phase, participant_agent_ids: agents.map(agent => agent.agent_id),
        initial_decisions: structuredClone(context.initialDecisions), difference_packet: context.differencePacket,
        final_decisions: finalDecisions,
        changed_seat_ids: finalDecisions.filter((item, index) => finalSignatures[index] !== context.signatures[index]).map(item => item['执行员']),
        frozen_seat_ids: finalDecisions.map(item => item['执行员']), review_output_count: context.reviewRuns.length, vote,
        round: { round: 1, stage: 'self_impact_review_and_vote', review_output_count: context.reviewRuns.length, clean: unanimous, majority_available: vote.majority_available },
        termination: {
          status: unanimous ? 'clean_exit' : requiresHumanReview ? 'adjudication_required' : 'majority_exit',
          reason: unanimous ? 'self_review_unanimous' : requiresHumanReview ? 'vote_remains_inconsistent' : 'single_vote_majority',
          requires_human_review: requiresHumanReview
        },
        events: context.reviewRuns.flatMap(item => item.events)
      } }
    }
  })
  const state = await graph.invoke({ context: { initialDecisions: structuredClone(initialDecisions) } })
  return state.context.result
}

async function allSettledOrThrow(promises) {
  const settled = await Promise.allSettled(promises)
  const failed = settled.find(result => result.status === 'rejected')
  if (failed) throw failed.reason
  return settled.map(result => result.value)
}

async function reviewStageOne({ core, provider, agent, phase, ownDecision, peerDecisions, differencePacket, evidenceIndex, evidenceIds, stageDecisionSchema, frozenDirection, allowedAdviceCodes, frozenAdviceCodes, modelCallCheckpoints, executionFingerprint, caseData, onProgress, decisionMode = 'business', competitionBudget = null }) {
  return withAgentProgress({
    onProgress,
    agent,
    stage: 'group_debate',
    phase: `${phase}_self_review`,
    operation: 'self_impact_review'
  }, async () => {
    if (competitionBudget) competitionBudget.consume('revision', 1, decisionMode === 'competition_calibrated_v2' ? `${phase}:${agent.agent_id}` : agent.agent_id)
    const prompt = selfImpactReviewPrompt({ agent, phase, ownDecision, peerDecisions, differencePacket, evidenceIndex, frozenDirection, mode: decisionMode })
    const pipeline = new core.HybridPipeline({
      id: `stage-review-${phase}-${agent.agent_id}`,
      steps: [
        {
          id: 'model_self_impact_review',
          owner: 'model',
          run: () => provider.reviewStage({
            agent,
            phase,
            ownDecision: structuredClone(ownDecision),
            peerDecisions: structuredClone(peerDecisions),
            frozenDirection,
            allowedAdviceCodes,
            mode: decisionMode,
            prompt
          })
        },
        {
          id: 'program_four_module_review_gate',
          owner: 'program',
          run: decision => {
            if (phase === 'risk_control_advice') {
              decision['风控建议'] = [...new Set([...frozenAdviceCodes, ...(decision['风控建议'] || []).map(String)])].sort((a, b) => Number(a) - Number(b))
            }
            assertSchema(stageDecisionSchema, decision, `${phase} reviewed decision`)
            const errors = validateStageDecision(decision, { agent, phase, evidenceIds, frozenDirection, allowedAdviceCodes, mode: decisionMode })
            if (errors.length) throw new Error(`${phase} review gate rejected: ${errors.join('; ')}`)
            return decision
          }
        }
      ]
    })
    if (!modelCallCheckpoints) return pipeline.run({})
    const fallbackOffset = provider.diagnostics().fallback_events.length
    return modelCallCheckpoints.execute({
      identity: stageCheckpointIdentity({ operation: 'reviewStage', phase, agent, caseData, prompt, frozenDirection, executionFingerprint, decisionMode }),
      run: () => pipeline.run({}),
      validate: decision => gateStageCheckpointOutput({ decision, agent, phase, evidenceIds, stageDecisionSchema, frozenDirection, allowedAdviceCodes, mode: decisionMode }),
      cacheable: () => !provider.diagnostics().fallback_events.slice(fallbackOffset).some(event => event.operation === 'reviewStage' && event.agent_id === agent.agent_id)
    })
  })
}

function stageCheckpointIdentity({ operation, phase, agent, caseData, prompt, frozenDirection, executionFingerprint, decisionMode = 'business' }) {
  const checkpointPhase = decisionMode === 'competition_calibrated_v2'
    ? phase === 'decision_direction' ? 'competition_action_decision'
      : phase === 'risk_control_advice' ? 'competition_risk_decision'
        : phase
    : phase
  return {
    contract_version: '1.0.0', operation, phase: checkpointPhase,
    agent: { agent_id: agent.agent_id, version: agent.version, method_family: agent.method_family, model_profile: agent.model_profile },
    case_id: caseData.case_id,
    frozen_case_sha256: sha256({
      contract_version: caseData.contract_version,
      case_id: caseData.case_id,
      as_of_date: caseData.as_of_date,
      competition_cutoff: caseData.competition_cutoff,
      company: caseData.company,
      evidence: caseData.evidence,
      industry_plan: caseData.industry_plan
    }),
    prompt_sha256: sha256(prompt),
    frozen_direction: frozenDirection,
    decision_mode: decisionMode,
    execution_fingerprint: executionFingerprint || null
  }
}

function gateStageCheckpointOutput({ decision, agent, phase, evidenceIds, stageDecisionSchema, frozenDirection, allowedAdviceCodes = null, mode = 'business' }) {
  assertSchema(stageDecisionSchema, decision, `${phase} checkpointed decision`)
  const errors = validateStageDecision(decision, { agent, phase, evidenceIds, frozenDirection, allowedAdviceCodes, mode })
  if (errors.length) throw new Error(`${phase} checkpoint gate rejected: ${errors.join('; ')}`)
  return true
}

function buildStageDifferencePacket({ phase, decisions }) {
  if (phase === 'competition_joint_decision') return {
    contract_version: '1.0.0',
    phase,
    answer_key: ['经营调整方向', '风控建议'],
    distinct_answers: [...new Set(decisions.map(item => stageDecisionSignature(item, phase)))].map(value => JSON.parse(value)),
    differing_executor_ids: decisions.map(item => item['执行员'])
  }
  const answerKey = phase === 'decision_direction' ? '经营调整方向' : '风控建议'
  return {
    contract_version: '1.0.0',
    phase,
    answer_key: answerKey,
    distinct_answers: [...new Set(decisions.map(item => JSON.stringify(item[answerKey])))].map(value => JSON.parse(value)),
    differing_executor_ids: decisions.map(item => item['执行员'])
  }
}

function buildStageEvidenceIndex(caseData, decisions) {
  const referenced = new Set(decisions.flatMap(item => item['证据'] || []))
  return (caseData.evidence || []).filter(item => referenced.has(item.id)).map(item => ({
    id: item.id,
    publisher: item.publisher,
    title: item.title,
    published_at: item.published_at,
    evidence_grade: item.evidence_grade,
    summary: compactText(item.summary, 700)
  }))
}

function stageDecisionSignature(decision, phase) {
  if (phase === 'competition_joint_decision') return JSON.stringify([
    String(decision['经营调整方向']),
    [...(decision['风控建议'] || [])].map(String).sort((a, b) => Number(a) - Number(b))
  ])
  return phase === 'decision_direction'
    ? String(decision['经营调整方向'])
    : JSON.stringify([...(decision['风控建议'] || [])].map(String).sort((a, b) => Number(a) - Number(b)))
}

function majorityDirectionDecisions(decisions) {
  return majorityDirection(decisions.map(item => ({ result_candidate: item['经营调整方向'] })))
}

function majorityAdviceDecisions(decisions) {
  return majorityAdvice(decisions.map(item => ({ recommended_advice: item['风控建议'] || [] })))
}

function majorityJointDecisions(decisions) {
  const signatures = decisions.map(item => stageDecisionSignature(item, 'competition_joint_decision'))
  const counts = signatures.reduce((result, signature) => ({ ...result, [signature]: (result[signature] || 0) + 1 }), {})
  const [value, count] = Object.entries(counts).sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0]
  return { value: JSON.parse(value), votes: counts, unanimous: count === 3, majority_available: count >= 2, provisional: count < 2, rule: 'whole_joint_candidate_vote_only' }
}

function buildCompatibilityOpinion({ agent, caseData, industryPlan, direction, advice }) {
  const evidenceRefs = [...new Set([...(direction['证据'] || []), ...(advice['证据'] || [])])]
  const result = direction['经营调整方向']
  const factorDirection = result === 'risk_flat' ? 'neutral' : result
  const probabilities = {
    risk_up: result === 'risk_up' ? 1 : 0,
    risk_flat: result === 'risk_flat' ? 1 : 0,
    risk_down: result === 'risk_down' ? 1 : 0
  }
  const nodes = (industryPlan?.['产业链']?.nodes || []).map(node => ({ id: node.id, label: node.name || node.id }))
  const layerByNode = new Map((industryPlan?.['产业链']?.nodes || []).map(node => [node.id, node.layer]))
  const edges = (industryPlan?.['产业链']?.edges || []).map((edge, index) => ({
    from: edge.from,
    to: edge.to,
    relation: edge.relation,
    status: 'inferred',
    chain_layer: normalizeChainLayer(layerByNode.get(edge.from), layerByNode.get(edge.to)),
    transmission_mechanism: edge.transmission_mechanism,
    horizon_days: Number(caseData.decision_horizon_days) || 180,
    invalidation_condition: '若冻结公开证据不能支持该传导关系，则该假设边不得作为结论依据。',
    evidence_refs: evidenceRefs
  }))
  const logic = [...direction['逻辑'], ...advice['逻辑']]
  const factors = logic.map((item, index) => ({
    id: `${agent.agent_id}:stage-factor-${index + 1}`,
    name: item.claim,
    direction: factorDirection,
    strength: 0.5,
    confidence: 0.5,
    transmission_mechanism: item.mechanism,
    horizon_days: Number(caseData.decision_horizon_days) || 180,
    correlation_group: `stage_logic_${index + 1}`,
    evidence_refs: item.evidence_refs,
    invalidation_condition: '若所引冻结证据被撤销、纠正或不能支持该机制，则该因子失效。'
  }))
  return {
    agent_id: agent.agent_id,
    agent_version: agent.version,
    method_family: agent.method_family,
    result_candidate: result,
    probabilities,
    factors,
    chain_map: { nodes, edges },
    recommended_advice: [...advice['风控建议']],
    stage_decisions: { decision_direction: structuredClone(direction), risk_control_advice: structuredClone(advice) },
    thesis: direction['逻辑'].map(item => item.claim).join('；'),
    uncertainties: ['产业链边为前置研究假设，结论仅采用冻结公开证据能够支持的部分。']
  }
}

function normalizeChainLayer(fromLayer, toLayer) {
  if (fromLayer === 'upstream' || toLayer === 'upstream') return 'upstream'
  if (fromLayer === 'downstream' || toLayer === 'downstream') return 'downstream'
  if (fromLayer === 'target' || toLayer === 'target') return 'target'
  return 'cross_cutting'
}

function majorityDirection(opinions) {
  const order = ['risk_down', 'risk_flat', 'risk_up']
  const votes = opinions.map(opinion => opinion.result_candidate)
  const counts = Object.fromEntries(order.map(value => [value, votes.filter(vote => vote === value).length]))
  const majorityValue = order.find(candidate => counts[candidate] >= 2)
  const value = majorityValue || [...votes].sort((left, right) => order.indexOf(left) - order.indexOf(right))[1]
  return {
    value,
    votes: counts,
    unanimous: counts[value] === opinions.length,
    majority_available: Boolean(majorityValue),
    provisional: !majorityValue,
    rule: majorityValue ? 'single_vote_majority' : 'provisional_ordinal_median_pending_adjudication'
  }
}

function majorityAdvice(opinions) {
  const counts = {}
  for (const opinion of opinions) {
    for (const code of new Set((opinion.recommended_advice || []).map(String))) counts[code] = (counts[code] || 0) + 1
  }
  const values = Object.entries(counts)
    .filter(([, count]) => count >= 2)
    .sort((left, right) => right[1] - left[1] || Number(left[0]) - Number(right[0]))
    .map(([code]) => code)
  const signatures = opinions.map(opinion => JSON.stringify([...new Set(opinion.recommended_advice || [])].map(String).sort()))
  return { values, votes: counts, unanimous: new Set(signatures).size === 1, majority_available: values.length > 0, provisional: values.length === 0, rule: 'single_vote_per_code_majority' }
}

function applyTwoStageOutcome(consensus, outcome, decisionConfig) {
  if (!outcome?.direction?.value) throw new Error('two-stage debate outcome is missing')
  const advice = outcome.advice.values.length
    ? outcome.advice.values.slice(0, decisionConfig.maximum_advice_items)
    : [outcome.direction.value === 'risk_up' ? '4' : outcome.direction.value === 'risk_flat' ? '3' : '1']
  return {
    ...consensus,
    risk_label: outcome.direction.value,
    action: String(decisionConfig.contest_action_map[outcome.direction.value]),
    risk_control_advice: advice,
    decision_mode: outcome.manual_adjudication_required
      ? 'major_disagreement_pending_adjudication'
      : outcome.direction.unanimous && outcome.advice.unanimous ? 'two_stage_unanimous' : 'two_stage_majority',
    two_stage_outcome: structuredClone(outcome)
  }
}

function applyCompetitionFinalization(consensus, finalization) {
  if (!finalization?.decision_finalized) throw new Error('competition calibrated decision reached conclusion without Program Finalization')
  const confidence = Math.max(0.05, Math.min(0.95, Number(finalization.action_calibration?.confidence_signal) || 0.34))
  const remainder = (1 - confidence) / 2
  const probabilities = { risk_up: remainder, risk_flat: remainder, risk_down: remainder }
  probabilities[finalization.risk_label] = confidence
  return {
    ...consensus,
    probabilities,
    risk_label: finalization.risk_label,
    action: finalization.action,
    risk_control_advice: [...finalization.risk_control_advice],
    decision_mode: 'competition_calibrated_program_finalization',
    conclusion_grade: finalization.champion_gate.recommended_status,
    evidence_insufficient: false,
    forced_adjustment: null,
    competition_finalization: structuredClone(finalization)
  }
}

async function runShadowChallengers({ core, provider, challengers, caseData, evidenceIds, evidenceGrades, opinionSchema, stageDecisionSchema, industryPlan }) {
  const opinions = []
  const runs = []
  const events = []
  for (const challenger of challengers) {
    try {
      const direction = await decideStageOne({
        core, provider,
        agent: challenger,
        caseData,
        industryPlan,
        evidenceIds,
        stageDecisionSchema,
        phase: 'decision_direction',
        frozenDirection: null
      })
      const frozenDirection = direction.output['经营调整方向']
      const advice = await decideStageOne({
        core, provider,
        agent: challenger,
        caseData,
        industryPlan,
        evidenceIds,
        stageDecisionSchema,
        phase: 'risk_control_advice',
        frozenDirection
      })
      const opinion = buildCompatibilityOpinion({ agent: challenger, caseData, industryPlan, direction: direction.output, advice: advice.output })
      gateOpinion(opinion, challenger, evidenceIds, opinionSchema)
      gatePrimaryEvidence([opinion], evidenceGrades)
      opinions.push(opinion)
      runs.push({ agent_id: challenger.agent_id, slot_id: challenger.slot_id, status: 'completed', protocol: 'four_module_two_stage_shadow' })
      events.push(...direction.events, ...advice.events)
    } catch (error) {
      runs.push({
        agent_id: challenger.agent_id,
        slot_id: challenger.slot_id,
        status: 'failed',
        error_code: 'SHADOW_RUN_FAILED',
        error_sha256: sha256(error.message)
      })
    }
  }
  return { opinions, runs, events }
}

function buildDeterministicCreditStrategy({ consensus, caseData, debateTermination, evidenceIds, decisionMode = 'business' }) {
  const references = [...new Set([
    ...(consensus.factors || []).flatMap(item => item.evidence_refs || []),
    ...(consensus.chain_map?.edges || []).flatMap(item => item.evidence_refs || [])
  ])].filter(reference => evidenceIds.has(reference))
  if (references.length === 0) references.push(...caseData.evidence.slice(0, 2).map(item => item.id))
  const strategy = {
    agent_id: 'program_consensus_renderer',
    agent_version: 1,
    action: consensus.action,
    risk_control_advice: [...consensus.risk_control_advice],
    strategy_summary: ['competition_calibrated', 'competition_calibrated_v2'].includes(decisionMode)
      ? decisionMode === 'competition_calibrated_v2'
        ? '同一三席先冻结Action，再以该Action为条件冻结Risk完整集合；单次Calibration Reviewer与Program完成联合一致性和Champion门禁。'
        : '三席独立分析、单次广播修订后冻结；单次Calibration Reviewer只提候选，Program依传导门槛、exact-set候选和Champion保护完成终结。'
      : '经营方向与风控建议由三个固定辩证席分阶段表决后确定，程序仅执行无损映射与格式化，不增加第四个模型意见。',
    rationale: ['competition_calibrated', 'competition_calibrated_v2'].includes(decisionMode)
      ? [
          `Program Action门槛与单次校准后输出 action=${consensus.action}。`,
          `风控建议只从三席冻结完整集合或其有来源删减集中选择，输出 ${consensus.risk_control_advice.join(',') || '[]'}，禁止逐标签并集。`
        ]
      : [
          `经营调整方向按三席结果映射为 action=${consensus.action}。`,
          `风控建议按同一三席对建议码的多数支持结果输出为 ${consensus.risk_control_advice.join(',')}。`
        ],
    monitoring_conditions: debateTermination.clean_gate_satisfied
      ? []
      : ['结论由奇数席位多数规则收敛；持续跟踪少数意见所引用的公开证据与失效条件。'],
    evidence_refs: references
  }
  const errors = validateCreditStrategy(strategy, { agent_id: strategy.agent_id, version: 1 }, consensus, evidenceIds)
  if (errors.length) throw new Error(`deterministic decision strategy gate rejected: ${errors.join('; ')}`)
  return strategy
}

function gatePrimaryEvidence(opinions, evidenceGrades) {
  for (const opinion of opinions) {
    const decisionReferences = [
      ...(opinion.stage_decisions?.decision_direction?.['证据'] || []),
      ...(opinion.stage_decisions?.risk_control_advice?.['证据'] || [])
    ]
    const references = decisionReferences.length
      ? decisionReferences
      : opinion.factors.flatMap(factor => factor.evidence_refs)
    const supportingGrades = references.map(reference => evidenceGrades.get(reference))
    if (!supportingGrades.some(grade => grade === 'A' || grade === 'B')) {
      throw new Error(`evidence grade gate rejected for ${opinion.agent_id}: action cannot rely only on C/D evidence`)
    }
  }
}

function auditPrimaryEvidence(opinions, evidenceGrades) {
  const warnings = []
  for (const opinion of opinions) {
    const decisionReferences = [
      ...(opinion.stage_decisions?.decision_direction?.['证据'] || []),
      ...(opinion.stage_decisions?.risk_control_advice?.['证据'] || [])
    ]
    const references = decisionReferences.length
      ? decisionReferences
      : (opinion.factors || []).flatMap(factor => factor.evidence_refs || [])
    const supportingGrades = references.map(reference => evidenceGrades.get(reference))
    if (!supportingGrades.some(grade => grade === 'A' || grade === 'B')) {
      warnings.push(`OPINION_AUDIT_PRIMARY_EVIDENCE_MISSING:${opinion.agent_id}`)
    }
  }
  return warnings
}

function gateCompetitionOpinion(opinion, agent, evidenceIds, opinionSchema) {
  if (!agent) throw new Error(`competition opinion agent is not registered: ${opinion?.agent_id || '(missing)'}`)
  if (opinion.agent_id !== agent.agent_id) throw new Error(`agent identity mismatch for ${agent.agent_id}`)
  if (Number(opinion.agent_version) !== Number(agent.version)) throw new Error(`agent version mismatch for ${agent.agent_id}`)
  if (opinion.method_family !== agent.method_family) throw new Error(`method family mismatch for ${agent.agent_id}`)
  const direction = opinion.stage_decisions?.decision_direction
  const advice = opinion.stage_decisions?.risk_control_advice
  const coreErrors = []
  if (!direction || !['risk_up', 'risk_flat', 'risk_down'].includes(direction['经营调整方向'])) coreErrors.push('decision direction core is missing or invalid')
  if (!advice || !Array.isArray(advice['风控建议'])) coreErrors.push('risk advice core is missing')
  const codes = Array.isArray(advice?.['风控建议']) ? advice['风控建议'].map(String) : []
  if (codes.length > 4 || new Set(codes).size !== codes.length || codes.some(code => !/^[1-9]$/.test(code))) coreErrors.push('risk advice core must contain 0..4 unique codes from 1..9')
  if (direction?.['执行员'] !== agent.agent_id || advice?.['执行员'] !== agent.agent_id) coreErrors.push('stage executor identity mismatch')
  if (opinion.result_candidate !== direction?.['经营调整方向']) coreErrors.push('compatibility direction differs from frozen stage core')
  if (JSON.stringify((opinion.recommended_advice || []).map(String)) !== JSON.stringify(codes)) coreErrors.push('compatibility risk differs from frozen stage core')
  if (coreErrors.length) throw new Error(`competition opinion core gate rejected for ${agent.agent_id}: ${coreErrors.join('; ')}`)

  const warnings = []
  if (opinionSchema && !opinionSchema(opinion)) warnings.push(`OPINION_AUDIT_SCHEMA_MISMATCH:${agent.agent_id}`)
  const auditErrors = validateOpinion(opinion, evidenceIds)
  if (auditErrors.length) warnings.push(`OPINION_AUDIT_FIELDS_INVALID:${agent.agent_id}`)
  opinion.audit_validation = {
    core_contract_pass: true,
    audit_contract_pass: warnings.length === 0,
    warnings: [...warnings],
    audit_error_count: auditErrors.length
  }
  for (const warning of warnings) appendProtocolWarning(opinion, warning)
  return warnings
}

function gateOpinion(opinion, agent, evidenceIds, opinionSchema) {
  if (opinion.agent_id !== agent.agent_id) throw new Error(`agent identity mismatch for ${agent.agent_id}`)
  if (Number(opinion.agent_version) !== Number(agent.version)) throw new Error(`agent version mismatch for ${agent.agent_id}`)
  if (opinion.method_family !== agent.method_family) throw new Error(`method family mismatch for ${agent.agent_id}`)
  if (opinionSchema) assertSchema(opinionSchema, opinion, `opinion ${agent.agent_id}`)
  const errors = validateOpinion(opinion, evidenceIds)
  if (errors.length) throw new Error(`opinion gate rejected for ${agent.agent_id}: ${errors.join('; ')}`)
  return opinion
}

function normalizeOperatorTask(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim()
  if (!text) return null
  if (text.length > 4000) throw new Error('operator task cannot exceed 4000 characters')
  return text
}

function withOperatorTask(caseData, operatorTask) {
  if (!operatorTask) return caseData
  return { ...caseData, operator_task: operatorTask }
}

async function notifyProgress(callback, event) {
  if (typeof callback !== 'function') return
  try {
    await callback({ ...structuredClone(event), at: event.at || new Date().toISOString() })
  } catch {
    // Observability must never change the business result or state-machine path.
  }
}

async function withAgentProgress({ onProgress, agent, stage, phase, operation }, task) {
  await notifyProgress(onProgress, {
    type: 'agent_started',
    stage,
    phase,
    operation,
    agent_id: agent.agent_id,
    agent_label: agent.label,
    model_profile: agent.model_profile
  })
  try {
    const result = await task()
    const output = result?.output || result
    const provenance = output?.model_provenance || {}
    const validationLoop = provenance.validation_loop || result?.checkpoint?.validation_loop || null
    const outputRecovery = provenance.output_recovery || output?.output_recovery || null
    await notifyProgress(onProgress, {
      type: 'agent_completed',
      stage,
      phase,
      operation,
      agent_id: agent.agent_id,
      agent_label: agent.label,
      model_profile: agent.model_profile,
      validation_status: validationLoop?.status || 'PASS',
      validation_attempt: Number(validationLoop?.attempt || 0),
      validation_max_attempts: 3,
      recovery_mode: outputRecovery?.mode || null,
      recovery_applied: Boolean(outputRecovery?.repair_applied || (outputRecovery?.mode && outputRecovery.mode !== 'json')),
      warnings: Array.isArray(output?.warnings) ? output.warnings : []
    })
    return result
  } catch (error) {
    await notifyProgress(onProgress, {
      type: 'agent_failed',
      stage,
      phase,
      operation,
      agent_id: agent.agent_id,
      agent_label: agent.label,
      model_profile: agent.model_profile,
      error_code: error.code || 'AGENT_FAILED',
      message: error.message
    })
    throw error
  }
}

async function withGroupProgress({ onProgress, agents, stage, phase, operation }, task) {
  if (!agents.length) return task()
  await notifyProgress(onProgress, {
    type: 'agent_group_started',
    stage,
    phase,
    operation,
    agents: agents.map(agent => ({ agent_id: agent.agent_id, agent_label: agent.label, model_profile: agent.model_profile }))
  })
  try {
    const result = await task()
    await notifyProgress(onProgress, {
      type: 'agent_group_completed',
      stage,
      phase,
      operation,
      agent_ids: agents.map(agent => agent.agent_id)
    })
    return result
  } catch (error) {
    await notifyProgress(onProgress, {
      type: 'agent_group_failed',
      stage,
      phase,
      operation,
      agent_ids: agents.map(agent => agent.agent_id),
      error_code: error.code || 'AGENT_GROUP_FAILED',
      message: error.message
    })
    throw error
  }
}

async function commitBranch(machine, sessionId, branchId, fields) {
  const turnId = `${branchId}-${sha256(fields).slice(0, 16)}`
  await machine.recordUserTurn(sessionId, { turnId, text: JSON.stringify(fields) })
  const result = await machine.submitFields(sessionId, { fields, sourceTurnId: turnId })
  if (result.rejected.length || result.missing.length) {
    throw new Error(`Rulora branch ${branchId} rejected: ${JSON.stringify({ rejected: result.rejected, missing: result.missing })}`)
  }
  return result
}

async function resolveEvidenceSnapshotRoot({ caseData, inputPath, root = projectRoot() }) {
  const declared = caseData?.evidence_snapshot_root
  if (declared && await directoryExists(declared)) return path.resolve(declared)
  const adjacent = path.join(path.dirname(path.resolve(inputPath)), 'evidence-snapshots')
  if (await directoryExists(adjacent)) return adjacent
  return path.resolve(declared || path.join(root, '.runtime', 'evidence-snapshots'))
}

async function directoryExists(candidate) {
  try {
    return (await fs.stat(candidate)).isDirectory()
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}

function appendProtocolWarning(value, warning) {
  if (!value || typeof value !== 'object') return
  value.warnings = [...new Set([...(Array.isArray(value.warnings) ? value.warnings : []), warning])]
}

module.exports = { applyIndustryPlanToCollectionRequest, applyTwoStageOutcome, auditPrimaryEvidence, classifyExecutionFailure, createIndustryPlan, gateCompetitionOpinion, gateOpinion, planIndustryOne, resolveEvidenceSnapshotRoot, runCase, runTwoStageDebate }
