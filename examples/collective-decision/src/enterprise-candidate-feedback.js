// Locate contract failures for the original seat. Never alter a candidate or evidence.
function candidateFeedback(value, { errors = [] } = {}) {
  const candidate = value?.candidate || value
  const findings = []
  if (Array.isArray(value?.addition_basis)) {
    const refs = Array.isArray(candidate?.evidence_refs) ? candidate.evidence_refs : []
    for (const [index, basis] of value.addition_basis.entries()) {
      if (!Array.isArray(basis?.evidence_refs)) continue
      const outside = basis.evidence_refs.filter(id => !refs.includes(id))
      if (!outside.length) continue
      findings.push({ code: 'ADDITION_EVIDENCE_OUTSIDE_CANDIDATE',
        path: `/addition_basis/${index}/evidence_refs`, action_code: basis.code,
        candidate: { evidence_refs: structuredClone(refs) },
        rejected: { evidence_refs: structuredClone(outside) },
        rule: '新增行动依据的引用须属于本次冻结登记证据，并包含在该完整候选evidence_refs中。回到原证据核验新增行动、具体行动论证及引用的一致性；仅保留真正支持本席新增行动的引用。不得为过门禁机械补入证据、捏造引用或沿用同行支持；事实不足时保留真实缺口并按原契约独立修订。' })
    }
  }
  if (candidate && Object.hasOwn(candidate, 'no_action_basis') &&
      Array.isArray(candidate.recommendations) && !candidate.recommendations.includes(13)) {
    findings.push({ code: 'NO_ACTION_BASIS_NOT_APPLICABLE',
      path: value?.candidate ? '/candidate/no_action_basis' : '/no_action_basis',
      rule: 'no_action_basis仅用于recommendations:[13]。不适用时省略该字段；不得仅为保留字段改选[13]。任何非空既有安排依据或真实缺口须由原席根据冻结证据独立核对，不能由程序清空。' })
  }
  return { version: '1.0.0', program_errors: [...errors], findings,
    retry_policy: '沿用原有有界退修；岗位、分析方法、证据范围及业务门禁不变。' }
}
module.exports = { candidateFeedback }
