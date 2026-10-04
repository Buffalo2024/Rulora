const { normalizeProbabilities } = require('../contracts')
const { expandReviewerSelection } = require('../competition-mode')
const { sha256, softmax } = require('../utils')

const RISK_UP_TERMS = ['下降', '亏损', '承压', '竞争加剧', '毛利率同比有所下降', '延期', '处罚', '失信', '诉讼', '减值', '违约', '下行', '冻结']
const RISK_DOWN_TERMS = ['增长', '改善', '回升', '中标', '支持', '扩产', '提质', '降本增效', '消费促进']

class DeterministicBaselineProvider {
  constructor() {
    this.productionReady = false
    this.mode = 'deterministic_public_evidence_baseline'
  }

  async planIndustry({ agent, caseData }) {
    const chain = inferChain(caseData.company)
    const target = `company:${caseData.company.id}`
    return {
      '执行员': agent.agent_id,
      '产业链': {
        nodes: [
          { id: chain.upstream, name: chain.upstreamLabel, layer: 'upstream' },
          { id: target, name: caseData.company.name, layer: 'target' },
          { id: chain.downstream, name: chain.downstreamLabel, layer: 'downstream' }
        ],
        edges: [
          { from: chain.upstream, to: target, relation: '投入品成本与供给传导', transmission_mechanism: '投入品供需与价格影响采购成本和交付能力。', verification_status: 'hypothesis_pending_public_evidence' },
          { from: target, to: chain.downstream, relation: '需求、交付与回款传导', transmission_mechanism: '终端需求和回款影响收入、应收账款及经营现金流。', verification_status: 'hypothesis_pending_public_evidence' }
        ]
      },
      '传导逻辑': [{ factor_id: 'scope-chain', factor: '经营范围推断的上下游传导', mechanism: '供给、成本、需求和回款最终传导至偿债现金流。', decision_impact: 'two_sided', invalidation_condition: '企业正式披露否认相关投入品或客户行业关系。' }],
      '证据需求': [
        { requirement_id: 'disclosure', claim_scope: '企业经营与现金流事实', query_terms: [caseData.company.name], preferred_source_types: ['company_disclosure'], required: true },
        { requirement_id: 'policy', claim_scope: '行业政策冲击', query_terms: [caseData.company.industry || '产业政策'], preferred_source_types: ['government_policy'], required: true }
      ]
    }
  }

  async decideStage({ agent, phase, caseData, frozenDirection, mode = 'business' }) {
    const opinion = await this.analyze({ agent, caseData })
    const refs = [...new Set(opinion.factors.flatMap(item => item.evidence_refs))]
    const logic = opinion.factors.slice(0, 6).map(item => ({ claim: item.name, mechanism: item.transmission_mechanism, evidence_refs: item.evidence_refs }))
    if (mode === 'competition_calibrated' && phase === 'competition_joint_decision') {
      const advice = opinion.result_candidate === 'risk_up' ? ['2', '4', '8'] : opinion.result_candidate === 'risk_flat' ? ['3'] : ['1', '3']
      return {
        execution_agent: agent.agent_id,
        action_candidate: { risk_up: -1, risk_flat: 0, risk_down: 1 }[opinion.result_candidate],
        action_confidence: 0,
        action_reason: ['确定性基线仅用于有界流程联调。'],
        transmission_evidence: refs,
        threshold_evidence: [],
        counter_evidence: [],
        set_confidence: 0,
        label_assessments: advice.map(code => ({ code, necessary: true, why_required: ['基线候选，仅用于联调。'], why_deletable: ['缺少语义校准。'], counter_evidence: [] })),
        '执行员': agent.agent_id,
        '经营调整方向': opinion.result_candidate,
        '风控建议': advice,
        '逻辑': logic,
        '证据': refs
      }
    }
    if (mode === 'competition_calibrated_v2') return phase === 'decision_direction'
      ? { execution_agent: agent.agent_id, action_candidate: { risk_up: -1, risk_flat: 0, risk_down: 1 }[opinion.result_candidate], action_confidence: 0, action_reason: ['确定性基线仅用于有界流程联调。'], transmission_evidence: refs, threshold_evidence: [], counter_evidence: [], '执行员': agent.agent_id, '经营调整方向': opinion.result_candidate, '逻辑': logic, '证据': refs }
      : { execution_agent: agent.agent_id, set_confidence: 0, label_assessments: [], risk_control_advice: frozenDirection === 'risk_up' ? ['2', '4', '8'] : frozenDirection === 'risk_flat' ? ['3'] : ['1', '3'], '执行员': agent.agent_id, '风控建议': frozenDirection === 'risk_up' ? ['2', '4', '8'] : frozenDirection === 'risk_flat' ? ['3'] : ['1', '3'], '逻辑': logic, '证据': refs }
    return phase === 'decision_direction'
      ? { '执行员': agent.agent_id, '经营调整方向': opinion.result_candidate, '逻辑': logic, '证据': refs }
      : { '执行员': agent.agent_id, '风控建议': frozenDirection === 'risk_up' ? ['2', '4', '8'] : frozenDirection === 'risk_flat' ? ['3'] : ['1', '3'], '逻辑': logic, '证据': refs }
  }

