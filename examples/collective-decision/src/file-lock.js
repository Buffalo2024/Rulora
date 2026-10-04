const fs = require('node:fs/promises')
const crypto = require('node:crypto')
const os = require('node:os')
const processStartedAt = Date.now() - process.uptime() * 1000
async function processStartToken(pid) {
  try {
    const raw = await fs.readFile(`/proc/${pid}/stat`, 'utf8')
    const boot = await fs.readFile('/proc/sys/kernel/random/boot_id', 'utf8')
    return `${boot.trim()}:${raw.slice(raw.lastIndexOf(')') + 2).split(/\s+/)[19]}`
  } catch { return null }
}

async function withFileLock(lockPath, callback, {
  retries = 200, intervalMs = 25, staleMs = 30000,
  heartbeatMs = Math.max(1000, Math.floor(staleMs / 3)), onStaleRecovered = null
} = {}) {
  const lockId = crypto.randomUUID()
  const hostname = os.hostname()
  const owner = `${hostname}:${process.pid}`
  const processToken = await processStartToken(process.pid)
  let acquired = false
  let heartbeatTimer
  let heartbeatStopped = false
  let heartbeatPromise = Promise.resolve()
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const now = new Date()
    try {
      const handle = await fs.open(lockPath, 'wx')
      try {
        await handle.writeFile(JSON.stringify({
          lock_id: lockId, owner, pid: process.pid, hostname, process_start_token: processToken,
          created_at: now.toISOString(), updated_at: now.toISOString(), heartbeat_at: now.toISOString(),
          expires_at: new Date(now.getTime() + staleMs).toISOString()
        }))
      } finally { await handle.close() }
      acquired = true
      break
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      const recovered = await recoverStaleLock(lockPath, { staleMs, hostname })
      if (recovered) {
        if (typeof onStaleRecovered === 'function') await onStaleRecovered(recovered)
        continue
      }
      if (attempt === retries) {
        const timeout = new Error(`lock timeout: ${lockPath}`)
        timeout.code = 'LOCK_TIMEOUT'
        throw timeout
      }
      await wait(intervalMs)
    }
  }
  if (!acquired) throw new Error(`lock was not acquired: ${lockPath}`)
  const scheduleHeartbeat = () => {
    if (heartbeatStopped) return
    heartbeatTimer = setTimeout(() => {
      heartbeatPromise = refreshOwnedLock(lockPath, lockId, staleMs).catch(() => {}).finally(scheduleHeartbeat)
    }, heartbeatMs)
    heartbeatTimer.unref?.()
  }
  scheduleHeartbeat()
  try { return await callback() } finally {
    heartbeatStopped = true
    clearTimeout(heartbeatTimer)
    await heartbeatPromise
    await releaseOwnedLock(lockPath, lockId)
  }
}

async function recoverStaleLock(lockPath, { staleMs, hostname }) {
  let metadata = null
  let stat
  try {
    const [raw, currentStat] = await Promise.all([fs.readFile(lockPath, 'utf8'), fs.stat(lockPath)])
    stat = currentStat
    try { metadata = JSON.parse(raw) } catch {}
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
  const now = Date.now()
  const expiresAt = Date.parse(metadata?.expires_at || '')
  const heartbeatAt = Date.parse(metadata?.heartbeat_at || metadata?.updated_at || metadata?.acquired_at || '')
  const expired = Number.isFinite(expiresAt)
    ? expiresAt <= now
    : now - (Number.isFinite(heartbeatAt) ? heartbeatAt : stat.mtimeMs) > staleMs
  if (!expired || await ownerAppearsAlive(metadata, hostname)) return null
  const quarantinePath = `${lockPath}.stale-${crypto.randomUUID()}`
  try {
    await fs.rename(lockPath, quarantinePath)
    await fs.unlink(quarantinePath)
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
  return {
    stale_lock_recovered: true,
    prior_lock_id: metadata?.lock_id || null,
    prior_owner: metadata?.owner || (metadata?.pid ? `pid:${metadata.pid}` : null),
    recovered_at: new Date().toISOString()
  }
}

async function ownerAppearsAlive(metadata, localHostname) {
  const pid = Number(metadata?.pid)
  if (!Number.isInteger(pid) || pid <= 0) return false
  // An expired remote lease has no live heartbeat; container hostname changes
  // must not make its abandoned lock immortal. Unexpired leases stay protected.
  if (metadata?.hostname && metadata.hostname !== localHostname) return false
  if (metadata?.process_start_token) {
    const current = await processStartToken(pid)
    if (current && current !== metadata.process_start_token) return false
  } else if (pid === process.pid && Date.parse(metadata?.created_at || '') < processStartedAt - 1000) return false
  try { process.kill(pid, 0); return true } catch (error) { return error.code !== 'ESRCH' }
}

async function refreshOwnedLock(lockPath, lockId, staleMs) {
  const metadata = await readLock(lockPath)
  if (!metadata || metadata.lock_id !== lockId) return false
  const now = new Date()
  metadata.updated_at = now.toISOString()
  metadata.heartbeat_at = now.toISOString()
  metadata.expires_at = new Date(now.getTime() + staleMs).toISOString()
  await fs.writeFile(lockPath, JSON.stringify(metadata), { flag: 'w' })
  return true
}

async function releaseOwnedLock(lockPath, lockId) {
  const metadata = await readLock(lockPath)
  if (!metadata || metadata.lock_id !== lockId) return false
  try { await fs.unlink(lockPath) } catch (error) { if (error.code !== 'ENOENT') throw error }
  return true
}

async function readLock(lockPath) {
  try { return JSON.parse(await fs.readFile(lockPath, 'utf8')) } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return null
    throw error
  }
}

function wait(ms) { return new Promise(resolve => setTimeout(resolve, ms)) }

module.exports = { withFileLock }
