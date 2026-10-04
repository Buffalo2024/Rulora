// Synthetic inputs and scripted model responses: protocol testing only, not predictive evidence.
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { sha256 } = require('../../src/utils')

const question = { question: '甲公司未来两年储能业务的前景和行动条件如何？', subject: '甲公司', matter: '储能业务', time_range: '未来两年' }

async function fixture({ outputDirectory } = {}) {
  const root = outputDirectory ? path.resolve(outputDirectory) : await fs.mkdtemp(path.join(os.tmpdir(), 'rulora-enterprise-'))
  const snapshotRoot = path.join(root, 'snapshots')
  await fs.mkdir(snapshotRoot, { recursive: true })
  const make = async (id, sourceId, publisher, sourceType, url) => {
    const content = Buffer.from(`${id} original public document`)
    const hash = sha256(content)
    await fs.writeFile(path.join(snapshotRoot, `${hash}.bin`), content)
    return { id, ingestion_mode: 'validated_manual_import', source_id: sourceId, publisher, source_type: sourceType, source_url: url, title: `${id}的独立披露`, summary: `${id}与储能业务相关的已公开信息`, published_at: '2026-09-01', retrieved_at: '2026-09-24T10:00:00.000Z', evidence_grade: 'A', content_sha256: hash, snapshot_ref: `${hash}.bin`, public: true }
  }
  const evidence = [await make('E1', 'cninfo', '巨潮资讯', 'company_disclosure', 'https://www.cninfo.com.cn/new/e1'), await make('E2', 'government_policy', '国务院', 'government_policy', 'https://www.gov.cn/zhengce/e2')]
  return { root, caseData: { contract_version: '1.0.0', case_id: 'enterprise-test-001', company: { id: '001', name: '甲公司' }, as_of_date: '2026-09-24', evidence, evidence_snapshot_root: snapshotRoot } }
}

function enrichCandidate(candidate, stage) {
  if(stage==='condition')candidate={...candidate,actions:(candidate.actions||[]).map(a=>({...a,...(require('../../src/enterprise-action-contract').OBJECT_BOUNDARIES[a.id]||{})}))}
  return { ...candidate, seat_summary: candidate.reason,
    ...(stage === 'condition' ? { label_assessments: candidate.recommendations.filter(require('../../src/enterprise-action-contract').isActualAction).map(code=>({ code, necessary: true, why_required: ['公开证据支持该行动'], why_deletable: ['触发条件不成立时可删除'], counter_evidence: [], evidence_refs: candidate.evidence_refs })), combination_reason: '完整组合服务于冻结方向，条件满足后执行' } : {}) }
}
function exchangeResult(input, candidate = null) {
  return { review_decision: candidate ? 'revise' : 'maintain', ...(candidate ? {revision_kind:'substantive'} : {}), broadcast_version: input.broadcast_version, review_summary: candidate ? '根据同行依据调整完整候选' : '已审阅四席意见，维持完整候选', candidate }
}
function reviewResult({stage,prompt}, overrides = {}) {
  const input = JSON.parse(prompt[1].content)
  const value = { consistent: true, selected_seat_id: stage === 'direction' ? 'demand_growth':'technology_fit', unresolved_gaps: [], authority:'within_rules', applied_rule_ids:['SUPPORTED_WHOLE_CANDIDATE'], review_reason:'依据既定规则选择完整候选', ...overrides }
  const selectedAlias=prompt.reference_binding?.candidate_entries?.find(c=>c.id===value.selected_seat_id)
  if(selectedAlias)value.selected_seat_id=selectedAlias.alias
  else if(!Object.hasOwn(overrides,"selected_seat_id") && input.candidates.every(c=>/^candidate_\d+$/.test(c.seat_id)))value.selected_seat_id=input.candidates[0].seat_id
  value.candidate_reviews = input.candidates.map(c=>({seat_id:c.seat_id, independence:'independent', assessment:value.consistent?'supported':'uncertain', reason:'核对证据、反证与前提', ...(stage==='condition'?{action_reviews:c.recommendations.filter(require('../../src/enterprise-action-contract').isActualAction).map(id=>({id,assessment:value.consistent?'supported':'uncertain',direction_assessment:'compatible',necessity:'required',omission_impact:'删去后关键现金风险无人处理',reason:'必要性与可删性已复核',basis_status:'established',residual_risk_source:'known_fact',known_basis:'已披露现金流压力',countercheck_status:'adequate',deletion_case:'已知现金安排可能覆盖部分风险',retention_response:'存量逾期款仍需处理'})),boundary_reviews:c.recommendations.filter(require('../../src/enterprise-action-contract').isActualAction).flatMap((id,i,ids)=>ids.slice(i+1).map(other=>({action_ids:[id,other],relationship:'independent',reason:'各自剩余作用不同'}))),timing_reviews:require('../../src/enterprise-action-audit').flaggedAdditions(input.action_history||[],c).map(h=>({code:h.code,assessment:'independent',reason:'本席有独立已知缺口与证据'})),...(c.recommendations.length===1&&c.recommendations[0]===13?{no_action_review:{assessment:'supported',direction_assessment:'compatible',reason:'已有安排有独立证据且足以支持冻结方向'}}:{}),combination_direction_assessment:'compatible',task_coverage:c.actions.length?'sufficient':'not_applicable',issues:[],combination_assessment:c.actions.length?'compatible':'not_applicable',combination_reason:'按完整方案判断'}:{})}))
  if(stage==='condition'){value.selection_mode=value.consistent?'equivalent_choice':'no_selection';for(const row of value.candidate_reviews)row.comparison_to_selected={relation:row.seat_id===value.selected_seat_id?'selected':'not_comparable',shared_object:null,quality_basis:null,alternative_object:'own concrete operating exposure',reason:'independent scope; no cross-scope ranking'}}
  return value
}

