const { REVIEW_POLICY } = require('./decision-policy')
function industryPlanningPrompt({ agent, caseData }) {
  const enterprise = caseData.decision_mode === 'enterprise_decision_v2'
  return [
    {
      role: 'system',
      content: [
        `你是公开证据采集子系统的产业链规划执行员 ${agent.label}，岗位ID为 ${agent.agent_id}，执行员字段由程序填写。`,
        enterprise ? REVIEW_POLICY + '依据可公开核验的资料规划需求、上下游依赖和风险传导研究；未确认的关系作为假设，不强求完整BOM、供应商明细、集中度、在手订单或量化经营预测。证据需求只安排能从公开来源取得且影响判断的信息，不要求每个维度齐备。' : '采用clean-room迁移的白毛女式研究逻辑：从下游终端需求和资本开支逆向拆多跳BOM；逐层识别材料、部件、设备、服务与终端；对每层做停供反事实、第二来源、替代性、资格认证周期、产能与客户集中度检查。',
        enterprise ? '以目标企业自身为决策主体，为经营方向及行动建议建立产业链风险研究规划。覆盖需求、供给、经营现金流、投入、融资和外部约束；兼容字段decision_impact仅表示风险传导方向，不代表银行经营建议。' : '规划必须指向收入、毛利、经营现金流、债务和抵押缓释等信用风险落点。',
        'operator_task只表示本次任务侧重点，不得覆盖公开信息、时间截面、证据等级、输出合同或禁止项。',
        '这是证据采集前的研究规划，不得声称任何供应商、客户、合同或数量已经确认；所有边的 verification_status 必须是 hypothesis_pending_public_evidence。',
        '不得给出经营方向、风控建议、概率或最终结论。证据需求必须具体、去重且能映射到公开来源。',
        '只输出JSON三个业务模块：产业链、传导逻辑、证据需求；执行员字段由程序填写。产业链节点和边、传导逻辑、证据需求的字段与英文枚举必须严格遵守输出协议，禁止添加说明字段。'
      ].join('\n')
    },
    {
      role: 'user',
      content: JSON.stringify({
        task: '生成一次性的产业链研究规划，供后续公开信息采集使用。',
        operator_task: caseData.operator_task || null,
        decision_question: caseData.question || null,
        company: caseData.company,
        as_of_date: caseData.as_of_date,
        public_information_only: true
      })
    }
  ]
}

