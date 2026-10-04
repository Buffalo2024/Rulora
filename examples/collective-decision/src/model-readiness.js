const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const { canonicalJson, sha256, writeJsonAtomic } = require('./utils')

const RECEIPT_CONTRACT_VERSION = '1.0.0'

function resolveModelConfiguration(config, environment = process.env) {
  const profiles = {}
  for (const [profileId, configured] of Object.entries(config?.profiles || {})) {
    const profile = mergeProfile(config.defaults, configured)
    if (!require('./enterprise-model-routing').profileActive(profile, environment)) continue
    const model = resolveSetting(profile, 'model', environment)
    const baseUrl = resolveSetting(profile, 'base_url', environment)
    const secret = profile.api_key_env ? environment[profile.api_key_env] || '' : profile.api_key || ''
    profiles[profileId] = {
      provider: profile.provider,
      api: profile.api || null,
      base_url: baseUrl || null,
      model: model || null,
      api_key_env: profile.api_key_env || null,
      api_key_configured: profile.api_key_optional === true || Boolean(secret),
      api_key_fingerprint: secret ? sha256(`rulora-model-readiness-v1\u0000${secret}`) : null,
      send_user_agent: profile.send_user_agent !== false,
      extra_body: profile.extra_body || {}
    }
  }
  return { contract_version: config?.contract_version || null, profiles, ...(config?.enterprise_model_routing ? {enterprise_model_routing:config.enterprise_model_routing} : {}) }
}

function modelConfigurationFingerprint(config, environment = process.env) {
  return sha256(canonicalJson(resolveModelConfiguration(config, environment)))
}

function smokeReceiptPath(root = path.resolve(__dirname, '..')) {
  return path.join(path.resolve(root), '.runtime', 'model-smoke', 'latest.json')
}

async function writeSmokeReceipt({ root, config, environment = process.env, checkedAt = new Date(), maxAgeHours = 24, passed, results }) {
  const checked = checkedAt instanceof Date ? checkedAt : new Date(checkedAt)
  if (Number.isNaN(checked.getTime())) throw new Error('model smoke checkedAt is invalid')
  const receipt = {
    contract_version: RECEIPT_CONTRACT_VERSION,
    kind: 'live_model_connectivity_smoke',
    checked_at: checked.toISOString(),
    expires_at: new Date(checked.getTime() + Number(maxAgeHours) * 3600_000).toISOString(),
    passed: passed === true,
    config_fingerprint: modelConfigurationFingerprint(config, environment),
    results: structuredClone(results || [])
  }
  const target = smokeReceiptPath(root)
  await writeJsonAtomic(target, receipt)
  await fsp.chmod(target, 0o600)
  return { receipt, path: target }
}

function verifySmokeReceipt({ root, config, environment = process.env, maxAgeHours = 24, now = new Date() }) {
  const target = smokeReceiptPath(root)
  const result = {
    receipt_path: target,
    present: false,
    passed: false,
    fresh: false,
    fingerprint_match: false,
    live_ready: false,
    checked_at: null,
    expires_at: null,
    reason: 'missing_live_smoke_receipt'
  }
  if (!fs.existsSync(target)) return result
  result.present = true
  try {
    const receipt = JSON.parse(fs.readFileSync(target, 'utf8'))
    const current = now instanceof Date ? now : new Date(now)
    const checked = new Date(receipt.checked_at)
    const expires = new Date(receipt.expires_at)
    const ageLimit = new Date(checked.getTime() + Number(maxAgeHours) * 3600_000)
    result.checked_at = receipt.checked_at || null
    result.expires_at = receipt.expires_at || null
    result.passed = receipt.contract_version === RECEIPT_CONTRACT_VERSION && receipt.passed === true
    result.fingerprint_match = receipt.config_fingerprint === modelConfigurationFingerprint(config, environment)
    result.fresh = !Number.isNaN(current.getTime()) && !Number.isNaN(checked.getTime()) && !Number.isNaN(expires.getTime()) &&
      current >= checked && current <= expires && current <= ageLimit
    result.live_ready = result.passed && result.fingerprint_match && result.fresh
    result.reason = result.live_ready
      ? null
      : !result.fresh ? 'live_smoke_receipt_expired'
        : !result.fingerprint_match ? 'model_or_key_changed_since_smoke'
          : 'latest_live_smoke_failed'
    return result
  } catch (error) {
    return { ...result, reason: 'invalid_live_smoke_receipt', error: error.message }
  }
}

function mergeProfile(defaults, profile) {
  return {
    ...(defaults || {}),
    ...(profile || {}),
    extra_body: { ...(defaults?.extra_body || {}), ...(profile?.extra_body || {}) }
  }
}

function resolveSetting(profile, key, environment) {
  const envName = profile[`${key}_env`]
  return (envName && environment[envName]) || profile[key]
}

module.exports = {
  RECEIPT_CONTRACT_VERSION,
  modelConfigurationFingerprint,
  resolveModelConfiguration,
  smokeReceiptPath,
  verifySmokeReceipt,
  writeSmokeReceipt
}
