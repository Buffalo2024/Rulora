const crypto = require('node:crypto')
const fs = require('node:fs/promises')
const path = require('node:path')
const { isCalendarDate, sha256 } = require('./utils')

function buildReport({
  runId,
  caseData,
  consensus,
  opinions,
  critiques,
  debateRecord,
  decisionStrategy,
  monitoringRecord,
  ruloraSource,
  providerSource,
  fixture,
  providerMode = fixture ? 'fixture' : 'unknown',
  providerProductionReady = !fixture,
  sourceComplianceVerified = false,
  snapshotVerified = false,
  degraded = false
}) {
  const cutoff = caseData.competition_cutoff || caseData.as_of_date
  const evidenceIds = new Set(caseData.evidence.map(item => item.id))
  const referenced = collectEvidenceRefs({ consensus, opinions, critiques, decisionStrategy })
  const decisionReferenceIds = collectDecisionEvidenceRefs({ consensus, opinions, decisionStrategy })
  const reviewReferenceIds = referenced.filter(reference => !decisionReferenceIds.includes(reference))
  const evidenceRefsValid = referenced.length > 0 && referenced.every(reference => evidenceIds.has(reference))
  const cutoffVerified = isCalendarDate(cutoff) && caseData.evidence.every(item =>
    item.public === true && isCalendarDate(item.published_at) && item.published_at <= cutoff
  )
  const probabilitiesValid = probabilityVectorValid(consensus.probabilities)
  const qa = {
    schema_valid: false,
    probabilities_valid: probabilitiesValid,
    cutoff_verified: cutoffVerified,
    source_registry_verified: sourceComplianceVerified,
    evidence_snapshots_verified: snapshotVerified,
    evidence_refs_valid: evidenceRefsValid,
    evidence_coverage: consensus.evidence_coverage,
    evidence_coverage_sufficient: consensus.evidence_insufficient !== true,
    fixture_provider: fixture,
    provider_mode: providerMode,
    provider_production_ready: false,
    degraded,
    debate_terminated: Boolean(debateRecord?.termination),
    debate_forced_conclusion: debateRecord?.termination?.forced_conclusion === true,
    production_ready: false
  }
  const submissionRow = {
    company_id: caseData.company.id,
    company_name: caseData.company.name,
    action: consensus.action,
    risk_control_advice: consensus.risk_control_advice.join(',')
  }
  return {
    contract_version: '1.0.0',
    run_id: runId,
    case_id: caseData.case_id,
    as_of_date: caseData.as_of_date,
    company: caseData.company,
    probabilities: consensus.probabilities,
    risk_label: consensus.risk_label,
    submission_row: submissionRow,
    chain_map: consensus.chain_map,
    factors: consensus.factors,
    dissent: consensus.dissent,
    monitoring: monitoringRecord,
    decision_strategy: decisionStrategy,
    decision_sources: buildSourceCatalog(caseData.evidence, decisionReferenceIds),
    review_sources: buildSourceCatalog(caseData.evidence, reviewReferenceIds),
    debate_summary: {
      opinion_count: opinions.length,
      critique_count: critiques.length,
      self_review_count: debateRecord.phases?.joint_decision
        ? Number(debateRecord.phases.joint_decision.review_output_count || 0)
        : Object.values(debateRecord.phases || {}).reduce((sum, phase) => sum + Number(phase.review_output_count || 0), 0),
      rounds_completed: debateRecord.termination.rounds_completed,
      termination_status: debateRecord.termination.status,
      termination_reason: debateRecord.termination.reason,
      production_eligible: debateRecord.termination.production_eligible,
      clean_gate_satisfied: debateRecord.termination.clean_gate_satisfied,
      forced_conclusion: debateRecord.termination.forced_conclusion,
      requires_human_review: debateRecord.termination.requires_human_review === true,
      major_disagreement: debateRecord.termination.status === 'adjudication_required',
      decision_mode: consensus.decision_mode,
      conclusion_grade: consensus.conclusion_grade,
      clean_round_streak: debateRecord.termination.clean_round_streak,
      required_clean_round_streak: debateRecord.termination.required_clean_round_streak,
      maximum_automated_rounds_before_forced_conclusion: debateRecord.termination.maximum_automated_rounds_before_forced_conclusion,
      maximum_probability_delta: debateRecord.termination.maximum_probability_delta,
      unresolved_conflicts: debateRecord.termination.unresolved_important_ids.length,
      unresolved_high_conflicts: debateRecord.termination.unresolved_high_severity_ids.length,
      unanswered_challenges: debateRecord.termination.unanswered_challenge_ids.length,
      forced_adjustment: consensus.forced_adjustment
    },
    qa,
    provenance: {
      rulora_source: ruloraSource,
      provider_source: providerSource,
      input_sha256: sha256(caseData),
      generated_at: new Date().toISOString()
    }
  }
}