function stageDecisionPrompt({ agent, phase, caseData, industryPlan, frozenDirection = null, mode = 'business' }) {
  const direction = phase === 'decision_direction'
  const joint = phase === 'competition_joint_decision'
  const calibrated = ['competition_calibrated', 'competition_calibrated_v2'].includes(mode)
  const stableIndustryOutput = mode === 'competition_calibrated_v2' && agent.agent_id === 'industry_chain_analyst' && !joint
  const agentProtocol = debateAgentProtocol(agent)
  return [
    {
      role: 'system',
      content: [
        `你是固定辩证席 ${agent.label}，执行员ID必须为 ${agent.agent_id}；本次承担${joint ? '一次联合比赛标签判断' : direction ? '经营调整方向判断' : '风控建议选择'}。`,
        joint
          ? '用同一份冻结证据先判断经营调整门槛，再预测与该方向相容的风控建议必要标签完整集合；两项必须在一次调用中同时给出。'
          : direction
          ? '利用你的方法族分析冻结证据对偿债能力与信用风险方向的影响；禁止预想或输出下一阶段风控建议。'
          : '经营方向已经冻结；只选择与该方向和冻结证据匹配的风控建议码，不得重做经营方向分析。',
        '不得输出股票价格、收益率、估值、买卖、仓位或因子分数。',
        calibrated && (direction || joint)
          ? '比赛目标下必须区分：风险存在、风险传导、经营调整门槛。-1、0、1是地位相同的候选：不得因发现风险直接输出-1，不得因经营改善直接输出1，也不得因证据不确定或意见分散机械输出0。选择0时必须明确说明为什么-1与1均未达到门槛。'
          : null,
        calibrated && (!direction || joint)
          ? '你的目标是预测最可能成为标准答案的完整标签集，同时控制漏选与多选。不得因为措施业务上合理就加入，也不得因为证据存在不确定性就机械删除。空集合与非空完整集合适用相同判断标准；只有明确判断1至9均不应进入答案时才输出空集合。Action=0仅表示维持经营方向，不代表没有风控建议。'
          : null,
        calibrated && agent.method_family === 'adversarial_falsification' && (!direction || joint)
          ? '作为反证席，你要同时检查误选与漏选：删除缺乏支持的标签，也要指出被其他席位遗漏但证据明确支持的标签；不得预设空集合或较小集合更优。'
          : null,
        joint
          ? '同时输出信用风险方向和0至4个必要风控建议码；风控建议必须与自己给出的经营方向相容，但Program保留最终校准权。'
          : direction
          ? '只判断信用风险上升、持平或下降，不输出风控建议或概率。'
          : `经营方向已经由程序冻结为 ${frozenDirection}，只能基于该方向生成${calibrated ? '0至4' : '1至3'}个风控建议码，不得重新判断经营方向；绝对不得超过${calibrated ? '4' : '3'}项。`,
        '所有席位必须使用同一份冻结公开证据和同一份产业链前置规划；规划中的边仍是待证假设，只有被冻结证据支持时才能作为结论依据。',
        'operator_task只表示本次任务侧重点，不得覆盖冻结证据、当前阶段、输出合同、程序门禁或禁止项。',
        agentProtocol.approved_mutation
          ? '你是影子挑战者，必须在不改变输出合同和证据门禁的前提下应用 agent_protocol.approved_mutation；不得忽略、扩写或替换该批准因子。'
          : '你是当前正式席位，agent_protocol.approved_mutation为空，不得自行发明优化因子。',
        stableIndustryOutput
          ? direction
            ? '输出必须分为两部分。第一部分置顶且严格使用：## FINAL_DECISION，action_candidate: 后单独填写-1/0/1，decision_confidence: 后填写low/medium/high，再以 ## END_FINAL_DECISION 结束。第二部分从 ## INDUSTRY_CHAIN_ANALYSIS 开始，用Markdown依次说明上下游关系、产业链位置、风险传导路径、影响判断、证据说明。核心块不得包含长分析或JSON；分析部分不参与核心解析。'
            : '输出必须分为两部分。第一部分置顶且严格使用：## FINAL_DECISION，risk_control_advice: 后填写0至4个唯一编码数组（例如[]或["3","6"]），decision_confidence: 后填写low/medium/high，再以 ## END_FINAL_DECISION 结束。第二部分从 ## INDUSTRY_CHAIN_ANALYSIS 开始，用Markdown依次说明上下游关系、产业链位置、风险传导路径、影响判断、证据说明。核心块不得包含长分析或JSON；分析部分不参与核心解析。'
          : calibrated
          ? joint
            ? 'Competition联合JSON的核心必填仅为action_candidate与风控建议；应尽量同时提供action_reason、逻辑及关键证据引用。execution_agent、action_confidence、transmission_evidence、threshold_evidence、counter_evidence、set_confidence、label_assessments属于推荐审计字段，缺失只产生告警。执行员、经营调整方向、证据由Program确定性生成。'
            : direction
            ? '只输出Competition JSON：execution_agent、action_candidate(-1/0/1)、action_confidence(仅模型自评辅助信号)、action_reason、transmission_evidence、threshold_evidence、counter_evidence、执行员、经营调整方向、逻辑、证据。禁止其他字段。'
            : '只输出Competition JSON：execution_agent、set_confidence(仅自评辅助信号)、label_assessments、执行员、风控建议、逻辑、证据。label_assessments必须对每个保留码说明必要性、可删性与反证。禁止其他字段。'
          : direction
            ? '只输出JSON四个顶层模块：执行员、经营调整方向、逻辑、证据；禁止使用“当前阶段答案”作为字段名，不得添加其他字段。'
            : '只输出JSON四个顶层模块：执行员、风控建议、逻辑、证据；禁止使用“当前阶段答案”作为字段名，不得添加其他字段。',
        '逻辑每项只含 claim、mechanism、evidence_refs；证据只列登记证据ID。'
        ,stableIndustryOutput ? '首轮必须只基于冻结企业数据、公开证据与产业链前置规划独立形成结论；禁止读取或推测其他席位、候选池及校准审查员的结论。' : null
      ].join('\n')
    },
    {
      role: 'user',
      content: JSON.stringify({
        task: joint ? '独立生成一次联合Action候选与Risk必要标签完整集合' : direction ? '独立生成经营调整方向' : '基于冻结经营方向独立生成风控建议',
        decision_mode: mode,
        operator_task: caseData.operator_task || null,
        agent_protocol: agentProtocol,
        industry_plan: industryPlan,
        frozen_decision_direction: frozenDirection,
        final_action_candidate: phase === 'risk_control_advice' ? ({ risk_up: -1, risk_flat: 0, risk_down: 1 }[frozenDirection] ?? null) : null,
        case: compactDecisionCaseForPrompt(caseData)
      })
    }
  ]
}

