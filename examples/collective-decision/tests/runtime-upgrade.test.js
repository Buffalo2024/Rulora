'use strict'
const test = require('node:test'), assert = require('node:assert/strict')
const { requestWithRetry, MultiModelProvider, extractResponseContent } = require('../src/providers/multi-model-provider')
const { normalizeLivenessPolicy } = require('../src/providers/model-liveness')
const { adaptMessages } = require('../src/providers/message-adapter')
const { issueProblem } = require('../src/enterprise-review-issue-contract')
const { validateReview, REVIEW_RULES, buildReviewPrompt } = require('../src/enterprise-deliberation')
const { assertRepairPreservesVerdict, nextReviewRepair } = require('../src/enterprise-review-repair')
const { reviewFeedback } = require('../src/enterprise-review-feedback')
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const { GlobalProviderScheduler, applySchedulerConcurrency } = require('../src/global-provider-scheduler')
const policy = { mode: 'liveness', stream: true, probe_interval_ms: 10, probe_timeout_ms: 15,
  consecutive_failures: 3, maximum_elapsed_ms: 500, maximum_response_bytes: 4096 }
const options = { url: 'https://api.example.invalid/v1/chat/completions', init: {}, timeoutMs: 1,
  maxRetries: 0, requestPolicy: policy, delayImpl: async () => {} }

test('liveness is opt-in, finite, and rejects unbounded or malformed policy values', () => {
  assert.equal(normalizeLivenessPolicy(null), null)
  for (const key of ['maximum_elapsed_ms', 'maximum_response_bytes', 'probe_interval_ms', 'probe_timeout_ms', 'consecutive_failures']) {
    for (const value of [null, 0, -1, Infinity, 2 ** 32, '10']) assert.throws(() => normalizeLivenessPolicy({ ...policy, [key]: value }))
  }
  assert.throws(() => normalizeLivenessPolicy({ ...policy, stream: 'true' }))
})

test('slow response is accepted beyond legacy timeout; probes never receive the enterprise body', async () => {
  let probes = 0
  const response = await requestWithRetry({ ...options, init: { body: 'synthetic confidential input', headers: { Authorization: 'Bearer synthetic-test' } }, fetchImpl: async (url, init) => {
    if (init.method === 'GET') {
      probes++; assert.equal(url, 'https://api.example.invalid/v1/models'); assert.equal(init.body, undefined)
      assert.equal(init.redirect, 'error'); return new Response('{}', { status: 405 })
    }
    await pause(70); return new Response('{"ok":true}')
  } })
  assert.deepEqual(await response.json(), { ok: true }); assert(probes > 0)
  assert.equal(response.transport_diagnostics[0].timeout_ms, null)
})

test('healthy endpoint cannot cause infinite wait and budget exhaustion does not retry', async () => {
  let calls = 0
  await assert.rejects(requestWithRetry({ ...options, maxRetries: 5, requestPolicy: { ...policy, maximum_elapsed_ms: 60 }, fetchImpl: async (_, init) => {
    if (init.method === 'GET') return new Response('{}')
    calls++; return new Promise(() => {})
  } }), e => e.code === 'MODEL_API_BUDGET_EXHAUSTED' && !e.retryable)
  assert.equal(calls, 1)
})

test('failed and never-resolving probes stop inside the configured consecutive budget', async () => {
  for (const never of [false, true]) {
    let probes = 0, signal
    await assert.rejects(requestWithRetry({ ...options, fetchImpl: async (_, init) => {
      if (init.method === 'GET') { probes++; return never ? new Promise(() => {}) : new Response('', { status: 503 }) }
      signal = init.signal; return new Promise(() => {})
    } }), e => e.code === 'MODEL_API_NETWORK_FAILURE' && e.transport_diagnostics[0].liveness.consecutive_failures === 3)
    assert.equal(probes, 3); assert(signal.aborted)
  }
})

test('caller cancellation is terminal even when fetch ignores AbortSignal', async () => {
  const controller = new AbortController()
  const pending = requestWithRetry({ ...options, maxRetries: 5, init: { signal: controller.signal }, fetchImpl: async () => new Promise(() => {}) })
  controller.abort()
  await assert.rejects(pending, { code: 'MODEL_API_CANCELLED' })
})

