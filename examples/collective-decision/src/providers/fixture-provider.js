const { normalizeProbabilities } = require('../contracts')
const { expandReviewerSelection } = require('../competition-mode')
const { sha256 } = require('../utils')

class FixtureProvider {
  async planIndustry({ agent, caseData }) {
    const target = `company:${caseData.company.id}`
    return {
      '执行员': agent.agent_id,
      '产业链': {
        nodes: [
          { id: 'upstream:key_inputs', name: '关键投入品', layer: 'upstream' },
          { id: target, name: caseData.company.name, layer: 'target' },
          { id: 'downstream:key_demand', name: '关键客户与终端需求', layer: 'downstream' }
        ],
        edges: [
          { from: 'upstream:key_inputs', to: target, relation: '投入品供给与成本', transmission_mechanism: '供给和价格经采购成本与产能利用率传导。', verification_status: 'hypothesis_pending_public_evidence' },
          { from: target, to: 'downstream:key_demand', relation: '需求与回款', transmission_mechanism: '需求和回款经收入与经营现金流传导。', verification_status: 'hypothesis_pending_public_evidence' }
        ]
      },
      '传导逻辑': [{ factor_id: 'input-demand-cashflow', factor: '供需与现金流传导', mechanism: '上下游冲击最终落到收入、毛利和偿债现金流。', decision_impact: 'two_sided', invalidation_condition: '公开证据否认相关投入或客户关系。' }],
      '证据需求': [
        { requirement_id: 'company-disclosure', claim_scope: '企业经营、合同、客户供应商与财务变化', query_terms: [caseData.company.name], preferred_source_types: ['company_disclosure'], required: true },
        { requirement_id: 'industry-policy', claim_scope: '适用产业政策与行业冲击', query_terms: [caseData.company.industry || '产业政策'], preferred_source_types: ['government_policy'], required: true }
      ]
    }
  }

