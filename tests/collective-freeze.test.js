'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { CollectiveControl } = require('../src')

test('snapshot isolates original nested objects and prevents nested result mutation', () => {
  const controller = new CollectiveControl({ quorum: 1 })
  const input = { id: 'a', answer: { codes: [3], details: [{ ok: true }] } }
  const pool = controller.freezeCandidates([input])
  input.answer.codes.push(9)
  input.answer.details[0].ok = false
  assert.deepEqual(pool[0].answer.codes, [3])
  assert.equal(pool[0].answer.details[0].ok, true)
  assert.throws(() => pool[0].answer.codes.push(7), TypeError)
  assert.throws(() => { controller.select(pool, 'a').answer.details[0].ok = false }, TypeError)
})
test('only an authentic pool belonging to the same controller is accepted', () => {
  const controller = new CollectiveControl({ quorum: 1 })
  const pool = controller.freezeCandidates([{ id: 'a', answer: 1 }])
  for (const forged of [[...pool], Object.freeze([{ id: 'a', answer: 2 }]), null]) {
    assert.throws(() => controller.select(forged, 'a'), { code: 'INVALID_POOL' })
  }
  assert.throws(() => new CollectiveControl({ quorum: 1 }).select(pool, 'a'), { code: 'INVALID_POOL' })
  assert.throws(() => controller.select(pool, 'unknown'), { code: 'UNKNOWN_CANDIDATE' })
})
test('invalid data is rejected without invoking getters or toJSON', () => {
  const controller = new CollectiveControl({ quorum: 1 })
  const cyclic = {}; cyclic.self = cyclic
  let getterCalls = 0
  const accessor = { get value() { getterCalls++; return 1 } }
  const invalid = [undefined, NaN, Infinity, new Date(), new Map(), new Set(), 1n, () => {}, cyclic, accessor, { toJSON() { throw Error('must not run') } }, [1, , 3]]
  for (const value of invalid) assert.throws(() => controller.freezeCandidates([{ value }]), { code: 'INVALID_CANDIDATE' })
  assert.equal(getterCalls, 0)
  for (const entry of [null, [], 'text', { id: '' }, { id: 2 }]) assert.throws(() => controller.freezeCandidates([entry]), { code: 'INVALID_CANDIDATE' })
})
test('quorum, duplicate IDs, special keys and shared references are deterministic', () => {
  const controller = new CollectiveControl({ quorum: 2 })
  assert.throws(() => controller.freezeCandidates([]), { code: 'QUORUM_NOT_MET' })
  assert.throws(() => controller.freezeCandidates([{ id: 'a' }, { id: 'a' }]), { code: 'DUPLICATE_CANDIDATE' })
  const shared = { value: true }
  const pool = controller.freezeCandidates([JSON.parse('{"__proto__":{"polluted":true}}'), { left: shared, right: shared }])
  assert.equal(pool[0].id, 'candidate-1')
  assert.equal({}.polluted, undefined)
  assert.equal(Object.hasOwn(pool[0], '__proto__'), true)
  assert.deepEqual(pool[1].left, pool[1].right)
})