test('split SSE completion, heartbeats and UTF-8 preserve content; cancel cannot hold cleanup', async () => {
  const encoder = new TextEncoder()
  const full = encoder.encode(': heartbeat\n\ndata: {"choices":[{"delta":{"content":"中文"}}]}\n\ndata: [DONE]')
  const response = await requestWithRetry({ ...options, fetchImpl: async () => {
    let offset = 0
    return new Response(new ReadableStream({ pull(controller) {
      if (offset >= full.length) return controller.close()
      controller.enqueue(full.slice(offset, offset + 3)); offset += 3
    }, cancel() { return new Promise(() => {}) } }), { headers: { 'content-type': 'text/event-stream' } })
  } })
  assert.equal(await extractResponseContent('openai_compatible', response), '中文')
})

test('Anthropic message_stop completes; truncated streams and oversize payloads fail closed', async () => {
  const headers = { 'content-type': 'text/event-stream' }
  const response = await requestWithRetry({ ...options, fetchImpl: async () => new Response('data: {"type":"content_block_delta","delta":{"text":"ok"}}\n\ndata: {"type":"message_stop"}\n\n', { headers }) })
  assert.equal(await extractResponseContent('anthropic', response), 'ok')
  await assert.rejects(requestWithRetry({ ...options, fetchImpl: async () => new Response('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n', { headers }) }), { liveness_reason: 'stream_closed_before_completion' })
  await assert.rejects(requestWithRetry({ ...options, requestPolicy: { ...policy, maximum_response_bytes: 5 }, fetchImpl: async () => new Response('123456') }), { code: 'MODEL_API_RESPONSE_TOO_LARGE', retryable: false })
})

test('401 remains an authentication failure, not a failed completion or automatic fallback', async () => {
  let calls = 0
  await assert.rejects(requestWithRetry({ ...options, maxRetries: 3, fetchImpl: async () => { calls++; return new Response('denied', { status: 401 }) } }), { code: 'MODEL_API_AUTHENTICATION_FAILED' })
  assert.equal(calls, 1)
})

test('message adapter is optional and pure: dialogue, evidence and tool messages remain unchanged', () => {
  const messages = [{ role: 'system', content: 'First rule' }, { role: 'user', content: [{ type: 'text', text: 'Synthetic evidence' }, { type: 'image_url', image_url: { url: 'https://example.invalid/image.png' } }] },
    { role: 'system', content: 'Reference registry' }, { role: 'assistant', content: null, tool_calls: [{ id: 'call1' }] }, { role: 'tool', tool_call_id: 'call1', content: 'Tool output' }]
  const before = structuredClone(messages), descriptor = { type: 'system-first-v1', enabled: true }
  const adapted = adaptMessages(messages, descriptor)
  assert.deepEqual(messages, before); assert.equal(adapted.messages[0].content, 'First rule\n\nReference registry')
  assert.deepEqual(adapted.messages.slice(1), before.filter(m => m.role !== 'system'))
  assert.equal(adaptMessages(adapted.messages, descriptor).audit.applied, false)
  assert.equal(adaptMessages(messages, { ...descriptor, enabled: false }), null)
  assert(!JSON.stringify(adapted.audit).includes('Synthetic evidence'))
  assert.throws(() => adaptMessages([...messages, { role: 'system', name: 'named', content: 'Rule' }], descriptor), { code: 'MODEL_MESSAGE_ADAPTER_INVALID' })
})

test('provider applies configured message adapter after wire overrides without altering other suites', () => {
  const profile = { provider: 'openai_compatible', api_key_env: 'KEY', model: 'synthetic', base_url: 'https://example.invalid/v1', json_mode: false }
  const messages = [{ role: 'user', content: 'Evidence' }, { role: 'system', content: 'Rule' }]
  for (const enabled of [false, true]) {
    const provider = new MultiModelProvider({ config: { contract_version: '1.0.0', profiles: { one: profile }, message_adapter: { type: 'system-first-v1', enabled } }, environment: { KEY: 'test' }, requestPolicy: policy })
    const request = provider.buildRequest({ ...profile, extra_body: { messages } }, [])
    const body = JSON.parse(request.init.body)
    assert.equal(body.messages[0].role, enabled ? 'system' : 'user'); assert.equal(body.stream, true)
    assert.equal(Boolean(request.message_adapter), enabled)
  }
})

