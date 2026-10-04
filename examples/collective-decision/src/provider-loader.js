const path = require('node:path')
const fs = require('node:fs')
const { FixtureProvider } = require('./providers/fixture-provider')
const { DeterministicBaselineProvider } = require('./providers/deterministic-baseline-provider')
const { createMultiModelProvider } = require('./providers/multi-model-provider')
const { loadLocalModelEnvironment } = require('./local-model-environment')
const { verifySmokeReceipt } = require('./model-readiness')
const { modelConfigurationFingerprint } = require('./model-readiness')
const { sha256 } = require('./utils')

async function loadProvider({ allowFixture = false, allowBaseline = false } = {}) {
  loadLocalModelEnvironment()
  if (allowFixture) {
    return { provider: new FixtureProvider(), source: 'built-in-fixture-provider', fixture: true, mode: 'fixture', productionReady: false, executionFingerprint: sha256('fixture-provider-v1') }
  }
  if (allowBaseline) {
    const provider = new DeterministicBaselineProvider()
    return { provider, source: 'built-in-deterministic-public-evidence-baseline', fixture: false, mode: provider.mode, productionReady: false, executionFingerprint: sha256('deterministic-baseline-provider-v1') }
  }
  if (process.env.AGENT_PROVIDER_MODULE) {
    const modulePath = path.resolve(process.env.AGENT_PROVIDER_MODULE)
    const loaded = require(modulePath)
    const provider = typeof loaded.createProvider === 'function' ? await loaded.createProvider() : loaded
    assertProvider(provider)
    return {
      provider,
      source: modulePath,
      fixture: false,
      mode: provider.mode || 'custom_provider',
      productionReady: provider.productionReady === true,
      executionFingerprint: sha256(`custom-provider:${modulePath}`)
    }
  }
  const defaultConfigPath = path.resolve(__dirname, '..', 'config', 'model-profiles.local.json')
  const configuredPath = process.env.AGENT_MODEL_CONFIG
    ? path.resolve(process.env.AGENT_MODEL_CONFIG)
    : (fs.existsSync(defaultConfigPath) ? defaultConfigPath : null)
  if (configuredPath) {
    const configPath = configuredPath
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
    const provider = await createMultiModelProvider(configPath)
    assertProvider(provider)
    const executionPath = path.resolve(__dirname, '..', 'config', 'execution.json')
    const execution = fs.existsSync(executionPath) ? JSON.parse(fs.readFileSync(executionPath, 'utf8')) : {}
    const liveReadiness = verifySmokeReceipt({
      root: path.resolve(__dirname, '..'),
      config,
      maxAgeHours: execution.model_smoke_max_age_hours || 24
    })
    return {
      provider,
      source: `built-in-multi-model:${configPath};smoke=${liveReadiness.receipt_path}`,
      fixture: false,
      mode: 'multi_model_api',
      productionReady: liveReadiness.live_ready,
      liveReadiness,
      executionFingerprint: modelConfigurationFingerprint(config)
    }
  }
  throw new Error('config/model-profiles.local.json, AGENT_MODEL_CONFIG or AGENT_PROVIDER_MODULE is required for non-fixture runs')
}

function assertProvider(provider) {
  for (const method of ['planIndustry', 'decideStage', 'reviewStage', 'monitor', 'proposeImprovement']) {
    if (!provider || typeof provider[method] !== 'function') throw new Error(`provider.${method} must be a function`)
  }
}

module.exports = { assertProvider, loadProvider }