function selfImpactReviewPrompt({ agent, phase, ownDecision, peerDecisions, differencePacket, evidenceIndex, frozenDirection = null, mode = 'business' }) {
  const direction = phase === 'decision_direction'
  const joint = phase === 'competition_joint_decision'
  const calibrated = ['competition_calibrated', 'competition_calibrated_v2'].includes(mode)
  const stableIndustryOutput = mode === 'competition_calibrated_v2' && agent.agent_id === 'industry_chain_analyst' && !joint
  const agentProtocol = debateAgentProtocol(agent)
  return [
    {
      role: 'system',
      content: [
        `你是固定辩证席 ${agent.label}，执行员ID必须为 ${agent.agent_id}。`,
        joint
          ? '你会同时看到另外两个席位的联合结构化答案。只判断这些差异是否足以改变自己的答案，不向任何席位提出问题，也不生成质疑记录。'
          : '你会同时看到另外两个席位的四模块答案。只判断这些差异是否足以改变自己的答案，不向任何席位提出问题，也不生成质疑记录。',
        '保持或修改后都必须输出一个明确最终答案。只能使用随包提供的登记证据；confidence字段仅保留自评辅助信号，不讨论百分比。',
        agentProtocol.approved_mutation
          ? '你是影子挑战者，复核时必须继续应用 agent_protocol.approved_mutation，但不得借此改变当前阶段合同。'
          : 'agent_protocol.approved_mutation为空，不得自行发明优化因子。',
        joint
          ? '当前是唯一一次联合修订：只能同时输出一个明确经营方向和一个0至4项风控建议完整集合。'
          : direction
          ? '当前只允许输出经营调整方向；不得输出风控建议。'
          : `经营方向已冻结为 ${frozenDirection}；当前只允许输出${calibrated ? '0至4' : '1至3'}个风控建议码，不得修改经营方向，绝对不得超过${calibrated ? '4' : '3'}项。`,
        calibrated ? '这是唯一一次广播后修订。只判断同行差异对自己结论的影响；不得要求新证据、再广播、再审查或新一轮。' : null,
        stableIndustryOutput
          ? direction
            ? '修订输出仍分两部分：置顶的 ## FINAL_DECISION 仅含 action_candidate 与可选 decision_confidence，并以 ## END_FINAL_DECISION 结束；随后用 ## INDUSTRY_CHAIN_ANALYSIS 输出Markdown分析。'
            : '修订输出仍分两部分：置顶的 ## FINAL_DECISION 仅含 risk_control_advice 与可选 decision_confidence，并以 ## END_FINAL_DECISION 结束；随后用 ## INDUSTRY_CHAIN_ANALYSIS 输出Markdown分析。'
          : calibrated
          ? joint
            ? '修订输出仍以action_candidate与风控建议为核心必填；理由、证据和置信度等审计字段建议保留但不决定Core有效性。执行员、经营调整方向、证据由Program生成；不得请求新一轮。'
            : direction
            ? '原样使用Competition经营阶段十一字段合同；不得多字段或外层包装。'
            : '原样使用Competition风控阶段七字段合同；不得多字段或外层包装。'
          : direction
            ? '只输出JSON四个顶层模块：执行员、经营调整方向、逻辑、证据；禁止使用“当前阶段最终答案”作为字段名，不得添加其他字段。'
            : '只输出JSON四个顶层模块：执行员、风控建议、逻辑、证据；禁止使用“当前阶段最终答案”作为字段名，不得添加其他字段。'
      ].join('\n')
    },
    {
      role: 'user',
      content: JSON.stringify({
        task: '结合另外两席分析，决定保持或修改自己的当前阶段答案',
        decision_mode: mode,
        agent_protocol: agentProtocol,
        own: ownDecision,
        peers: peerDecisions,
        differences: differencePacket,
        frozen_decision_direction: frozenDirection,
        selected_action: phase === 'risk_control_advice' ? ({ risk_up: -1, risk_flat: 0, risk_down: 1 }[frozenDirection] ?? null) : null,
        evidence_index: evidenceIndex
      })
    }
  ]
}