function review() {
  return { consistent: true, selected_seat_id: 'good', authority: 'within_rules', unresolved_gaps: [], applied_rule_ids: ['SUPPORTED_WHOLE_CANDIDATE'], review_reason: 'Select a complete supported candidate.',
    candidate_reviews: ['good', 'other'].map(seat_id => ({ seat_id, assessment: seat_id === 'good' ? 'supported' : 'unsupported', independence: 'independent', reason: 'Independent judgment', task_coverage: 'sufficient',
      action_reviews: [{ id: seat_id === 'good' ? 3 : 7, assessment: 'supported', reason: 'Known basis', necessity: 'required', omission_impact: 'Known residual risk', direction_assessment: 'compatible', residual_risk_source: 'known_fact' }],
      issues: seat_id === 'good' ? [] : [{ kind: 'action_classification_error', action_ids: [7], reason: 'Description mismatches action definition.' }], combination_assessment: 'compatible', combination_reason: 'Actions are compatible' })) }
}
const candidates = [{ seat_id: 'good', recommendations: [3] }, { seat_id: 'other', recommendations: [7] }]
const context = { stage: 'condition', candidates, arbitrationRules: REVIEW_RULES }
test('classification and conflict have different cardinalities; unselected findings cannot be erased', () => {
  assert.equal(issueProblem({ kind: 'action_conflict', action_ids: [7], reason: 'r' }, [7]), 'ACTION_CONFLICT_REQUIRES_MULTIPLE_ACTIONS')
  assert.equal(issueProblem({ kind: 'action_classification_error', action_ids: [7], reason: 'r' }, [7]), null)
  const before = review(), after = structuredClone(before)
  assert.deepEqual(validateReview(before, candidates, 'condition', REVIEW_RULES), [])
  after.candidate_reviews[1].issues = []
  assert.throws(() => assertRepairPreservesVerdict(before, after, context), { code: 'ENTERPRISE_REVIEW_VERDICT_DRIFT' })
  const invalid = review(); invalid.candidate_reviews[1].issues[0].kind = 'action_conflict'
  assert.doesNotThrow(() => assertRepairPreservesVerdict(invalid, before, context))
  assert(reviewFeedback(invalid, context).findings.some(f => f.code === 'ACTION_CONFLICT_REQUIRES_MULTIPLE_ACTIONS'))
  const selected = review(); selected.selected_seat_id = 'other'; selected.candidate_reviews[1].assessment = 'supported'
  assert(validateReview(selected, candidates, 'condition', REVIEW_RULES).length > 0)
})

test('format repair cannot replace blocking gap contents or add endless repair attempts', () => {
  const before = review(); before.consistent = false; before.selected_seat_id = null; before.unresolved_gaps = ['Synthetic evidence gap']
  const after = structuredClone(before); after.unresolved_gaps = ['Different gap']
  assert.throws(() => assertRepairPreservesVerdict(before, after, context), { code: 'ENTERPRISE_REVIEW_VERDICT_DRIFT' })
  const errors = ['复核缺少组合判定']
  assert.equal(nextReviewRepair({ attempt: 1, value: before, errors, reviewContext: context, previousRepairMode: 'business_reassessment' }).mode, 'format_only')
  assert.equal(nextReviewRepair({ attempt: 2, value: before, errors, reviewContext: context, previousRepairMode: 'business_reassessment' }), null)
})

test('prompts carry issue contracts in the business layer, never via the transport adapter', () => {
  const prompt = buildReviewPrompt({ stage: 'condition', policy: '', question: {}, rules: [], candidates, evidence: [], arbitrationRules: REVIEW_RULES })
  assert(JSON.parse(prompt[1].content).review_output_contract.candidate_reviews.issues.kind_values.includes('action_classification_error'))
  assert.deepEqual(adaptMessages(prompt, { type: 'system-first-v1' }).messages, prompt)
})

test('completed stream ignores later content; malformed events cannot silently disappear', async () => {
  const headers = { 'content-type': 'text/event-stream' }
  const complete = 'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\ndata: {"error":{"status":503}}\n\ndata: {"choices":[{"delta":{"content":"injected"}}]}\n\n'
  const response = await requestWithRetry({ ...options, fetchImpl: async () => new Response(complete, { headers }) })
  assert.equal(await extractResponseContent('openai_compatible', response), 'ok')
  const malformed = new Response('data: malformed\n\ndata: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n', { headers })
  await assert.rejects(extractResponseContent('openai_compatible', malformed), { code: 'MODEL_API_STREAM_INVALID' })
})