  async reviewStage({ ownDecision }) { return structuredClone(ownDecision) }

  async reviewCalibration({ reviewCandidatePool, champion }) {
    const action = reviewCandidatePool.action_candidates.find(item => item.value === Number(reviewCandidatePool.support_statistics.calibrated_action)) || reviewCandidatePool.action_candidates[0]
    const risk = reviewCandidatePool.risk_candidates[0]
    return expandReviewerSelection({
      selected_action_candidate_id: action.id,
      selected_risk_candidate_id: risk.id,
      challenge_intent: false,
      evidence_strength: 'weak',
      selection_reason: [champion ? '降级基线无权挑战Champion。' : '无Champion可挑战。']
    }, reviewCandidatePool)
  }

  async proposeImprovement({ agent, targetSlotId, allowedMutations, checkpoint, evaluatedCases, scorecardSha256 }) {
    return {
      '执行员': agent.agent_id,
      '目标席位': targetSlotId,
      '选择因子': allowedMutations[0],
      '调整理由': '主模型不可用，按冻结批准因子池选择首个候选并标记降级。',
      '评估依据': { checkpoint, evaluated_cases: evaluatedCases, scorecard_sha256: scorecardSha256 }
    }
  }

  async analyze({ agent, caseData }) {
    const scored = caseData.evidence.map(item => scoreEvidence(item)).sort((left, right) => {
      return Math.abs(right.net) * sourceWeight(right.evidence.source_type) - Math.abs(left.net) * sourceWeight(left.evidence.source_type)
    })
    const sensitivity = {
      bottleneck_causal_graph: 0.95,
      bayesian_factor_event_decay: 1.15,
      adversarial_falsification: 0.72,
      decision_policy: 1
    }[agent.method_family] || 1
    const totalWeight = scored.reduce((sum, item) => sum + gradeWeight(item.evidence.evidence_grade) * sourceWeight(item.evidence.source_type), 0)
    const net = scored.reduce((sum, item) => {
      return sum + gradeWeight(item.evidence.evidence_grade) * sourceWeight(item.evidence.source_type) * item.net
    }, 0) / Math.max(totalWeight, 1)
    const [riskUp, riskFlat, riskDown] = softmax([net * sensitivity, 0.55 - Math.abs(net) * 0.15, -net * sensitivity])
    const probabilities = normalizeProbabilities({ risk_up: riskUp, risk_flat: riskFlat, risk_down: riskDown })
    const factorCandidates = scored.filter(item => item.net !== 0).slice(0, 3)
    const fallbackEvidence = scored.slice(0, 1)
    const factors = (factorCandidates.length ? factorCandidates : fallbackEvidence).map((item, index) => ({
      id: `${agent.agent_id}:baseline:${index + 1}`,
      name: item.evidence.title,
      direction: item.net > 0 ? 'risk_up' : item.net < 0 ? 'risk_down' : 'neutral',
      strength: Math.min(1, 0.35 + Math.abs(item.net) * 0.12),
      confidence: Math.min(0.9, 0.5 + gradeWeight(item.evidence.evidence_grade) * 0.35),
      transmission_mechanism: '公开事件经收入、成本、现金流或融资条件传导至信用风险。',
      horizon_days: Number(caseData.decision_horizon_days) || 180,
      correlation_group: `baseline:${item.evidence.source_type}`,
      evidence_refs: [item.evidence.id],
      invalidation_condition: '若原始公开文件被更正、撤回，或后续同等级来源给出相反事实，则该因子失效。'
    }))
    const chain = inferChain(caseData.company)
    const edgeEvidence = scored.slice(0, 2).map(item => item.evidence.id)
    return {
      agent_id: agent.agent_id,
      agent_version: agent.version,
      method_family: agent.method_family,
      result_candidate: probabilitiesWinner(probabilities),
      probabilities,
      factors,
      chain_map: {
        nodes: [
          { id: chain.upstream, label: chain.upstreamLabel, status: 'inferred_from_public_business_scope' },
          { id: `company:${caseData.company.id}`, label: caseData.company.name, status: 'confirmed' },
          { id: chain.downstream, label: chain.downstreamLabel, status: 'inferred_from_public_business_scope' }
        ],
        edges: [
          { from: chain.upstream, to: `company:${caseData.company.id}`, relation: '投入品成本与供给传导（待企业披露确认具体交易方）', status: 'inferred', chain_layer: 'upstream', transmission_mechanism: '投入品供需与价格改变采购成本、交付能力和经营现金流。', horizon_days: 90, invalidation_condition: '若正式披露否认该投入关系或确认充分替代来源，则该边失效。', evidence_refs: edgeEvidence },
          { from: `company:${caseData.company.id}`, to: chain.downstream, relation: '需求、交付与回款传导（待企业披露确认具体交易方）', status: 'inferred', chain_layer: 'downstream', transmission_mechanism: '客户需求与回款变化影响收入、应收账款和偿债现金流。', horizon_days: 180, invalidation_condition: '若正式披露否认该客户行业关系，则该边失效。', evidence_refs: edgeEvidence }
        ]
      },
      recommended_advice: probabilities.risk_up > probabilities.risk_down
        ? ['2', '4', '8']
        : probabilities.risk_down > probabilities.risk_up ? ['1', '3'] : ['3'],
      thesis: `确定性公开证据基线净风险分为 ${net.toFixed(3)}；该结果用于无模型密钥时验证流程，不能替代经配置的异质大模型辩论。`,
      uncertainties: ['未使用大模型语义推理', '产业链上下游节点仅由公开经营范围推断', '关键词基线未经过隐藏标签校准'],
      baseline_provenance: {
        mode: this.mode,
        evidence_score_sha256: sha256(scored.map(item => ({ id: item.evidence.id, up: item.up, down: item.down })))
      }
    }
  }