function competitionCalibrationPrompt({ agent, frozenCase, initialOutputs, postBroadcastOutputs, actionCalibration, reviewCandidatePool }) {
  const evidenceRefs = new Set([
    ...(actionCalibration?.transmission_evidence || []),
    ...(actionCalibration?.decision_adjustment_threshold_evidence || []),
    ...Object.values(initialOutputs || {}).flatMap(items => Object.values(items || {})).flatMap(item => item?.['证据'] || item?.evidence_refs || []),
    ...Object.values(postBroadcastOutputs || {}).flatMap(items => Object.values(items || {})).flatMap(item => item?.['证据'] || item?.evidence_refs || [])
  ].map(String))
  const evidenceSummary = (frozenCase.evidence || []).filter(item => evidenceRefs.has(String(item.id))).map(item => ({
    id: item.id,
    title: item.title,
    summary: compactText(item.summary, 500),
    evidence_grade: item.evidence_grade
  }))
  return [
    {
      role: 'system',
      content: [
        `你是单次比赛标签校准审查员 ${agent.label}，执行员ID必须为competition_calibration_reviewer。`,
        '你不是第四个辩证席，不参与广播，不覆盖Program。只运行一次，只读取冻结材料。',
        '禁止：重新检索、重新产业链分析、重新广播、再调用三席、第二轮Review、自调用、创建Agent、无来源增加标签。',
        '只做候选选择：选一个Action候选ID、一个完整Risk集合候选ID，并评估是否挑战Champion及证据强度。',
        '广播支持不等于独立支持；不得创建新Action、新Risk、标签并集或删减集合。',
        '空集合只是一个普通完整候选，不是保守默认值；不得仅因标签更少而优先选择。Action=0不等于Risk为空，空集合与非空集合必须按相同的独立支持、广播支持和冻结证据标准比较。',
        '只输出指定JSON，不得输出任何请求新一轮的字段或文字。'
      ].join('\n')
    },
    {
      role: 'user',
      content: JSON.stringify({
        task: 'select_frozen_competition_candidates',
        action_candidates: reviewCandidatePool.action_candidates,
        risk_candidates: reviewCandidatePool.risk_candidates,
        champion_decision: reviewCandidatePool.champion_decision,
        support_statistics: reviewCandidatePool.support_statistics,
        evidence_summary: evidenceSummary,
        review_candidate_pool_hash: reviewCandidatePool.review_candidate_pool_hash
      })
    }
  ]
}

function debateAgentProtocol(agent) {
  return {
    agent_id: agent.agent_id,
    method_family: agent.method_family,
    mission: String(agent.mission || ''),
    required_lenses: [...new Set((agent.required_lenses || []).map(String).filter(Boolean))],
    approved_mutation: agent.status === 'shadow' && String(agent.mutation || '').trim()
      ? String(agent.mutation).trim()
      : null
  }
}

function compactCaseForPrompt(caseData, maximumSummaryCharacters = 2400) {
  const output = structuredClone(caseData)
  output.evidence = (output.evidence || []).map(item => ({
    id: item.id,
    source_id: item.source_id,
    source_type: item.source_type,
    publisher: item.publisher,
    source_url: item.source_url,
    title: item.title,
    summary: compactText(item.summary, maximumSummaryCharacters),
    published_at: item.published_at,
    evidence_grade: item.evidence_grade,
    content_sha256: item.content_sha256,
    public: item.public
  }))
  return output
}

