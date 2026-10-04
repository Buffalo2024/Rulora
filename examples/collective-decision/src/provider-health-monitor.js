const fs = require('node:fs/promises')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { safeId, sha256, writeJsonAtomic } = require('./utils')

const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  consecutive_failed_attempts_alert_threshold: 3,
  failure_window_minutes: 10,
  repeat_alert_minutes: 30,
  notify_recovery: true,
  immediate_alert_categories: ['access_configuration', 'request_configuration'],
  lock_timeout_ms: 10000,
  stale_lock_ms: 30000
})

class ProviderHealthMonitor {
  constructor({ root = path.resolve(__dirname, '..'), directory, config = {}, notifier = macosProviderNotifier, now = () => new Date(), wait = delay } = {}) {
    this.root = path.resolve(root)
    this.config = { ...DEFAULT_CONFIG, ...(config || {}) }
    this.directory = path.resolve(directory || path.join(this.root, '.runtime', 'provider-health'))
    this.alertLogPath = path.join(this.directory, 'alerts.jsonl')
    this.notifier = notifier
    this.now = now
    this.wait = wait
  }

  async recordFailure({ profileId, model, operation, error }) {
    if (!this.config.enabled || error?.is_model_transport_failure !== true) return { monitored: false }
    const profile = safeProfileId(profileId)
    const timestamp = this.now().toISOString()
    const attempts = Math.max(1, Number(error.connection_attempts) || 1)
    const category = error.connectivity_category || 'unknown_transport'
    let alertEvent = null
    const state = await this.withProfileLock(profile, async () => {
      const current = await this.readState(profile, model)
      const lastFailureAt = current.last_failure_at ? Date.parse(current.last_failure_at) : 0
      const outsideWindow = !lastFailureAt || this.now().getTime() - lastFailureAt > Number(this.config.failure_window_minutes) * 60_000
      const consecutiveFailedCalls = outsideWindow ? 1 : current.consecutive_failed_calls + 1
      const consecutiveFailedAttempts = outsideWindow ? attempts : current.consecutive_failed_attempts + attempts
      const immediate = (this.config.immediate_alert_categories || []).includes(category)
      const thresholdReached = consecutiveFailedAttempts >= Number(this.config.consecutive_failed_attempts_alert_threshold)
      const repeatDue = !current.last_alert_at || this.now().getTime() - Date.parse(current.last_alert_at) >= Number(this.config.repeat_alert_minutes) * 60_000
      const shouldAlert = (immediate || thresholdReached) && (!current.alert_active || repeatDue)
      const next = {
        ...current,
        model,
        status: shouldAlert || current.alert_active ? 'alert' : 'degraded',
        consecutive_failed_calls: consecutiveFailedCalls,
        consecutive_failed_attempts: consecutiveFailedAttempts,
        first_failure_at: outsideWindow ? timestamp : current.first_failure_at,
        last_failure_at: timestamp,
        last_operation: operation || null,
        last_failure_category: category,
        last_http_status: Number(error.http_status) || null,
        last_error_code: error.code || 'MODEL_TRANSPORT_FAILURE',
        last_error_sha256: sha256(String(error.message || error.code || 'MODEL_TRANSPORT_FAILURE')),
        alert_active: shouldAlert || current.alert_active,
        last_alert_at: shouldAlert ? timestamp : current.last_alert_at,
        updated_at: timestamp,
        events: appendBounded(current.events, {
          type: shouldAlert ? 'connection_alert' : 'connection_failure',
          at: timestamp,
          operation: operation || null,
          category,
          attempts,
          consecutive_failed_attempts: consecutiveFailedAttempts
        })
      }
      await this.writeState(profile, next)
      if (shouldAlert) {
        alertEvent = safeAlertEvent({ type: 'connection_alert', profileId: profile, model, state: next })
        await this.appendAlert(alertEvent)
      }
      return next
    })
    const notification = alertEvent ? await deliverNotification(this.notifier, alertEvent) : null
    return { monitored: true, alerted: Boolean(alertEvent), notification, state }
  }

  async recordSuccess({ profileId, model, operation }) {
    if (!this.config.enabled) return { monitored: false }
    const profile = safeProfileId(profileId)
    const timestamp = this.now().toISOString()
    let recoveryEvent = null
    const state = await this.withProfileLock(profile, async () => {
      const current = await this.readState(profile, model)
      const recovered = current.alert_active === true
      const next = {
        ...current,
        model,
        status: 'healthy',
        consecutive_failed_calls: 0,
        consecutive_failed_attempts: 0,
        first_failure_at: null,
        last_success_at: timestamp,
        last_operation: operation || null,
        alert_active: false,
        recovered_at: recovered ? timestamp : current.recovered_at,
        updated_at: timestamp,
        events: appendBounded(current.events, { type: recovered ? 'connection_recovered' : 'connection_success', at: timestamp, operation: operation || null })
      }
      await this.writeState(profile, next)
      if (recovered) {
        recoveryEvent = safeAlertEvent({ type: 'connection_recovered', profileId: profile, model, state: next })
        await this.appendAlert(recoveryEvent)
      }
      return next
    })
    const notification = recoveryEvent && this.config.notify_recovery ? await deliverNotification(this.notifier, recoveryEvent) : null
    return { monitored: true, recovered: Boolean(recoveryEvent), notification, state }
  }

