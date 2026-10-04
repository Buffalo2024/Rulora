#!/usr/bin/env node
'use strict'
const path = require('node:path')
const { readJson } = require('./utils')
const { projectRoot } = require('./rulora-loader')
const { runEnterpriseDecision } = require('./enterprise-decision')

const HELP = [
  'Rulora Collective Decision — Enterprise operations decisions',
  '  demo [--out-dir DIR]                         Offline synthetic example and replay',
  '  run --input CASE.json --out-dir DIR --live   Your configured models and evidence',
  '  assist-list [--status STATUS]                List manual evidence requests',
  '  assist-show --id ID                          Show a manual request',
  '  assist-import --id ID --file FILE --metadata META.json',
  '  provider-health                             Inspect provider health',
  'Use npm run web for the local Collective Decision console. Live calls may incur provider charges.'
].join('\n')
const COMMANDS = {
  help: [], demo: ['out-dir'], run: ['input', 'out-dir', 'live'],
  'assist-list': ['status'], 'assist-show': ['id'],
  'assist-import': ['id', 'file', 'metadata'], 'provider-health': []
}

function parseOptions(args, allowed) {
  const result = {}
  for (let i = 0; i < args.length; i++) {
    const token = args[i]
    if (!token.startsWith('--') || !allowed.includes(token.slice(2))) throw new Error('Unsupported option: ' + token)
    const key = token.slice(2)
    if (Object.hasOwn(result, key)) throw new Error('Duplicate option: ' + token)
    if (key === 'live') result.live = true
    else {
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error('Missing value: ' + token)
      result[key] = args[++i]
    }
  }
  return result
}
function required(options, key) {
  if (!options[key]) throw new Error('--' + key + ' is required')
  return options[key]
}

async function main(argv = process.argv.slice(2)) {
  const [command = 'help', ...rest] = argv
  if (!Object.hasOwn(COMMANDS, command)) throw new Error('Unsupported command: ' + command + '. Only the Collective Decision enterprise scenario is supported.')
  const options = parseOptions(rest, COMMANDS[command])
  if (command === 'help') return HELP
  if (command === 'demo') return require('../examples/enterprise-collective').runDemo(options['out-dir'])
  if (command === 'run') {
    if (!options.live) throw new Error('Live enterprise execution requires --live; use demo for an offline run.')
    const input = await readJson(path.resolve(required(options, 'input')))
    const outputDirectory = path.resolve(required(options, 'out-dir'))
    if (input.mode && input.mode !== 'enterprise_decision_v2') throw new Error('Only enterprise_decision_v2 is supported')
    if (input.decision_mode && input.decision_mode !== 'enterprise_decision_v2') throw new Error('Only enterprise_decision_v2 is supported')
    const result = await runEnterpriseDecision({
      caseData: input.caseData || input,
      rules: input.rules || [], experience: input.experience || [], outputDirectory
    })
    if (result.status !== 'approved') process.exitCode = 2
    return result
  }
  if (command === 'provider-health') {
    const { ProviderHealthMonitor } = require('./provider-health-monitor')
    return new ProviderHealthMonitor({ root: projectRoot() }).status()
  }
  const { ManualAssistanceService } = require('./manual-assistance')
  const service = new ManualAssistanceService({ root: projectRoot() })
  if (command === 'assist-list') return service.list({ status: options.status })
  if (command === 'assist-show') return service.get(required(options, 'id'))
  if (command === 'assist-import') return service.importEvidence({
    assistanceId: required(options, 'id'), filePath: path.resolve(required(options, 'file')),
    metadataPath: path.resolve(required(options, 'metadata'))
  })
}
if (require.main === module) main().then(result => console.log(typeof result === 'string' ? result : JSON.stringify(result, null, 2))).catch(error => {
  console.error(error.code || 'COMMAND_FAILED', error.message)
  process.exitCode = 1
})
module.exports = { main, parseOptions, HELP }