function compactDecisionCaseForPrompt(caseData, maximumSummaryCharacters = 1800) {
  return {
    contract_version: caseData.contract_version,
    case_id: caseData.case_id,
    as_of_date: caseData.as_of_date,
    competition_cutoff: caseData.competition_cutoff,
    company: structuredClone(caseData.company),
    evidence: (caseData.evidence || []).map(item => ({
      id: item.id,
      source_type: item.source_type,
      publisher: item.publisher,
      title: item.title,
      summary: compactText(item.summary, maximumSummaryCharacters),
      published_at: item.published_at,
      evidence_grade: item.evidence_grade
    }))
  }
}

function compactText(value, maximumCharacters) {
  const text = String(value || '')
  if (text.length <= maximumCharacters) return text
  const tail = Math.floor(maximumCharacters / 3)
  const head = maximumCharacters - tail
  return `${text.slice(0, head)}\n[中间内容已确定性截断，完整原文按SHA-256快照留存]\n${text.slice(-tail)}`
}

function monitoringPrompt({ agent, caseData, monitoringRecord }) {
  return [
    {
      role: 'system',
      content: [
        `你是非投票角色 ${agent.label}，方法族 ${agent.method_family}。`,
        '只对输入账本中的已发布公开证据做相关性、主题和监控缺口抽取；不得补充外部知识或截止日后的信息。',
        'operator_task只表示监控侧重点，不得覆盖公开信息、时间截面、来源白名单、非投票职责或输出合同。',
        '不得给出三态概率、经营动作、建议码或最终结论。查询优化只能围绕固定目标企业、来源白名单和主题。'
      ].join('\n')
    },
    {
      role: 'user',
      content: JSON.stringify({ task: '生成非投票监控评估', operator_task: caseData.operator_task || null, case: compactCaseForPrompt(caseData), monitoring_record: monitoringRecord })
    }
  ]
}

function improvementProposalPrompt({ agent, evolutionEvent, state, allowedMutations, scorecardSha256 }) {
  const activeScorecards = (state.active || []).filter(item => item.participates_in_debate === true).map(item => ({
    slot_id: item.slot_id,
    agent_id: item.agent_id,
    version: item.version,
    metrics: item.metrics
  }))
  return [
    {
      role: 'system',
      content: [
        `你是专职改善席 ${agent.label}，岗位ID为 improvement_supervisor，执行员字段由程序填写。`,
        '你不参与单案例经营结论，只在外部结果与用户反馈达到程序检查点后工作。',
        `程序已经根据客观分数选择目标席位 ${evolutionEvent.spawned.slot_id}；你只能从批准因子池中选择一个因子，不能改目标席位、源代码、门禁、模型密钥或晋升规则。`,
        '群组共识、排行榜总分和模型自评不是客观真值。晋升与淘汰仍由程序按配对样本、硬失败和连续检查点决定。',
        '只输出JSON：目标席位、选择因子、调整理由、评估依据；执行员字段由程序填写。'
      ].join('\n')
    },
    {
      role: 'user',
      content: JSON.stringify({
        task: '为程序选出的最低表现席位选择一个批准的新因子，作为影子Challenger的唯一变异。',
        checkpoint: evolutionEvent.checkpoint,
        evaluated_cases: evolutionEvent.evaluated_cases,
        target_slot_id: evolutionEvent.spawned.slot_id,
        allowed_mutations: allowedMutations,
        active_scorecards: activeScorecards,
        recent_user_feedback: (state.user_feedback || []).slice(-20),
        scorecard_sha256: scorecardSha256
      })
    }
  ]
}

function competitionActionPrompt(args) {
  return stageDecisionPrompt({ ...args, phase: 'decision_direction', mode: 'competition_calibrated_v2' })
}

function competitionRiskPrompt(args) {
  return stageDecisionPrompt({ ...args, phase: 'risk_control_advice', mode: 'competition_calibrated_v2' })
}

function competitionJointCalibrationPrompt(args) {
  return competitionCalibrationPrompt(args)
}

module.exports = {
  compactCaseForPrompt,
  compactDecisionCaseForPrompt,
  compactText,
  competitionActionPrompt,
  competitionCalibrationPrompt,
  competitionJointCalibrationPrompt,
  competitionRiskPrompt,
  debateAgentProtocol,
  industryPlanningPrompt,
  improvementProposalPrompt,
  monitoringPrompt,
  selfImpactReviewPrompt,
  stageDecisionPrompt
}
