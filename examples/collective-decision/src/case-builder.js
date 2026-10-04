const { sha256 } = require('./utils')

function buildCompanyCase({ companyRecord, evidencePacket, monitoringMode = 'passive' }) {
  if (!companyRecord?.company_id || !companyRecord?.company_name) throw new Error('company record lacks company_id/company_name')
  if (!evidencePacket?.as_of_date || !Array.isArray(evidencePacket.evidence)) throw new Error('valid evidence packet is required')
  const sourceTypes = new Set(evidencePacket.evidence.map(item => item.source_type))
  if (sourceTypes.size < 2) {
    const available = [...sourceTypes].filter(Boolean)
    const error = new Error(`公开证据不足：当前取得${evidencePacket.evidence.length}条证据，但仅覆盖${available.length || 0}类公开来源（${available.join('、') || '无有效来源'}）；正式分析至少需要2类相互独立的公开来源。任务已关闭，未进入三席分析。`)
    error.code = 'EVIDENCE_SOURCE_DIVERSITY_INSUFFICIENT'
    throw error
  }
  const companyId = String(companyRecord.company_id).padStart(3, '0')
  return {
    contract_version: '1.0.0',
    case_id: `contest-${companyId}-${evidencePacket.as_of_date}`,
    as_of_date: evidencePacket.as_of_date,
    competition_cutoff: evidencePacket.as_of_date,
    evidence_snapshot_root: evidencePacket.snapshot_root,
    company: {
      id: companyId,
      name: companyRecord.company_name,
      industry: companyRecord.industry,
      province: companyRecord.province,
      city: companyRecord.city,
      enterprise_type: companyRecord.enterprise_type,
      unified_social_credit_code: companyRecord.unified_social_credit_code,
      website: companyRecord.website,
      business_scope: companyRecord.business_scope
    },
    evidence: evidencePacket.evidence,
    monitoring: {
      mode: monitoringMode,
      source_ids: evidencePacket.source_runs.filter(run => ['available', 'partial'].includes(run.status)).map(run => run.source_id),
      queries: structuredClone(evidencePacket.query_templates || []),
      watch_topics: ['行业供需', '原材料与库存', '经营业绩', '重大合同', '产能与渠道', '处罚失信', '产业政策']
    },
    provenance: {
      evidence_packet_sha256: evidencePacket.packet_sha256 || sha256(evidencePacket),
      public_information_only: true,
      generated_at: new Date().toISOString()
    }
  }
}

function findCompanyRecord(dataset, companyId) {
  const wanted = String(companyId).padStart(3, '0')
  const record = (dataset.records || []).find(item => String(item.company_id).padStart(3, '0') === wanted)
  if (!record) throw new Error(`company ${wanted} was not found in validation dataset`)
  return record
}

function refreshCaseFromEvidencePacket({ baseCase, evidencePacket }) {
  if (!baseCase?.company?.id || !baseCase?.as_of_date) throw new Error('valid base case is required')
  if (evidencePacket?.status !== 'complete') throw new Error('evidence packet is not complete; resolve all manual assistance first')
  if (!Array.isArray(evidencePacket.evidence) || evidencePacket.evidence.length === 0) throw new Error('complete evidence packet has no evidence')
  if (String(evidencePacket.company?.id) !== String(baseCase.company.id)) throw new Error('evidence packet company does not match base case')
  if (evidencePacket.as_of_date !== baseCase.as_of_date) throw new Error('evidence packet as_of_date does not match base case')
  const sourceTypes = new Set(evidencePacket.evidence.map(item => item.source_type))
  if (sourceTypes.size < 2) throw new Error('refreshed production case requires at least two public source types')
  const output = structuredClone(baseCase)
  output.evidence = structuredClone(evidencePacket.evidence)
  output.evidence_snapshot_root = evidencePacket.snapshot_root
  output.competition_cutoff = output.as_of_date
  output.monitoring = {
    ...(output.monitoring || {}),
    source_ids: evidencePacket.source_runs.filter(run => ['available', 'partial'].includes(run.status)).map(run => run.source_id),
    queries: structuredClone(evidencePacket.query_templates || [])
  }
  output.provenance = {
    ...(output.provenance || {}),
    evidence_packet_sha256: evidencePacket.packet_sha256 || sha256(evidencePacket),
    public_information_only: true,
    refreshed_at: new Date().toISOString()
  }
  delete output.collection_request
  return output
}

module.exports = { buildCompanyCase, findCompanyRecord, refreshCaseFromEvidencePacket }
