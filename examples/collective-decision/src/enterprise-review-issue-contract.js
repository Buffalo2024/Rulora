// Describe review problems; never infer or rewrite an action's business classification.
const ISSUE_KINDS=Object.freeze(['direction_conflict','action_conflict','redundant','action_classification_error'])
const ISSUE_CONTRACT=Object.freeze({
 version:'1.1.0',location:'each candidate_reviews item',fields:['kind','action_ids','reason'],kind_values:ISSUE_KINDS,
 action_ids:'unique actual action IDs from this candidate only; no invented or peer action IDs',
 cardinality:{direction_conflict:'at least one',action_conflict:'at least two',redundant:'at least one',action_classification_error:'exactly one'},
 classification_rule:'action_classification_error reports a mismatch between one action ID definition and its concrete target/action. Explain the mismatch using action_options. Do not auto-relabel the action, erase the issue, or invent a second action to satisfy action_conflict. The original seat independently revises a candidate if needed.',
 selection_rule:'A selected candidate with any issue cannot be approved. A different complete candidate without blocking issues may still be independently selected.'
})
function issueBindingProblem(issue,ids) {
 if(!issue || typeof issue!=='object' || Array.isArray(issue))return 'ISSUE_OBJECT_REQUIRED'
 if(!ISSUE_KINDS.includes(issue.kind))return 'ISSUE_KIND_INVALID'
 if(!Array.isArray(issue.action_ids) || !issue.action_ids.length || new Set(issue.action_ids).size!==issue.action_ids.length || issue.action_ids.some(id=>!Number.isInteger(id) || !ids.includes(id)))return 'ISSUE_ACTION_IDS_INVALID'
 if(issue.kind==='action_conflict' && issue.action_ids.length<2)return 'ACTION_CONFLICT_REQUIRES_MULTIPLE_ACTIONS'
 if(issue.kind==='action_classification_error' && issue.action_ids.length!==1)return 'ACTION_CLASSIFICATION_REQUIRES_SINGLE_ACTION'
 return null
}
function issueProblem(issue,ids) {
 if(!issue || typeof issue!=='object' || Array.isArray(issue))return 'ISSUE_OBJECT_REQUIRED'
 if(typeof issue.reason!=='string' || !issue.reason.trim())return 'ISSUE_REASON_REQUIRED'
 return issueBindingProblem(issue,ids)
}
module.exports={ISSUE_KINDS,ISSUE_CONTRACT,issueProblem,issueBindingProblem}