test('live scheduler updates stay finite, atomic and preserve already-running work', async () => {
  const scheduler = new GlobalProviderScheduler({ maximumConcurrent: 1, maximumConcurrentPerProfile: 1 })
  let release, started = 0
  const gate = new Promise(resolve => { release = resolve })
  const calls = Array.from({ length: 4 }, () => scheduler.schedule('same', 'synthetic', () => { started++; return gate }))
  assert.equal(started, 1)
  for (const invalid of [null, 0, -1, Infinity, '4']) assert.throws(() => applySchedulerConcurrency(scheduler, { maximumConcurrent: 4, maximumConcurrentPerProfile: invalid }))
  assert.equal(scheduler.maximumConcurrent, 1)
  assert.equal(applySchedulerConcurrency(scheduler, { maximumConcurrent: 3, maximumConcurrentPerProfile: 3 }).active, 3)
  assert.equal(started, 3)
  applySchedulerConcurrency(scheduler, { maximumConcurrent: 1, maximumConcurrentPerProfile: 1 })
  assert.equal(started, 3)
  release(); await Promise.all(calls)
  assert.equal(started, 4); assert.equal(scheduler.diagnostics().active, 0)
})

test('diagnostics preserve liveness evidence but not arbitrary nested credentials or body', () => {
  const { failureDetails, failureMessage } = require('../src/runtime-failure')
  const row = { timeout_ms: null, liveness: { mode: 'liveness', probe_count: 3, bytes_received: 100,
    authorization: 'synthetic-secret', raw_content: 'synthetic-private-body', last_probe_at: 'synthetic-secret' } }
  const details = failureDetails({ code: 'MODEL_API_NETWORK_FAILURE', message: 'connection ended', transport_diagnostics: [row], routing_attempts: [{ model_profile: 'test', transport_diagnostics: [row] }] })
  assert.equal(details.transport_diagnostics[0].liveness.probe_count, 3)
  assert.equal(details.routing_attempts[0].transport_diagnostics[0].liveness.bytes_received, 100)
  assert(!JSON.stringify(details).includes('synthetic-'))
  assert(!failureMessage({ ...details, code: 'MODEL_API_TIMEOUT' }).includes('上限0秒'))
})

test('adapter activation changes readiness fingerprint; empty annotations never erase substantive bases', () => {
  const { modelConfigurationFingerprint } = require('../src/model-readiness')
  const config = { contract_version: '1.0.0', profiles: {} }
  const activated = { ...config, message_adapter: { type: 'system-first-v1', enabled: true } }
  assert.notEqual(modelConfigurationFingerprint(config, {}), modelConfigurationFingerprint(activated, {}))
  assert.notEqual(modelConfigurationFingerprint(activated, {}), modelConfigurationFingerprint({ ...activated, message_adapter: { ...activated.message_adapter, enabled: false } }, {}))
  const { bindOutput } = require('../src/enterprise-reference-binding')
  const binding = { entries: [] }
  for (const no_action_basis of [[], {}, { existing_arrangements: [], why_sufficient: ' ', direction_relation: '' }]) {
    const input = { recommendations: [3], no_action_basis }, before = structuredClone(input), operations = []
    const value = bindOutput(input, binding, operations)
    assert.equal(Object.hasOwn(value, 'no_action_basis'), false); assert.deepEqual(input, before)
    assert(operations.some(x => x.operation === 'exclude_empty_no_action_basis_from_actual_candidate'))
  }
  const basis = { why_sufficient: 'Synthetic nonempty basis' }
  assert.deepEqual(bindOutput({ recommendations: [3], no_action_basis: basis }, binding, []).no_action_basis, basis)
  assert.deepEqual(bindOutput({ recommendations: [13], no_action_basis: {} }, binding, []).no_action_basis, {})
  assert.equal(Object.hasOwn(bindOutput({ recommendations: [10], no_action_basis: [] }, binding, []), 'no_action_basis'), false)
  assert.doesNotThrow(() => reviewFeedback(review(), { ...context, candidates: [{ ...candidates[0], label_assessments: [null] }, candidates[1]] }))
})
