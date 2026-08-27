'use strict'

class CollectiveControlError extends Error {
  constructor(code, message) { super(message); this.name = 'CollectiveControlError'; this.code = code }
}

class CollectiveControl {
  constructor({ quorum = 2 } = {}) {
    if (!Number.isInteger(quorum) || quorum < 1) throw new TypeError('quorum must be a positive integer')
    this.quorum = quorum
  }

  freezeCandidates(submissions) {
    if (!Array.isArray(submissions)) throw new TypeError('submissions must be an array')
    const ids = new Set()
    const candidates = submissions.map((entry, index) => {
      const id = entry.id || `candidate-${index + 1}`
      if (ids.has(id)) throw new CollectiveControlError('DUPLICATE_CANDIDATE', `Duplicate candidate id: ${id}`)
      ids.add(id)
      return Object.freeze({ ...entry, id })
    })
    if (candidates.length < this.quorum) throw new CollectiveControlError('QUORUM_NOT_MET', 'Not enough candidates to continue')
    return Object.freeze(candidates)
  }

  select(candidates, selectedId) {
    const selected = candidates.find(candidate => candidate.id === selectedId)
    if (!selected) throw new CollectiveControlError('UNKNOWN_CANDIDATE', 'Reviewer must select an id from the frozen pool')
    return selected
  }
}

module.exports = { CollectiveControl, CollectiveControlError }