function finalizeReportQa(report, { schemaValid, providerProductionReady }) {
  report.qa.schema_valid = schemaValid === true
  report.qa.provider_production_ready = providerProductionReady === true
  const competitionQa = competitionCoreQa(report)
  if (competitionQa) {
    report.qa.core_decision_valid = competitionQa.valid
    report.qa.core_decision_errors = competitionQa.errors
    report.qa.audit_warnings = competitionQa.auditWarnings
    if (report.competition_finalization) {
      const warningCodes = competitionQa.auditWarnings.map(item => item.warning_type)
      report.competition_finalization.warnings = [...new Set([...(report.competition_finalization.warnings || []), ...warningCodes])]
      if (warningCodes.length && report.competition_finalization.decision_finalized === true) {
        report.competition_finalization.finalization_status = 'FINALIZED_WITH_WARNING'
      }
    }
  }
  report.qa.production_ready = [
    report.qa.schema_valid,
    competitionQa?.valid !== false,
    report.qa.probabilities_valid,
    report.qa.cutoff_verified,
    report.qa.source_registry_verified,
    report.qa.evidence_snapshots_verified,
    competitionQa ? true : report.qa.evidence_refs_valid,
    competitionQa ? true : report.qa.evidence_coverage_sufficient,
    report.qa.fixture_provider === false,
    report.qa.degraded === false,
    report.qa.provider_production_ready,
    report.debate_summary.production_eligible === true,
    /^\d{3}$/.test(String(report.submission_row.company_id))
  ].every(Boolean)
  return report
}

function competitionCoreQa(report) {
  if (!['competition_calibrated', 'competition_calibrated_v2'].includes(report.decision_mode)) return null
  const finalization = report.competition_finalization || {}
  const action = Number(report.submission_row?.action)
  const risk = parseRiskCodes(report.submission_row?.risk_control_advice)
  const frozenAction = Number(finalization.action)
  const frozenRisk = Array.isArray(finalization.risk_control_advice) ? finalization.risk_control_advice.map(String) : null
  const errors = []
  if (![-1, 0, 1].includes(action)) errors.push('ACTION_INVALID')
  if (!risk || risk.length > 4 || new Set(risk).size !== risk.length || risk.some(code => !/^[1-9]$/.test(code))) errors.push('RISK_INVALID')
  if (finalization.decision_finalized !== true || action !== frozenAction || !sameStringSet(risk || [], frozenRisk || [])) errors.push('FROZEN_DECISION_MISMATCH')
  const auditWarnings = []
  if (report.qa.evidence_refs_valid !== true) auditWarnings.push({ warning_type: 'UNKNOWN_EVIDENCE_REF', severity: 'audit' })
  if (report.qa.evidence_coverage_sufficient !== true) auditWarnings.push({ warning_type: 'EVIDENCE_COVERAGE_INSUFFICIENT', severity: 'audit' })
  return { valid: errors.length === 0, errors, auditWarnings }
}

function parseRiskCodes(value) {
  if (Array.isArray(value)) return value.map(String)
  if (value === '') return []
  if (typeof value !== 'string') return null
  return value.split(',').map(item => item.trim()).filter(Boolean)
}

function sameStringSet(left, right) {
  const sortedRight = [...right].sort()
  return left.length === right.length && [...left].sort().every((item, index) => item === sortedRight[index])
}