  async decideStage({ agent, phase, caseData, frozenDirection, mode = 'business' }) {
    const opinion = await this.analyze({ agent, caseData })
    const refs = [...new Set(opinion.factors.flatMap(item => item.evidence_refs))]
    const logic = opinion.factors.slice(0, 6).map(item => ({ claim: item.name, mechanism: item.transmission_mechanism, evidence_refs: item.evidence_refs }))
    const advice = frozenDirection === 'risk_up' ? ['4', '8'] : frozenDirection === 'risk_flat' ? ['3'] : ['1', '3']
    if (['competition_calibrated', 'competition_calibrated_v2'].includes(mode)) {
      const candidateAdvice = opinion.result_candidate === 'risk_up' ? ['4', '8'] : opinion.result_candidate === 'risk_flat' ? ['3'] : ['1', '3']
      if (phase === 'competition_joint_decision') return {
        execution_agent: agent.agent_id,
        action_candidate: { risk_up: -1, risk_flat: 0, risk_down: 1 }[opinion.result_candidate],
        action_confidence: 0.55,
        action_reason: ['Fixture验证联合传导、经营门槛与必要标签字段。'],
        transmission_evidence: refs,
        threshold_evidence: refs,
        counter_evidence: [],
        set_confidence: 0.55,
        label_assessments: candidateAdvice.map(code => ({ code, necessary: true, why_required: ['Fixture必要性测试。'], why_deletable: [], counter_evidence: [] })),
        '执行员': agent.agent_id,
        '经营调整方向': opinion.result_candidate,
        '风控建议': candidateAdvice,
        '逻辑': logic,
        '证据': refs
      }
      return phase === 'decision_direction'
        ? { execution_agent: agent.agent_id, action_candidate: { risk_up: -1, risk_flat: 0, risk_down: 1 }[opinion.result_candidate], action_confidence: 0.55, action_reason: ['Fixture验证传导与经营门槛字段。'], transmission_evidence: refs, threshold_evidence: refs, counter_evidence: [], '执行员': agent.agent_id, '经营调整方向': opinion.result_candidate, '逻辑': logic, '证据': refs }
        : { execution_agent: agent.agent_id, risk_control_advice: advice, set_confidence: 0.55, label_assessments: advice.map(code => ({ code, necessary: true, why_required: ['Fixture必要性测试。'], why_deletable: [], counter_evidence: [] })), '执行员': agent.agent_id, '风控建议': advice, '逻辑': logic, '证据': refs }
    }
    return phase === 'decision_direction'
      ? { '执行员': agent.agent_id, '经营调整方向': opinion.result_candidate, '逻辑': logic, '证据': refs }
      : { '执行员': agent.agent_id, '风控建议': advice, '逻辑': logic, '证据': refs }
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
      selection_reason: [champion ? 'Fixture保留Champion烟测。' : 'Fixture验证候选ID选择。']
    }, reviewCandidatePool)
  }

  async proposeImprovement({ agent, targetSlotId, allowedMutations, checkpoint, evaluatedCases, scorecardSha256 }) {
    return {
      '执行员': agent.agent_id,
      '目标席位': targetSlotId,
      '选择因子': allowedMutations[0],
      '调整理由': 'Fixture验证改善席模型调用、批准因子池和程序应用门禁。',
      '评估依据': { checkpoint, evaluated_cases: evaluatedCases, scorecard_sha256: scorecardSha256 }
    }
  }

  async analyze({ agent, caseData }) {
    const offset = deterministicOffset(`${caseData.case_id}:${agent.agent_id}`)
    const base = caseData.fixture_probabilities || { risk_up: 0.54, risk_flat: 0.28, risk_down: 0.18 }
    const evidenceRefs = caseData.evidence.slice(0, 2).map(item => item.id)
    const probabilities = normalizeProbabilities({
      risk_up: base.risk_up + offset,
      risk_flat: base.risk_flat - offset / 2,
      risk_down: base.risk_down - offset / 2
    })
    const companyNode = `company:${caseData.company.id}`
    const upstreamNode = caseData.chain_seed?.upstream || 'upstream:key_supplier'
    const downstreamNode = caseData.chain_seed?.downstream || 'downstream:key_customer'
    return {
      agent_id: agent.agent_id,
      agent_version: agent.version,
      method_family: agent.method_family,
      result_candidate: probabilitiesWinner(probabilities),
      probabilities,
      factors: [
        {
          id: `${agent.agent_id}:f1`,
          name: caseData.fixture_factor_name || '关键投入品供给与价格冲击',
          direction: 'risk_up',
          strength: 0.72,
          confidence: 0.74,
          transmission_mechanism: '关键投入品冲击经采购成本、毛利率和经营现金流传导至偿债能力。',
          horizon_days: Number(caseData.decision_horizon_days) || 180,
          correlation_group: 'input_cost_and_supply',
          evidence_refs: evidenceRefs,
          invalidation_condition: '若经两个独立高等级来源确认供应恢复且成本传导被完全吸收，则该因子失效。'
        }
      ],
      chain_map: {
        nodes: [
          { id: upstreamNode, label: '关键上游' },
          { id: companyNode, label: caseData.company.name },
          { id: downstreamNode, label: '关键下游' }
        ],
        edges: [
          { from: upstreamNode, to: companyNode, relation: '供给与成本传导', status: 'inferred', chain_layer: 'upstream', transmission_mechanism: '投入品价格和可得性影响采购成本与产能利用率。', horizon_days: 90, invalidation_condition: '若公开披露确认不存在该投入关系或已有充分替代来源，则该边失效。', evidence_refs: evidenceRefs },
          { from: companyNode, to: downstreamNode, relation: '交付与回款传导', status: 'inferred', chain_layer: 'downstream', transmission_mechanism: '终端需求和客户付款能力影响收入、应收账款和经营现金流。', horizon_days: 180, invalidation_condition: '若公开披露确认客户结构与该下游无关，则该边失效。', evidence_refs: evidenceRefs }
        ]
      },
      recommended_advice: probabilities.risk_up >= probabilities.risk_down ? ['4', '8'] : ['1', '3'],
      thesis: `${agent.label}认为主要风险来自产业链冲击向经营现金流和偿债能力的传导。`,
      uncertainties: ['公开证据可能无法完全覆盖非公开合同条款', '传导时滞仍需后续结果验证']
    }
  }

  async critique({ agent, targetOpinion, roundNumber = 1 }) {
    return {
      reviewer_id: agent.agent_id,
      target_agent_id: targetOpinion.agent_id,
      checks_performed: ['time_boundary', 'citation_integrity', 'source_independence', 'causal_direction', 'substitution_and_qualification', 'factor_double_counting', 'outcome_support'],
      review_summary: roundNumber === 1 ? '已完成七项固定生产审查并发现因子相关性问题。' : '已完成七项固定生产审查，本轮未发现新的重要问题。',
      challenges: roundNumber === 1 ? [
        {
          type: agent.method_family === 'adversarial_falsification' ? 'falsification' : 'calibration',
          category: 'factor_double_counting',
          impact: 'changes_result',
          target_result: probabilitiesWinner(targetOpinion.probabilities),
          evidence_refs: [...new Set(targetOpinion.factors.flatMap(factor => factor.evidence_refs))],
          claim: '目标意见可能高估单一风险因子的独立性，且未充分量化替代来源和传导时滞。',
          logic_gap: '同源因子若被重复计量，证据到结果的传导强度不成立。',
          requested_test: '检查重复证据、替代供应商资格周期及反向现金流缓释。'
        }
      ] : [],
      evidence_refs: [...new Set(targetOpinion.factors.flatMap(factor => factor.evidence_refs))]
    }
  }

  async revise({ agent, opinion, critiques, roundNumber = 1 }) {
    const challenged = critiques.some(critique => critique.challenges.length > 0)
    return {
      ...opinion,
      thesis: challenged ? `${opinion.thesis} 经交叉质疑后明确去重规则和替代性失效条件。` : opinion.thesis,
      revision: {
        round: roundNumber,
        critique_count: critiques.length,
        changed: challenged,
        rationale: challenged ? '对因子相关性和替代性证据作保守修正。' : '未收到有效质疑。',
        responses: critiques.flatMap(critique => critique.challenges).map(challenge => ({
          challenge_id: challenge.challenge_id,
          resolution: 'accepted',
          rationale: '接受质疑并修正证据去重与传导逻辑。',
          remediation: '明确同源因子只计一次，并补充替代来源的失效条件。',
          evidence_refs: [...new Set(opinion.factors.flatMap(factor => factor.evidence_refs))]
        }))
      }
    }
  }

  async monitor({ agent, caseData }) {
    const relevant = caseData.evidence.slice(0, 3).map(item => item.id)
    return {
      agent_id: agent.agent_id,
      relevant_evidence_ids: relevant,
      topic_signals: relevant.length ? [{
        topic: '公开证据变化',
        direction: 'neutral',
        evidence_refs: relevant,
        summary: 'Fixture 仅验证监控字段与非投票边界。'
      }] : [],
      monitoring_gaps: ['Fixture 不代表真实来源覆盖'],
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
      strategy_summary: 'Fixture 仅验证程序冻结结论到经营决策策略解释的字段边界。',
      rationale: ['action 和建议码完全继承程序聚合结果，结论角色不参与投票。'],
      monitoring_conditions: debateTermination.forced_conclusion ? ['本结论由固定保守规则强制收敛，应持续监控未决质疑对应公开证据。'] : [],
      evidence_refs: caseData.evidence.slice(0, 2).map(item => item.id)
    }
  }
}

function probabilitiesWinner(probabilities) {
  return ['risk_up', 'risk_flat', 'risk_down'].reduce((best, label) => Number(probabilities[label]) > Number(probabilities[best]) ? label : best)
}

function deterministicOffset(seed) {
  const integer = parseInt(sha256(seed).slice(0, 8), 16)
  return ((integer % 9) - 4) / 100
}

module.exports = { FixtureProvider }
