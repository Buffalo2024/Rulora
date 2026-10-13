'use strict'
const { canonicalJson, sha256 } = require('../utils')

// Wire ordering only. No business guards, candidate rewrites or evidence truncation.
function adaptMessages(messages, descriptor) {
  if (!descriptor || descriptor.enabled === false) return null
  if (descriptor.type !== 'system-first-v1') throw Object.assign(new Error('Unknown message adapter'), { code: 'MODEL_MESSAGE_ADAPTER_INVALID' })
  const original = structuredClone(messages)
  if (!Array.isArray(original) || original.some(m => !m || typeof m.role !== 'string' || !Object.hasOwn(m, 'content') && !Array.isArray(m.tool_calls))) {
    throw Object.assign(new Error('Adapter requires a complete message array'), { code: 'MODEL_MESSAGE_ADAPTER_INVALID' })
  }
  const systems = original.filter(m => m.role === 'system')
  let wire = original
  if (systems.length && !(systems.length === 1 && original[0].role === 'system')) {
    const content = systems.map(m => {
      if (Object.keys(m).some(k => !['role', 'content'].includes(k))) throw Object.assign(new Error('Cannot merge system metadata without loss'), { code: 'MODEL_MESSAGE_ADAPTER_INVALID' })
      if (typeof m.content === 'string') return m.content
      if (Array.isArray(m.content) && m.content.every(p => p?.type === 'text' && typeof p.text === 'string' && Object.keys(p).every(k => ['type', 'text'].includes(k)))) return m.content.map(p => p.text).join('\n\n')
      throw Object.assign(new Error('System merge requires plain text'), { code: 'MODEL_MESSAGE_ADAPTER_INVALID' })
    }).join('\n\n')
    wire = [{ role: 'system', content }, ...original.filter(m => m.role !== 'system')]
  }
  const inputHash = sha256(canonicalJson(original)), outputHash = sha256(canonicalJson(wire))
  return { messages: wire, audit: {
    type: descriptor.type, applied: inputHash !== outputHash,
    original_roles: original.map(m => m.role), wire_roles: wire.map(m => m.role),
    original_messages_sha256: inputHash, wire_messages_sha256: outputHash
  } }
}

module.exports = { adaptMessages }
