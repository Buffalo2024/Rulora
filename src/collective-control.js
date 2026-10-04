'use strict'

class CollectiveControlError extends Error {
  constructor(code, message) { super(message); this.name = 'CollectiveControlError'; this.code = code }
}

class CollectiveControl {
  #pools = new WeakSet()
  constructor({ quorum = 2 } = {}) {
    if (!Number.isInteger(quorum) || quorum < 1) throw new TypeError('quorum must be a positive integer')
    this.quorum = quorum
  }

  freezeCandidates(submissions) {
    if (!Array.isArray(submissions)) throw new TypeError('submissions must be an array')
    const ids = new Set()
    const candidates = Array.from(submissions, (entry, index) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new CollectiveControlError('INVALID_CANDIDATE', 'Candidate must be a plain JSON object')
      const copy = cloneJson(entry)
      const id = Object.hasOwn(copy, 'id') ? copy.id : `candidate-${index + 1}`
      if (typeof id !== 'string' || !id.trim()) throw new CollectiveControlError('INVALID_CANDIDATE', 'Candidate id must be a non-empty string')
      if (ids.has(id)) throw new CollectiveControlError('DUPLICATE_CANDIDATE', `Duplicate candidate id: ${id}`)
      ids.add(id)
      return Object.freeze({ ...copy, id })
    })
    if (candidates.length < this.quorum) throw new CollectiveControlError('QUORUM_NOT_MET', 'Not enough candidates to continue')
    Object.freeze(candidates)
    this.#pools.add(candidates)
    return candidates
  }

  select(candidates, selectedId) {
    if (!this.#pools.has(candidates)) throw new CollectiveControlError('INVALID_POOL', 'Use a pool frozen by this controller instance')
    const selected = candidates.find(candidate => candidate.id === selectedId)
    if (!selected) throw new CollectiveControlError('UNKNOWN_CANDIDATE', 'Reviewer must select an id from the frozen pool')
    return selected
  }
}

// Explicit JSON-only snapshots. Never invoke accessors or silently coerce values.
function cloneJson(value, ancestors = new Set(), depth = 0) {
  const reject = () => { throw new CollectiveControlError('INVALID_CANDIDATE', 'Candidates require finite, acyclic plain JSON data (maximum depth 100)') }
  if (depth > 100) reject()
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'object' || ancestors.has(value)) reject()
  const array = Array.isArray(value)
  if (!array && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) reject()
  ancestors.add(value)
  const result = array ? [] : {}
  const keys = Reflect.ownKeys(value).filter(key => !(array && key === 'length'))
  if (array && keys.length !== value.length) reject()
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (typeof key !== 'string' || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) reject()
    if (array && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length)) reject()
    Object.defineProperty(result, key, { value: cloneJson(descriptor.value, ancestors, depth + 1), enumerable: true, writable: true, configurable: true })
  }
  ancestors.delete(value)
  return Object.freeze(result)
}

module.exports = { CollectiveControl, CollectiveControlError }
