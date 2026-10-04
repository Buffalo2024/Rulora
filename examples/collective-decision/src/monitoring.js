const { round, sha256 } = require('./utils')

function buildMonitoringRecord({ caseData, monitoringConfig, sourceConfig, baselineChainOpinion, runId }) {
  const requestedMode = caseData.monitoring?.mode || 'passive'
  if (!['active', 'passive'].includes(requestedMode)) throw new Error(`unsupported monitoring mode: ${requestedMode}`)
  const competitionCutoff = caseData.competition_cutoff || caseData.as_of_date
  const eligible = []
  const future = []
  const unknownTime = []
  const rejectedNonPublic = []
  const cutoff = new Date(`${competitionCutoff}T23:59:59Z`)
  for (const evidence of caseData.evidence) {
    if (evidence.public !== true) {
      rejectedNonPublic.push(evidence.id)
      continue
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(evidence.published_at || ''))) {
      unknownTime.push(evidence.id)
      continue
    }
    const published = new Date(`${evidence.published_at}T00:00:00Z`)
    if (published > cutoff) future.push(evidence.id)
    else eligible.push(evidence.id)
  }
  if (future.length || unknownTime.length || rejectedNonPublic.length) {
    throw new Error(`monitoring cutoff gate rejected: ${JSON.stringify({ future, unknownTime, rejectedNonPublic })}`)
  }
  const sourceTypes = [...new Set(caseData.evidence.map(item => item.source_type))]
  const chainNodes = (baselineChainOpinion.chain_map?.nodes || []).map(node => typeof node === 'string' ? node : node.id).filter(Boolean)
  const sourceIds = sourceConfig.sources.filter(source => source.default_grade === 'A').map(source => source.id)
  const watchPolicy = requestedMode === 'active'
    ? {
        watch_id: `watch-${sha256(`${caseData.company.id}:${runId}`).slice(0, 16)}`,
        target_company_id: caseData.company.id,
        baseline_run_id: caseData.monitoring?.baseline_run_id || runId,
        watch_entities: [...new Set([caseData.company.name, ...chainNodes])],
        watch_topics: caseData.monitoring?.watch_topics || ['供需变化', '价格与库存', '重大合同', '产能与认证', '处罚失信', '政策调整'],
        source_ids: caseData.monitoring?.source_ids || sourceIds,
        query_templates: structuredClone(caseData.monitoring?.queries || []),
        schedule: caseData.monitoring?.schedule || monitoringConfig.active.default_schedule,
        competition_cutoff: competitionCutoff,
        trigger_conditions: monitoringConfig.active.alert_conditions,
        change_detection: ['canonical_url', 'content_sha256']
      }
    : null
  return {
    monitor_agent_id: 'public_evidence_monitor',
    participates_in_prediction: false,
    mode: requestedMode,
    public_information_only: true,
    competition_cutoff: competitionCutoff,
    eligible_evidence_ids: eligible,
    quarantined_evidence_ids: { future, unknown_time: unknownTime },
    rejected_non_public_ids: rejectedNonPublic,
    source_types: sourceTypes,
    source_type_count: sourceTypes.length,
    evidence_coverage: round(eligible.length / Math.max(caseData.evidence.length, 1)),
    cutoff_verified: true,
    watch_policy: watchPolicy,
    created_at: new Date().toISOString()
  }
}

module.exports = { buildMonitoringRecord }
