'use strict'

// Optional transport policy, not a business loop or proof of model progress.
const DEFAULT_LIVENESS_POLICY = Object.freeze({
  mode: 'liveness', stream: true, probe_interval_ms: 60000,
  probe_timeout_ms: 15000, consecutive_failures: 3,
  maximum_elapsed_ms: 1200000, maximum_response_bytes: 8388608
})

function normalizeLivenessPolicy(value) {
  if (!value || value.mode !== 'liveness') return null
  const policy = { ...DEFAULT_LIVENESS_POLICY, ...value }
  for (const key of ['probe_interval_ms', 'probe_timeout_ms', 'consecutive_failures', 'maximum_elapsed_ms', 'maximum_response_bytes']) {
    if (!Number.isSafeInteger(policy[key]) || policy[key] <= 0 || policy[key] > 2147483647) {
      throw new Error(`Invalid model liveness policy: ${key}`)
    }
  }
  if (typeof policy.stream !== 'boolean') throw new Error('Invalid model liveness policy: stream')
  return policy
}

function failure(reason, code = 'MODEL_API_NETWORK_FAILURE', retryable = true) {
  return Object.assign(new Error(`Model request stopped: ${reason}`), {
    code, retryable, is_model_transport_failure: true,
    connectivity_category: retryable ? 'network' : 'request_budget', liveness_reason: reason
  })
}

function probeUrl(url) {
  const target = new URL(url)
  if (target.username || target.password || !['http:', 'https:'].includes(target.protocol)) throw new Error('Invalid model endpoint')
  if (!/\/(?:chat\/completions|messages|evaluate)\/?$/.test(target.pathname)) throw new Error('Unsupported model liveness endpoint')
  target.pathname = target.pathname.replace(/\/(?:chat\/completions|messages|evaluate)\/?$/, '/models')
  target.search = ''; target.hash = ''
  return target.href
}