function artifactPaths(outputDirectory, runId) {
  const root = path.resolve(outputDirectory)
  return {
    run_json: path.join(root, `${runId}.json`),
    report_json: path.join(root, `${runId}.report.json`),
    report_markdown: path.join(root, `${runId}.md`),
    submission_csv: path.join(root, `${runId}.submission.csv`),
    manifest_json: path.join(root, `${runId}.manifest.json`)
  }
}

async function persistArtifacts(outputDirectory, run) {
  const artifacts = run.artifacts || artifactPaths(outputDirectory, run.run_id)
  const root = path.resolve(outputDirectory)
  await fs.mkdir(root, { recursive: true })
  const pending = path.join(root, `.pending-${run.run_id}-${crypto.randomUUID()}`)
  await fs.mkdir(pending, { recursive: false })
  const payloads = {
    run_json: Buffer.from(`${JSON.stringify(run, null, 2)}\n`),
    report_json: Buffer.from(`${JSON.stringify(run.report, null, 2)}\n`),
    report_markdown: Buffer.from(renderMarkdown(run.report)),
    submission_csv: Buffer.from(renderSubmissionCsv(run.report.submission_row))
  }
  try {
    for (const [key, bytes] of Object.entries(payloads)) await fs.writeFile(path.join(pending, path.basename(artifacts[key])), bytes)
    const manifest = {
      contract_version: '1.0.0',
      run_id: run.run_id,
      case_id: run.case_id,
      status: 'committed',
      production_ready: run.report.qa.production_ready === true,
      input_sha256: run.input_sha256,
      analysis_snapshot_sha256: run.report.provenance.analysis_snapshot_sha256,
      delivery_snapshot_sha256: sha256(run.rulora.frozen_delivery),
      files: Object.fromEntries(Object.entries(payloads).map(([key, bytes]) => [key, {
        name: path.basename(artifacts[key]),
        sha256: sha256(bytes),
        bytes: bytes.length
      }])),
      committed_at: new Date().toISOString()
    }
    for (const key of Object.keys(payloads)) await fs.rename(path.join(pending, path.basename(artifacts[key])), artifacts[key])
    await fs.writeFile(path.join(pending, path.basename(artifacts.manifest_json)), `${JSON.stringify(manifest, null, 2)}\n`)
    await fs.rename(path.join(pending, path.basename(artifacts.manifest_json)), artifacts.manifest_json)
    await fs.rmdir(pending)
    return { artifacts, manifest }
  } catch (error) {
    error.message = `artifact transaction failed before manifest commit: ${error.message}`
    throw error
  }
}

function collectEvidenceRefs({ consensus, opinions, critiques, decisionStrategy }) {
  return [...new Set([
    ...(consensus.factors || []).flatMap(factor => factor.evidence_refs || []),
    ...(consensus.chain_map?.edges || []).flatMap(edge => edge.evidence_refs || []),
    ...(opinions || []).flatMap(opinion => (opinion.factors || []).flatMap(factor => factor.evidence_refs || [])),
    ...(opinions || []).flatMap(opinion => [
      ...(opinion.stage_decisions?.decision_direction?.['证据'] || []),
      ...(opinion.stage_decisions?.risk_control_advice?.['证据'] || [])
    ]),
    ...(critiques || []).flatMap(critique => critique.evidence_refs || []),
    ...(decisionStrategy.evidence_refs || [])
  ])]
}

function collectDecisionEvidenceRefs({ consensus, opinions = [], decisionStrategy }) {
  return [...new Set([
    ...(consensus.factors || []).flatMap(factor => factor.evidence_refs || []),
    ...(consensus.chain_map?.edges || []).flatMap(edge => edge.evidence_refs || []),
    ...opinions.flatMap(opinion => [
      ...(opinion.stage_decisions?.decision_direction?.['证据'] || []),
      ...(opinion.stage_decisions?.risk_control_advice?.['证据'] || [])
    ]),
    ...(decisionStrategy.evidence_refs || [])
  ])]
}

function buildSourceCatalog(evidence, references) {
  const byId = new Map((evidence || []).map(item => [item.id, item]))
  return references.map(id => byId.get(id)).filter(Boolean).map(item => ({
    evidence_id: item.id,
    source_id: item.source_id,
    publisher: item.publisher,
    title: item.title,
    source_url: item.source_url,
    published_at: item.published_at,
    retrieved_at: item.retrieved_at,
    evidence_grade: item.evidence_grade,
    content_sha256: item.content_sha256,
    snapshot_ref: item.snapshot_ref
  })).sort((left, right) => left.evidence_id.localeCompare(right.evidence_id))
}

