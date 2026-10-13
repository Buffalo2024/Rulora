// Explain rejected judgments; never rewrite a verdict, candidate, or business gate.
function reviewFeedback(value, { errors = [], stage = null, candidates = [] } = {}) {
  const findings = []
  const add = (code, fields, rule) => findings.push({ code, fields, rule })
  const field = (path, value) => ({ path, value: value === undefined ? null : structuredClone(value) })
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const selected = candidates.find(c => c.seat_id === value.selected_seat_id)
    const rows = Array.isArray(value.candidate_reviews) ? value.candidate_reviews : []
    const index = rows.findIndex(r => r?.seat_id === value.selected_seat_id)
    const row = rows[index]
    const allowedSources = require('./enterprise-action-audit').RESIDUAL_RISK_SOURCES
    for (const [r, candidate] of rows.entries()) {
      for (const [i, action] of (Array.isArray(candidate?.action_reviews) ? candidate.action_reviews : []).entries()) {
        if (!allowedSources.includes(action?.residual_risk_source)) {
          add('ACTION_RISK_SOURCE_INVALID', [field(`/candidate_reviews/${r}/seat_id`, candidate?.seat_id), field(`/candidate_reviews/${r}/action_reviews/${i}/id`, action?.id), field(`/candidate_reviews/${r}/action_reviews/${i}/residual_risk_source`, action?.residual_risk_source)], 'residual_risk_source合法值仅为known_fact、unknown_sufficiency、no_residual_risk。unknown_only属于basis_status，不属于本字段；由模型按原证据补正，程序不代映射。')
          findings.at(-1).allowed_values = [...allowedSources]
        }
      }
    }
    if (stage === 'condition') for (const [r, review] of rows.entries()) {
      const own=candidates.find(c=>c.seat_id===review?.seat_id)
      if (!own) continue
      const policy=require('./enterprise-review-issue-contract')
      const ids=(Array.isArray(own.recommendations)?own.recommendations:[]).filter(require('./enterprise-action-contract').isActualAction)
      for(const [i,issue] of (Array.isArray(review?.issues)?review.issues:[]).entries()) {
        const problem=policy.issueProblem(issue,ids)
        if(!problem)continue
        const path=`/candidate_reviews/${r}/issues/${i}`
        add(problem,[field(`/candidate_reviews/${r}/seat_id`,review.seat_id),field(path,issue),field(`${path}/kind`,issue?.kind),field(`${path}/action_ids`,issue?.action_ids)], 'action_conflict须绑定本候选至少两个不同实际行动；单项编号定义与具体行动错配使用action_classification_error，恰好绑定一个已有编号。理由须非空、编号不得跨席、重复或补造。根据action_options由模型判断类型，保留原问题事实和理由；程序不代改编号或清空真实问题。')
        Object.assign(findings.at(-1),{allowed_kinds:[...policy.ISSUE_KINDS],candidate_action_ids:ids,action_definitions:require('./enterprise-action-contract').ACTIONS.filter(a=>Array.isArray(issue?.action_ids)&&issue.action_ids.includes(a.id)).map(a=>({id:a.id,label:a.label,meaning:a.meaning}))})
      }
    }
    if (value.consistent === true) {
      if (Array.isArray(value.unresolved_gaps) && value.unresolved_gaps.length)
        add('APPROVED_WITH_BLOCKING_GAPS', [field('/consistent', true), field('/unresolved_gaps', value.unresolved_gaps)], '批准必须没有阻断缺口。模型须基于证据区分阻断缺口与候选中的普通执行前提或分析限制；程序不判断或清空缺口。')
      if (value.authority !== 'within_rules' || !value.selected_seat_id || (candidates.length && !selected) || !Array.isArray(value.applied_rule_ids) || !value.applied_rule_ids.length)
        add('APPROVAL_AUTHORITY_OR_SELECTION_INVALID', [field('/authority', value.authority), field('/selected_seat_id', value.selected_seat_id), field('/applied_rule_ids', value.applied_rule_ids)], '批准须权限内、引用授权规则并选择已有完整候选。')
      if (row && (row.assessment !== 'supported' || row.independence !== 'independent'))
        add('SELECTED_CANDIDATE_UNSUPPORTED', [field(`/candidate_reviews/${index}/assessment`, row.assessment), field(`/candidate_reviews/${index}/independence`, row.independence)], '选中候选须有独立成立的依据，同行支持不能替代。')
      if (stage === 'condition' || Array.isArray(row?.action_reviews)) {
        for (const [i, action] of (Array.isArray(row?.action_reviews) ? row.action_reviews : []).entries()) {
          const prefix = `/candidate_reviews/${index}/action_reviews/${i}`
          if (action?.necessity !== 'required')
            add('SELECTED_ACTION_NOT_REQUIRED', [field('/selected_seat_id', value.selected_seat_id), field(`${prefix}/id`, action?.id), field(`${prefix}/necessity`, action?.necessity)], '批准的完整候选不可包含optional或uncertain行动。不能只为过门禁改成required，也不能由复核席删项；需要改变候选时退回原席独立修改。')
          if (action?.assessment !== 'supported' || action?.direction_assessment !== 'compatible')
            add('SELECTED_ACTION_UNSUPPORTED', [field(`${prefix}/id`, action?.id), field(`${prefix}/assessment`, action?.assessment), field(`${prefix}/direction_assessment`, action?.direction_assessment)], '批准的行动须成立且与冻结方向相容。')
        }
        if (Array.isArray(row?.action_reviews) && row.action_reviews.length && row.task_coverage !== 'sufficient')
          add('SELECTED_SCOPE_INSUFFICIENT', [field(`/candidate_reviews/${index}/task_coverage`, row.task_coverage)], '判断本席位自身关键风险是否回应，不要求覆盖其他席位维度。')
        if (row?.issues?.length)
          add('SELECTED_CANDIDATE_HAS_ISSUES', [field(`/candidate_reviews/${index}/issues`, row.issues)], '冲突或重复须由原席修订后重新复核。')
        for (const [i, label] of (Array.isArray(selected?.label_assessments) ? selected.label_assessments : []).entries()) if (label?.necessary === false)
          add('ORIGINAL_SEAT_ACTION_NOT_NECESSARY', [field(`/candidates/${candidates.indexOf(selected)}/label_assessments/${i}`, label)], '原席保留的非必要项必须交回原席取舍，复核不得代改候选。')
      }
    }
    if (value.revision_requests?.length && (stage === 'direction' || value.consistent !== false || value.selected_seat_id !== null || value.authority !== 'within_rules'))
      add('REVISION_REQUEST_STATE_INVALID', [field('/consistent', value.consistent), field('/selected_seat_id', value.selected_seat_id), field('/authority', value.authority)], '退回原席只用于权限内第二层，consistent=false、selected_seat_id=null、selection_mode=no_selection，并绑定已有席位和行动编号。')
  }
  return { version: '1.0.0', program_errors: [...errors], findings,
    resolution: '依据冻结证据独立重新判断：可选择其他已成立的完整候选；若候选需改变，第二层可用revision_requests交回原席；若确有阻断或超权限，保持不批准并说明真实原因。不得清空真实缺口、修改候选或把可选项改为必选来迎合校验。',
    retry_policy: '沿用既有有界修订次数；格式修订须保留裁决，业务矛盾须独立重新复核。' }
}
module.exports = { reviewFeedback }