function fakeProvider({ split = false, noProgress = false } = {}) {
  const calls = []
  return {
    calls,
    async enterpriseEvidenceScreen() { calls.push({ operation: 'screen' }); return { relevant_evidence_ids: ['E1', 'E2'], reasons_by_id: { E1: '企业经营材料', E2: '行业政策材料' }, gaps: [] } },
    async enterpriseDecision({ agent, stage, prompt, review }) {
      const input = JSON.parse(prompt[1].content)
      calls.push({ operation: review ? 'review' : 'initial', stage, seat: agent.agent_id, prior: input.frozen_direction, evidence_summary_lengths: (input.evidence || []).map(item => (item.core_facts || []).reduce((n,p)=>n+p.quote.length,0)) })
      const initialDissent = split && agent.agent_id === 'supply_competition' && (!review || noProgress)
      const code = stage === 'direction' ? initialDissent ? 0 : 1 : -1
      const ref = stage === 'direction' ? 'E1' : 'E2'
      const candidate = enrichCandidate({ ...(stage === 'direction' ? { direction: code } : { recommendations: [3], actions: [{ id: 3, target: '甲公司', scope: 'overall', time_range: '未来12个月', action: '核对应收账龄并按月编制现金预算', effect: 'protect', readiness: 'conditional', prerequisites: ['核实内部应收账龄'], evidence_refs: [ref], direction_relation: '现金管理支持稳健拓展' }] }), reason: `依据${ref}`, evidence_refs: [ref], gaps: [], assumptions: [], factors: [{ name: stage === 'direction' ? '需求' : '限制', mechanism: `由${ref}支持`, effect: stage === 'direction' ? 'positive' : 'negative', evidence_refs: [ref], counter_evidence_refs: [] }], ...(stage === 'condition' ? { direction_version: input.frozen_direction.version } : {}) }, stage)
      return review ? exchangeResult(input, split && !noProgress && stage === 'direction' && input.own.direction !== code ? candidate : null) : candidate
    },
    async enterpriseReview({ stage, prompt }) { calls.push({ operation: 'semantic', stage }); return reviewResult({stage,prompt}) }
  }
}

module.exports = { question, fixture, enrichCandidate, exchangeResult, reviewResult, fakeProvider }
