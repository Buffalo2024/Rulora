const ROLE_DISCLOSURE_POLICY = Object.freeze({
  independent_seat: Object.freeze(['case_id', 'task', 'evidence']),
  broadcast_seat: Object.freeze(['case_id', 'task', 'evidence', 'peer_candidate_summary']),
  constrained_reviewer: Object.freeze(['case_id', 'task', 'evidence', 'frozen_candidate_pool']),
  delivery: Object.freeze(['case_id', 'final_decision', 'audit_summary'])
})

const MODEL_DISCLOSURE_POLICY = Object.freeze({
  independent_decision: Object.freeze([
    'task', 'decision_mode', 'operator_task', 'agent_protocol', 'industry_plan',
    'frozen_decision_direction', 'final_action_candidate', 'case'
  ]),
  broadcast_revision: Object.freeze([
    'task', 'decision_mode', 'agent_protocol', 'own', 'peers', 'differences',
    'frozen_decision_direction', 'selected_action', 'evidence_index'
  ]),
  constrained_reviewer: Object.freeze([
    'task', 'action_candidates', 'risk_candidates', 'champion_decision',
    'support_statistics', 'evidence_summary', 'review_candidate_pool_hash'
  ])
})

function projectRoleContext(source, role) {
  const allowed = ROLE_DISCLOSURE_POLICY[role]
  if (!allowed) throw new Error(`unknown disclosure role: ${role}`)
  const result = {}
  for (const key of allowed) {
    if (source?.[key] !== undefined) result[key] = structuredClone(source[key])
  }
  return result
}

function assertRoleContext(source, role) {
  const allowed = new Set(ROLE_DISCLOSURE_POLICY[role] || [])
  if (!allowed.size) throw new Error(`unknown disclosure role: ${role}`)
  const unexpected = Object.keys(source || {}).filter(key => !allowed.has(key))
  if (unexpected.length) throw new Error(`${role} received forbidden fields: ${unexpected.join(', ')}`)
  return true
}

function projectModelDisclosure(source, operation) {
  const allowed = MODEL_DISCLOSURE_POLICY[operation]
  if (!allowed) throw new Error(`unknown model disclosure operation: ${operation}`)
  const result = {}
  for (const key of allowed) {
    if (source?.[key] !== undefined) result[key] = structuredClone(source[key])
  }
  return result
}

function assertModelDisclosure(source, operation) {
  const allowed = new Set(MODEL_DISCLOSURE_POLICY[operation] || [])
  if (!allowed.size) throw new Error(`unknown model disclosure operation: ${operation}`)
  const unexpected = Object.keys(source || {}).filter(key => !allowed.has(key))
  if (unexpected.length) throw new Error(`${operation} received forbidden fields: ${unexpected.join(', ')}`)
  return true
}

module.exports = {
  MODEL_DISCLOSURE_POLICY,
  ROLE_DISCLOSURE_POLICY,
  assertModelDisclosure,
  assertRoleContext,
  projectModelDisclosure,
  projectRoleContext
}
