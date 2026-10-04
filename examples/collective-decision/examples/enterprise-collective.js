#!/usr/bin/env node
'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const { runEnterpriseDecision } = require('../src/enterprise-decision')
const { VERSION } = require('../src/enterprise-deliberation')
const { ACTION_OPTIONS_VERSION } = require('../src/enterprise-action-contract')
const { fixture, fakeProvider } = require('./fixtures/enterprise-provider')

async function runDemo(outputDirectory = path.join(__dirname, 'output', 'enterprise-collective')) {
  const { root, caseData } = await fixture({ outputDirectory })
  const provider = fakeProvider()
  const first = await runEnterpriseDecision({ caseData, provider, outputDirectory: root })
  assert.equal(first.status, 'approved')
  const calls = provider.calls.length
  const replay = await runEnterpriseDecision({ caseData, provider, outputDirectory: root })
  assert.deepEqual(replay.report, first.report)
  assert.equal(provider.calls.length, calls, 'Successful checkpoints must avoid repeated model calls')
  const summary = {
    synthetic: true,
    notice: '虚构企业、模拟证据和脚本模型；网页链接仅作协议占位，不代表已联网核验。不是投资或经营建议。',
    protocol: VERSION,
    action_options_version: ACTION_OPTIONS_VERSION,
    status: first.status,
    report: first.report,
    first_run_model_calls: calls,
    replay_additional_model_calls: provider.calls.length - calls,
    replay_report_identical: true
  }
  await fs.writeFile(path.join(root, 'demo-summary.json'), JSON.stringify(summary, null, 2) + '\n')
  return summary
}
if (require.main === module) runDemo().then(value => console.log(JSON.stringify(value, null, 2))).catch(error => { console.error(error); process.exitCode = 1 })
module.exports = { runDemo }
