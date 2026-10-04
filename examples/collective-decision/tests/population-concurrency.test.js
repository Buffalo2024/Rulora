const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { PopulationStore } = require('../src/population-store')

test('concurrent role migration reloads winning state and preserves runtime metrics', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'population-cas-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const filePath = path.join(dir, 'population.json')
  const roles = [{ id: 'planner', label: 'planner', mission: 'old', method_family: 'planning', stage: 'industry_chain_planning', initial_weight: 1 }]
  const initial = new PopulationStore({ filePath, roles })
  const state = await initial.load()
  state.checkpoint = 17
  await initial.save(state)
  const newRoles = roles.map(r => ({ ...r, mission: 'new' }))
  const stores = [0, 1].map(() => new PopulationStore({ filePath, roles: newRoles }))
  let arrivals = 0, release
  const barrier = new Promise(resolve => { release = resolve })
  for (const store of stores) {
    const save = store.save.bind(store)
    store.save = async (...args) => {
      if (++arrivals === 2) release()
      await barrier
      return save(...args)
    }
  }
  const results = await Promise.all(stores.map(s => s.load()))
  for (const r of results) { assert.equal(r.checkpoint, 17); assert.equal(r.active[0].mission, 'new') }
  assert.equal(results[0]._version, results[1]._version)
})

test('population CAS retries are bounded and other errors are not swallowed', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'population-cas-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const store = new PopulationStore({ filePath: path.join(dir, 'p.json'), roles: [] })
  let attempts = 0
  store.save = async () => { attempts++; throw Object.assign(new Error('conflict'), { code: 'CAS_CONFLICT' }) }
  await assert.rejects(store.load(), { code: 'CAS_CONFLICT' }); assert.equal(attempts, 5)
  store.save = async () => { throw Object.assign(new Error('disk'), { code: 'EACCES' }) }
  await assert.rejects(store.load(), { code: 'EACCES' })
})