  async critique({ agent, targetOpinion, roundNumber = 1 }) {
    return {
      reviewer_id: agent.agent_id,
      target_agent_id: targetOpinion.agent_id,
      checks_performed: ['time_boundary', 'citation_integrity', 'source_independence', 'causal_direction', 'substitution_and_qualification', 'factor_double_counting', 'outcome_support'],
      review_summary: roundNumber === 1 ? '已执行固定生产审查；关键词基线无法完成复杂语义校准。' : '已执行固定生产审查，本轮没有新增问题。',
      challenges: roundNumber === 1 ? [{
        type: 'deterministic_baseline_limit',
        category: 'result_logic_gap',
        impact: 'invalidates_primary_evidence',
        target_result: probabilitiesWinner(targetOpinion.probabilities),
        evidence_refs: [...new Set(targetOpinion.factors.flatMap(factor => factor.evidence_refs))],
        claim: '关键词方向可能忽略否定、比较基数、一次性损益和产业链替代性，因而不能独立支持目标结果。',
        logic_gap: '关键词命中不能证明公开事件通过收入、成本或现金流传导到目标信用结果。',
        requested_test: '用原公告数值、现金流影响和至少一个相反解释进行人工或异质模型复核。'
      }] : [],
      evidence_refs: [...new Set(targetOpinion.factors.flatMap(factor => factor.evidence_refs))]
    }
  }