  async status() {
    await fs.mkdir(this.directory, { recursive: true })
    const names = (await fs.readdir(this.directory)).filter(name => name.endsWith('.json') && !name.endsWith('.lock')).sort()
    return Promise.all(names.map(name => fs.readFile(path.join(this.directory, name), 'utf8').then(JSON.parse)))
  }

  async readState(profileId, model) {
    const target = this.statePath(profileId)
    try { return JSON.parse(await fs.readFile(target, 'utf8')) } catch (error) {
      if (error.code !== 'ENOENT') throw error
      return {
        contract_version: '1.0.0',
        profile_id: profileId,
        model,
        status: 'unknown',
        consecutive_failed_calls: 0,
        consecutive_failed_attempts: 0,
        first_failure_at: null,
        last_failure_at: null,
        last_success_at: null,
        last_alert_at: null,
        alert_active: false,
        recovered_at: null,
        events: []
      }
    }
  }

  async writeState(profileId, state) {
    const target = this.statePath(profileId)
    await writeJsonAtomic(target, state)
    await fs.chmod(target, 0o600)
  }

  statePath(profileId) { return path.join(this.directory, `${safeProfileId(profileId)}.json`) }

  async appendAlert(event) {
    await fs.mkdir(this.directory, { recursive: true })
    await fs.appendFile(this.alertLogPath, `${JSON.stringify(event)}\n`, { encoding: 'utf8', mode: 0o600 })
    await fs.chmod(this.alertLogPath, 0o600)
  }

  async withProfileLock(profileId, task) {
    await fs.mkdir(this.directory, { recursive: true })
    const lockPath = path.join(this.directory, `${safeProfileId(profileId)}.lock`)
    const deadline = Date.now() + Number(this.config.lock_timeout_ms)
    let handle
    while (!handle) {
      try {
        handle = await fs.open(lockPath, 'wx', 0o600)
        await handle.writeFile(JSON.stringify({ pid: process.pid, created_at: new Date().toISOString() }))
      } catch (error) {
        if (error.code !== 'EEXIST') throw error
        try {
          const stat = await fs.stat(lockPath)
          if (Date.now() - stat.mtimeMs > Number(this.config.stale_lock_ms)) {
            await fs.unlink(lockPath)
            continue
          }
        } catch (statError) {
          if (statError.code === 'ENOENT') continue
          throw statError
        }
        if (Date.now() >= deadline) throw new Error(`provider health lock timeout for ${profileId}`)
        await this.wait(50)
      }
    }
    try { return await task() } finally {
      await handle.close().catch(() => {})
      await fs.unlink(lockPath).catch(() => {})
    }
  }
}

function safeProfileId(value) {
  return safeId(String(value || '').replace(/:/g, '_'))
}

function appendBounded(events, event, maximum = 50) {
  return [...(events || []), event].slice(-maximum)
}

function safeAlertEvent({ type, profileId, model, state }) {
  return {
    contract_version: '1.0.0',
    type,
    profile_id: profileId,
    model,
    status: state.status,
    category: state.last_failure_category || null,
    consecutive_failed_calls: state.consecutive_failed_calls,
    consecutive_failed_attempts: state.consecutive_failed_attempts,
    occurred_at: state.updated_at
  }
}

function macosProviderNotifier(event) {
  if (process.platform !== 'darwin') return { attempted: false, delivered: false, reason: 'macos_only' }
  if (process.env.RULORA_DISABLE_DESKTOP_NOTIFICATION === '1') return { attempted: false, delivered: false, reason: 'disabled_by_environment' }
  const test = event.type === 'notification_test'
  const recovered = event.type === 'connection_recovered'
  const title = test ? 'Rulora 中转站告警通道测试' : recovered ? 'Rulora 中转站连接已恢复' : 'Rulora 中转站连续连接失败'
  const detail = test ? '告警通知通道工作正常。' : recovered
    ? `${event.profile_id} / ${event.model} 已恢复。`
    : `${event.profile_id} / ${event.model}：${event.category}，连续失败尝试 ${event.consecutive_failed_attempts} 次。`
  const result = spawnSync('/usr/bin/osascript', ['-e', `display notification "${escapeAppleScript(detail)}" with title "${escapeAppleScript(title)}"`], { timeout: 5000, encoding: 'utf8' })
  return { attempted: true, delivered: result.status === 0 && !result.error, reason: result.error?.code || (result.status === 0 ? null : `osascript_exit_${result.status}`) }
}

async function deliverNotification(notifier, event) {
  try {
    const result = await Promise.resolve(notifier(event))
    return result && typeof result === 'object' ? result : { attempted: true, delivered: true, reason: null }
  } catch (error) {
    return { attempted: true, delivered: false, reason: String(error.code || error.message || 'notification_failed').slice(0, 200) }
  }
}

function escapeAppleScript(value) { return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]+/g, ' ') }
function delay(milliseconds) { return new Promise(resolve => setTimeout(resolve, milliseconds)) }

module.exports = { DEFAULT_CONFIG, ProviderHealthMonitor, macosProviderNotifier }
