function concurrencyLimit(value) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error('Model concurrency must be a positive finite integer')
  return value
}

// Validate both settings before changing a live scheduler; never cancel in-flight work.
function applySchedulerConcurrency(scheduler, options = {}) {
  const aggregate = concurrencyLimit(options.maximumConcurrent === undefined ? scheduler.maximumConcurrent : options.maximumConcurrent)
  const perProfile = concurrencyLimit(options.maximumConcurrentPerProfile === undefined ? scheduler.maximumConcurrentPerProfile : options.maximumConcurrentPerProfile)
  scheduler.maximumConcurrent = aggregate
  scheduler.maximumConcurrentPerProfile = perProfile
  scheduler.pump()
  return scheduler.diagnostics()
}

class GlobalProviderScheduler {
  constructor({ maximumConcurrent = 3, maximumConcurrentPerProfile = 1, circuitFailureThreshold = 3, circuitCooldownMs = 30000 } = {}) {
    this.maximumConcurrent = Number.isInteger(maximumConcurrent) && maximumConcurrent > 0 ? maximumConcurrent : 3
    this.maximumConcurrentPerProfile = Number.isInteger(maximumConcurrentPerProfile) && maximumConcurrentPerProfile > 0 ? maximumConcurrentPerProfile : 1
    this.circuitFailureThreshold = Number.isInteger(circuitFailureThreshold) && circuitFailureThreshold > 0 ? circuitFailureThreshold : 3
    this.circuitCooldownMs = Number.isFinite(circuitCooldownMs) && circuitCooldownMs > 0 ? circuitCooldownMs : 30000
    this.active = 0
    this.activeByProfile = new Map()
    this.healthByProfile = new Map()
    this.queue = []
    this.wakeTimers = new Map()
  }

  schedule(profileId, operation, task, { signal } = {}) {
    if (!profileId || typeof task !== 'function') throw new Error('scheduler requires profileId and task')
    return new Promise((resolve, reject) => {
      const cancelled = () => Object.assign(new Error('Scheduled request cancelled'), { code: 'MODEL_API_CANCELLED', retryable: false })
      if (signal?.aborted) return reject(cancelled())
      const item = { profileId, operation, task, resolve, reject, queuedAt: Date.now(), signal }
      item.abort = () => {
        const index = this.queue.indexOf(item)
        if (index < 0) return
        this.queue.splice(index, 1)
        signal.removeEventListener('abort', item.abort)
        reject(cancelled())
        this.pump()
      }
      signal?.addEventListener('abort', item.abort, { once: true })
      this.queue.push(item)
      this.pump()
    })
  }

  pump() {
    while (this.active < this.maximumConcurrent) {
      const index = this.queue.findIndex(item => this.canStart(item.profileId))
      if (index < 0) break
      const [item] = this.queue.splice(index, 1)
      item.signal?.removeEventListener('abort', item.abort)
      this.start(item)
    }
  }

  canStart(profileId) {
    if ((this.activeByProfile.get(profileId) || 0) >= this.maximumConcurrentPerProfile) return false
    const health = this.healthByProfile.get(profileId)
    if (!health?.openUntil || health.openUntil <= Date.now()) return true
    this.armWake(profileId, health.openUntil - Date.now())
    return false
  }

  armWake(profileId, delayMs) {
    if (this.wakeTimers.has(profileId)) return
    const timer = setTimeout(() => {
      this.wakeTimers.delete(profileId)
      this.pump()
    }, Math.max(1, delayMs))
    this.wakeTimers.set(profileId, timer)
  }

  async start(item) {
    this.active += 1
    this.activeByProfile.set(item.profileId, (this.activeByProfile.get(item.profileId) || 0) + 1)
    try {
      const value = await item.task()
      this.healthByProfile.set(item.profileId, { consecutiveFailures: 0, openUntil: 0 })
      item.resolve(value)
    } catch (error) {
      // Caller/resource budgets do not demonstrate a provider outage.
      if (['MODEL_API_CANCELLED', 'MODEL_API_RESPONSE_TOO_LARGE', 'MODEL_API_BUDGET_EXHAUSTED'].includes(error.code)) {
        item.reject(error)
        return
      }
      const previous = this.healthByProfile.get(item.profileId) || { consecutiveFailures: 0, openUntil: 0 }
      const consecutiveFailures = previous.consecutiveFailures + 1
      const openUntil = consecutiveFailures >= this.circuitFailureThreshold ? Date.now() + this.circuitCooldownMs : 0
      this.healthByProfile.set(item.profileId, { consecutiveFailures, openUntil })
      if (openUntil) this.armWake(item.profileId, this.circuitCooldownMs)
      item.reject(error)
    } finally {
      this.active -= 1
      this.activeByProfile.set(item.profileId, Math.max(0, (this.activeByProfile.get(item.profileId) || 1) - 1))
      this.pump()
    }
  }

  diagnostics() {
    return {
      maximum_concurrent: this.maximumConcurrent,
      maximum_concurrent_per_profile: this.maximumConcurrentPerProfile,
      active: this.active,
      queued: this.queue.length,
      active_by_profile: Object.fromEntries(this.activeByProfile),
      health_by_profile: Object.fromEntries(this.healthByProfile)
    }
  }
}

let singleton = null

function globalProviderScheduler(config = {}) {
  if (!singleton) singleton = new GlobalProviderScheduler(config)
  return singleton
}

module.exports = { GlobalProviderScheduler, globalProviderScheduler, applySchedulerConcurrency }