async function requestWhileAlive({ fetchImpl, url, init, controller, policy, diagnostic }) {
  const endpoint = probeUrl(url)
  const started = Date.now()
  let lastProgress = started, failures = 0, stopped = false, probeTimer, totalTimer, probeController, reader
  const metrics = diagnostic.liveness = {
    mode: 'liveness', probe_count: 0, consecutive_failures: 0, bytes_received: 0,
    maximum_elapsed_ms: policy.maximum_elapsed_ms, maximum_response_bytes: policy.maximum_response_bytes,
    last_progress_at: new Date(started).toISOString()
  }
  let rejectStopped
  const stoppedRequest = new Promise((_, reject) => { rejectStopped = reject })
  const stop = error => {
    if (stopped) return
    stopped = true
    rejectStopped(error)
    controller.abort()
  }
  const progress = bytes => {
    lastProgress = Date.now(); failures = 0
    metrics.last_progress_at = new Date(lastProgress).toISOString()
    metrics.consecutive_failures = 0; metrics.bytes_received += bytes
    if (metrics.bytes_received > policy.maximum_response_bytes) throw failure('response_size_limit', 'MODEL_API_RESPONSE_TOO_LARGE', false)
  }
  const arm = () => { if (!stopped) probeTimer = setTimeout(check, policy.probe_interval_ms) }
  const check = async () => {
    if (stopped) return
    if (Date.now() - lastProgress < policy.probe_interval_ms) return arm()
    const progressAtStart = lastProgress
    probeController = new AbortController()
    let deadlineTimer, reply
    metrics.probe_count++; metrics.last_probe_at = new Date().toISOString()
    try {
      const deadline = new Promise((_, reject) => {
        deadlineTimer = setTimeout(() => { reject(new Error('probe timeout')); probeController.abort() }, policy.probe_timeout_ms)
      })
      reply = await Promise.race([deadline, fetchImpl(endpoint, {
        method: 'GET', headers: { ...init.headers }, redirect: 'error', signal: probeController.signal
      })])
      if (stopped) return
      metrics.last_probe_status = reply.status
      // Endpoint reachability is not progress of this particular inference.
      failures = reply.status >= 200 && reply.status < 500 ? 0 : failures + 1
    } catch { if (!stopped) failures++ }
    finally {
      clearTimeout(deadlineTimer); probeController?.abort()
      // Cancellation is best effort: a custom stream must not hang cleanup.
      try { Promise.resolve(reply?.body?.cancel?.()).catch(() => {}) } catch {}
    }
    if (stopped) return
    if (lastProgress !== progressAtStart) failures = 0
    metrics.consecutive_failures = failures
    if (failures >= policy.consecutive_failures) return stop(failure('consecutive_liveness_probe_failures'))
    arm()
  }
  const interrupted = () => stop(failure('caller_cancelled', 'MODEL_API_CANCELLED', false))
  if (init.signal?.aborted) throw failure('caller_cancelled', 'MODEL_API_CANCELLED', false)
  init.signal?.addEventListener('abort', interrupted, { once: true })
  totalTimer = setTimeout(() => stop(failure('elapsed_budget_exhausted', 'MODEL_API_BUDGET_EXHAUSTED', false)), policy.maximum_elapsed_ms)
  arm()
  try {
    return await Promise.race([stoppedRequest, (async () => {
      const response = await fetchImpl(url, { ...init, signal: controller.signal })
      Object.assign(diagnostic, { phase: 'reading_body', http_status: response.status,
        headers_ms: Date.now() - started, request_id: response.headers?.get?.('x-request-id') || null })
      progress(0)
      let raw
      if (response.body?.getReader) {
        reader = response.body.getReader()
        const decoder = new TextDecoder(), chunks = []
        const sse = response.ok && /text\/event-stream/i.test(response.headers?.get?.('content-type') || '')
        let pending = '', completed = false
        const line = text => {
          if (!text.startsWith('data:')) return
          const data = text.slice(5).trim()
          if (data === '[DONE]') { completed = true; return }
          try {
            const event = JSON.parse(data)
            if (event.type === 'message_stop' || event.type === 'error' || event.error) completed = true
          } catch { /* Invalid payload remains subject to output validation. */ }
        }
        for (;;) {
          const part = await reader.read()
          if (part.done) break
          progress(part.value.byteLength)
          const text = decoder.decode(part.value, { stream: true }); chunks.push(text)
          if (sse) {
            pending += text
            let end
            while ((end = pending.indexOf('\n')) >= 0) {
              line(pending.slice(0, end).replace(/\r$/, '')); pending = pending.slice(end + 1)
              if (completed) break
            }
            if (completed) break
          }
        }
        const tail = decoder.decode(); chunks.push(tail)
        if (sse && !completed) line(pending + tail)
        raw = chunks.join('')
        if (sse && !completed) throw failure('stream_closed_before_completion')
      } else if (typeof response.text === 'function') {
        raw = await response.text(); progress(Buffer.byteLength(raw))
        if (response.ok && /text\/event-stream/i.test(response.headers?.get?.('content-type') || '') &&
            !raw.split(/\r?\n/).some(line => /^data:\s*\[DONE\]\s*$/.test(line) || (() => {
              try { const event = JSON.parse(line.replace(/^data:\s*/, '')); return line.startsWith('data:') && (event.type === 'message_stop' || event.type === 'error' || event.error) } catch { return false }
            })())) throw failure('stream_closed_before_completion')
      } else if (typeof response.json === 'function') {
        raw = JSON.stringify(await response.json()); progress(Buffer.byteLength(raw))
      }
      if (raw !== undefined) Object.defineProperties(response, {
        text: { configurable: true, value: async () => raw },
        json: { configurable: true, value: async () => JSON.parse(raw) }
      })
      diagnostic.phase = 'complete'
      return response
    })()])
  } finally {
    stopped = true; clearTimeout(probeTimer); clearTimeout(totalTimer); probeController?.abort(); controller.abort()
    init.signal?.removeEventListener('abort', interrupted)
    try { Promise.resolve(reader?.cancel()).catch(() => {}) } catch {}
    diagnostic.elapsed_ms = Date.now() - started
  }
}

module.exports = { DEFAULT_LIVENESS_POLICY, normalizeLivenessPolicy, requestWhileAlive }