function probabilityVectorValid(probabilities) {
  const values = ['risk_up', 'risk_flat', 'risk_down'].map(key => Number(probabilities?.[key]))
  return values.every(value => Number.isFinite(value) && value >= 0 && value <= 1) && Math.abs(values.reduce((sum, value) => sum + value, 0) - 1) <= 0.000001
}

function renderMarkdown(report) {
  const probability = report.probabilities
  const factorRows = report.factors.slice(0, 12).map(factor =>
    `| ${escapeCell(factor.name)} | ${factor.direction} | ${factor.strength} | ${factor.confidence} | ${escapeCell((factor.evidence_refs || []).join(', '))} |`
  ).join('\n')
  const sourceRows = (report.decision_sources || []).map(source =>
    `| ${escapeCell(source.evidence_id)} | ${escapeCell(source.publisher)} | ${escapeCell(source.title)} | ${source.published_at} | ${source.evidence_grade} | ${escapeCell(source.source_url)} | ${source.content_sha256} |`
  ).join('\n')
  const debateFlow = report.debate_summary.termination_reason === 'single_joint_broadcast_revision_calibration_and_program_finalization'
    ? '三席在一次联合判断中同时形成经营方向与风控建议，统一广播后各修订一次，再由单次校准审查与Program终结'
    : '经营方向与风控建议各独立完成一个阶段'
  return `# ${report.company.name} 产业链信用风险报告\n\n` +
    `- 分析日：${report.as_of_date}\n` +
    `- 风险上升 / 持平 / 下降：${probability.risk_up} / ${probability.risk_flat} / ${probability.risk_down}\n` +
    `- 比赛动作：${report.submission_row.action}（-1 收紧，0 维持，1 放宽）\n` +
    `- 风控建议码：${report.submission_row.risk_control_advice}\n\n` +
    `- 经营决策策略解释：${report.decision_strategy.strategy_summary}\n\n` +
    `- 监控模式：${report.monitoring.mode}；仅公开信息：${report.monitoring.public_information_only}；截止日校验：${report.monitoring.cutoff_verified}\n\n` +
    `## 关键因子\n\n| 因子 | 方向 | 强度 | 置信度 | 证据 |\n|---|---:|---:|---:|---|\n${factorRows}\n\n` +
    `## 群组辩证\n\n共 ${report.debate_summary.opinion_count} 个固定席位、${report.debate_summary.self_review_count} 份差异影响自审；不生成或保存席间质疑记录。${debateFlow}；结论模式 ${report.debate_summary.decision_mode}；结论等级 ${report.debate_summary.conclusion_grade}；终止原因 ${report.debate_summary.termination_reason}；重要未决分歧 ${report.debate_summary.unresolved_conflicts} 个。\n\n` +
    `## 数据来源（最终结论引用）\n\n| 证据ID | 发布者 | 标题 | 发布日期 | 等级 | 原文URL | SHA-256 |\n|---|---|---|---|---|---|---|\n${sourceRows}\n\n` +
    `> QA：证据覆盖 ${report.qa.evidence_coverage}；provider=${report.qa.provider_mode}；production_ready=${report.qa.production_ready}。非生产结果只用于联调或确定性基线，不可作为正式经营决策结论。\n`
}

function renderSubmissionCsv(row) {
  const columns = ['company_id', 'action', 'risk_control_advice']
  const values = columns.map(column => csvCell(row[column]))
  return `${columns.join(',')}\n${values.join(',')}\n`
}

function csvCell(value) {
  const text = String(value ?? '')
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

function escapeCell(value) {
  return String(value ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ')
}

module.exports = {
  artifactPaths,
  buildReport,
  buildSourceCatalog,
  collectEvidenceRefs,
  collectDecisionEvidenceRefs,
  finalizeReportQa,
  persistArtifacts,
  probabilityVectorValid,
  renderMarkdown,
  renderSubmissionCsv
}
