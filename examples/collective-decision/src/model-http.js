const { Agent, fetch } = require('undici')
const DEFAULT_MODEL_TIMEOUT_MS = 600000

// Only model traffic uses this dispatcher. Caller AbortSignal owns the whole
// deadline, including headers and body; no hidden shorter HTTP deadline.
function createModelFetch({ fetchImpl = fetch, AgentImpl = Agent } = {}) {
  let dispatcher
  const modelFetch = (url, init = {}) => {
    dispatcher ||= new AgentImpl({ headersTimeout: 0, bodyTimeout: 0, connect: { timeout: DEFAULT_MODEL_TIMEOUT_MS } })
    return fetchImpl(url, { ...init, dispatcher })
  }
  modelFetch.close = async () => { if (dispatcher) { await dispatcher.close(); dispatcher = null } }
  return modelFetch
}
const modelFetch = createModelFetch()
module.exports = { modelFetch, createModelFetch, DEFAULT_MODEL_TIMEOUT_MS }
