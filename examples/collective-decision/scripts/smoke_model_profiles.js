#!/usr/bin/env node
const fs = require('node:fs/promises')
const path = require('node:path')
const { createMultiModelProvider } = require('../src/providers/multi-model-provider')
const { loadLocalModelEnvironment } = require('../src/local-model-environment')
const { writeSmokeReceipt } = require('../src/model-readiness')

async function main() {
  if (!process.argv.includes('--live')) throw new Error('Live model calls require --live and may incur provider charges. Configure your own keys first.')
  loadLocalModelEnvironment()
  const configPath = path.resolve(process.env.AGENT_MODEL_CONFIG || path.join(__dirname, '..', 'config', 'model-profiles.local.json'))
  const config = JSON.parse(await fs.readFile(configPath, 'utf8'))
  const execution = JSON.parse(await fs.readFile(path.join(__dirname, '..', 'config', 'execution.json'), 'utf8'))
  const provider = await createMultiModelProvider(configPath)
  const results = []
  for (const profileId of Object.keys(config.profiles || {})) {
    if (!require('../src/enterprise-model-routing').profileActive(config.profiles[profileId], process.env)) continue
    const started = Date.now()
    try {
      const output = await provider.callForJson({
        agent: { agent_id: `smoke:${profileId}`, model_profile: profileId },
        prompt: [{ role: 'user', content: '连接测试：只返回 {"ok":true}。' }],
        outputInstruction: '只返回 JSON 对象 {"ok":true}，不得包含其他字段。',
        operation: 'connection_smoke_test'
      })
      results.push({ profile_id: profileId, ok: output.ok === true, latency_ms: Date.now() - started, provenance: output.model_provenance })
    } catch (error) {
      results.push({ profile_id: profileId, ok: false, latency_ms: Date.now() - started, error: redact(error.message) })
    }
  }
  const passed = results.length > 0 && results.every(result => result.ok)
  const saved = await writeSmokeReceipt({
    root: path.join(__dirname, '..'),
    config,
    maxAgeHours: execution.model_smoke_max_age_hours || 24,
    passed,
    results
  })
  console.log(JSON.stringify({ config_path: configPath, passed, results, receipt_path: saved.path, expires_at: saved.receipt.expires_at }, null, 2))
  if (!passed) process.exitCode = 1
}

function redact(message) {
  return String(message).replace(/(?:sk|key)[-_a-z0-9]{8,}/ig, '[REDACTED]')
}

main().catch(error => {
  console.error(redact(error.stack || error.message))
  process.exitCode = 1
})
