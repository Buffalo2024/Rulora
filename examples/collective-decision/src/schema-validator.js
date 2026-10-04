const path = require('node:path')
const Ajv2020 = require('ajv/dist/2020')
const addFormats = require('ajv-formats')
const { readJson } = require('./utils')

let validatorsPromise

async function loadSchemaValidators(rootDirectory) {
  if (!validatorsPromise) validatorsPromise = createValidators(rootDirectory)
  return validatorsPromise
}

async function createValidators(rootDirectory) {
  const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false })
  addFormats(ajv)
  const schemaRoot = path.join(rootDirectory, 'schemas')
  const [companyCase, opinion, report, industryPlan, stageDecision, competitionStageDecision, competitionCoreDecision, competitionActionDecision, competitionRiskDecision, competitionAuditDecision, competitionCalibrationReview, debateBroadcast, improvementProposal] = await Promise.all([
    readJson(path.join(schemaRoot, 'company-case.schema.json')),
    readJson(path.join(schemaRoot, 'agent-opinion.schema.json')),
    readJson(path.join(schemaRoot, 'report.schema.json')),
    readJson(path.join(schemaRoot, 'industry-plan.schema.json')),
    readJson(path.join(schemaRoot, 'stage-decision.schema.json')),
    readJson(path.join(schemaRoot, 'competition-stage-decision.schema.json')),
    readJson(path.join(schemaRoot, 'competition-core-decision.schema.json')),
    readJson(path.join(schemaRoot, 'competition-action-decision.schema.json')),
    readJson(path.join(schemaRoot, 'competition-risk-decision.schema.json')),
    readJson(path.join(schemaRoot, 'competition-audit-decision.schema.json')),
    readJson(path.join(schemaRoot, 'competition-calibration-review.schema.json')),
    readJson(path.join(schemaRoot, 'debate-broadcast-payload.schema.json')),
    readJson(path.join(schemaRoot, 'improvement-proposal.schema.json'))
  ])
  return {
    case: ajv.compile(companyCase),
    opinion: ajv.compile(opinion),
    report: ajv.compile(report),
    industryPlan: ajv.compile(industryPlan),
    stageDecision: ajv.compile(stageDecision),
    competitionStageDecision: ajv.compile(competitionStageDecision),
    competitionCoreDecision: ajv.compile(competitionCoreDecision),
    competitionActionDecision: ajv.compile(competitionActionDecision),
    competitionRiskDecision: ajv.compile(competitionRiskDecision),
    competitionAuditDecision: ajv.compile(competitionAuditDecision),
    competitionCalibrationReview: ajv.compile(competitionCalibrationReview),
    debateBroadcast: ajv.compile(debateBroadcast),
    improvementProposal: ajv.compile(improvementProposal)
  }
}

function assertSchema(validate, value, label) {
  if (validate(value)) return value
  const details = (validate.errors || []).map(error => `${error.instancePath || '/'} ${error.message}`).join('; ')
  throw new Error(`${label} JSON Schema rejected: ${details}`)
}

module.exports = { assertSchema, loadSchemaValidators }