  async revise({ opinion, critiques, roundNumber = 1 }) {
    return {
      ...opinion,
      thesis: `${opinion.thesis} 经基线局限审查后将关键词传导逻辑标记为未解决。`,
      revision: {
        round: roundNumber,
        critique_count: critiques.length,
        changed: critiques.length > 0,
        rationale: '无大模型语义复核条件下，对关键词基线作保守收缩。',
        responses: critiques.flatMap(critique => critique.challenges).map(challenge => ({
          challenge_id: challenge.challenge_id,
          resolution: 'unresolved',
          rationale: '确定性关键词基线无法完成语义层面的反证检验。',
          remediation: '',
          evidence_refs: []
        }))
      }
    }
  }

  async monitor({ agent, caseData }) {
    const scored = caseData.evidence.map(item => scoreEvidence(item))
    const relevant = scored.filter(item => item.up + item.down > 0).slice(0, 8)
    return {
      agent_id: agent.agent_id,
      relevant_evidence_ids: relevant.map(item => item.evidence.id),
      topic_signals: relevant.slice(0, 4).map(item => ({
        topic: item.evidence.title,
        direction: item.net > 0 ? 'risk_up' : item.net < 0 ? 'risk_down' : 'neutral',
        evidence_refs: [item.evidence.id],
        summary: '确定性关键词仅用于公开证据联调，需由异质模型或人工复核语义。'
      })),
      monitoring_gaps: ['关键词基线不能识别复杂否定、一次性损益和隐含产业链关系'],
      query_refinements: [],
      abstain: relevant.length === 0
    }
  }

  async conclude({ agent, caseData, consensus, debateTermination }) {
    return {
      agent_id: agent.agent_id,
      agent_version: agent.version,
      action: consensus.action,
      risk_control_advice: [...consensus.risk_control_advice],
      strategy_summary: '确定性基线仅解释程序结果，不构成正式经营决策审批意见。',
      rationale: ['未使用语义模型，建议仅用于流程联调。'],
      monitoring_conditions: debateTermination.forced_conclusion ? ['存在未决重要质疑，程序已按固定保守规则输出结论。'] : ['需要配置真实模型后复核。'],
      evidence_refs: caseData.evidence.slice(0, 2).map(item => item.id)
    }
  }
}

function probabilitiesWinner(probabilities) {
  return ['risk_up', 'risk_flat', 'risk_down'].reduce((best, label) => Number(probabilities[label]) > Number(probabilities[best]) ? label : best)
}

function scoreEvidence(evidence) {
  const text = `${evidence.title || ''} ${evidence.summary || ''}`
  const up = RISK_UP_TERMS.reduce((sum, term) => sum + occurrences(text, term), 0)
  const down = RISK_DOWN_TERMS.reduce((sum, term) => sum + occurrences(text, term), 0)
  return { evidence, up, down, net: Math.max(-5, Math.min(5, up - down)) }
}

function occurrences(text, term) {
  return String(text).split(term).length - 1
}

function gradeWeight(grade) {
  return { A: 1, B: 0.8, C: 0.35, D: 0.1 }[grade] || 0
}

function sourceWeight(sourceType) {
  return {
    company_disclosure: 2.5,
    government_credit: 2,
    enterprise_registry: 1.6,
    government_statistics: 0.8,
    official_market_data: 0.8,
    government_policy: 0.35,
    reputable_media: 0.25,
    social_media: 0.05
  }[sourceType] || 0.3
}

function inferChain(company) {
  const text = `${company.industry || ''} ${company.business_scope || ''}`
  if (/家具|家居/.test(text)) {
    return {
      upstream: 'upstream:wood_panels_hardware_chemicals',
      upstreamLabel: '木材/人造板、五金及化工辅料',
      downstream: 'downstream:renovation_distribution_real_estate',
      downstreamLabel: '经销/整装渠道、存量房翻新与房地产需求'
    }
  }
  if (/电子|通信|计算机/.test(text)) {
    return {
      upstream: 'upstream:electronic_components_materials',
      upstreamLabel: '电子元器件与关键材料',
      downstream: 'downstream:equipment_and_end_markets',
      downstreamLabel: '设备集成与终端市场'
    }
  }
  return {
    upstream: 'upstream:public_scope_inferred_inputs',
    upstreamLabel: '经营范围推断的关键投入品',
    downstream: 'downstream:public_scope_inferred_customers',
    downstreamLabel: '经营范围推断的客户与渠道'
  }
}

module.exports = { DeterministicBaselineProvider, inferChain, scoreEvidence, sourceWeight }
