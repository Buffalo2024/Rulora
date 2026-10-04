const { buildComparisonRows } = require('./competition-mode')

function buildSubmissionSupervisorRecord({ championName = 'V1', championScore = null, priorName = 'V2', priorScore = null, championRows, challengerRuns }) {
  const comparisons = buildComparisonRows({ championRows, challengerRuns })
  const counts = comparisons.reduce((accumulator, row) => {
    accumulator[row.recommended_status] = (accumulator[row.recommended_status] || 0) + 1
    return accumulator
  }, {})
  return {
    contract_version: '1.0.0',
    supervisor_id: 'improvement_supervisor',
    competition_role: 'submission_supervisor',
    automatic_evolution: false,
    may_modify_submission: false,
    history: {
      champion: { name: championName, score: championScore, protected: true },
      prior: { name: priorName, score: priorScore },
      challenger: { case_count: challengerRuns.length }
    },
    change_set: comparisons.filter(row => row.action_changed || row.risk_changed),
    comparisons,
    recommendation_counts: counts,
    recommendation: counts.CHALLENGE_HIGH ? 'CHALLENGE' : counts.REVIEW || counts.CHALLENGE_MEDIUM ? 'REVIEW' : 'KEEP',
    final_changeset_requires_explicit_confirmation: true
  }
}

module.exports = { buildSubmissionSupervisorRecord }
