import { OutputBoundary, LoopControl, LoopStatus, CollectiveControl, HybridPipeline, MemoryRepository } from '@rulora/core'

type Proposal = { id: string; direction: 'expand' | 'maintain'; evidence: string[] }
type Context = { allowed: Set<string> }
const boundary = new OutputBoundary<Proposal, Context, string, unknown>({
  recover: raw => JSON.parse(raw) as unknown,
  adapt: value => value as Proposal,
  validateCore: value => value.id.length > 0,
  validateAudit: (value, context) => value.evidence.every(id => context.allowed.has(id)) || { reason: 'unknown evidence' }
})
async function typedOutput() {
  const result = await boundary.process('{}', { allowed: new Set(['E1']) })
  const accepted: true = result.accepted
  const direction: 'expand' | 'maintain' = result.value.direction
  void accepted; void direction
  // @ts-expect-error raw carrier is explicitly string
  await boundary.process(123)
}
void typedOutput

new OutputBoundary({
  // @ts-expect-error a forgotten return must not type-check as a validator
  validateCore: () => {}
})
new OutputBoundary({
  // @ts-expect-error truthy numbers do not indicate acceptance
  validateCore: () => 1
})
const loop = new LoopControl({ kind: 'business_broadcast' })
const status: LoopStatus = loop.record({ progressed: false }).status
void status
// @ts-expect-error unsupported loop kind
new LoopControl({ kind: 'infinite' })

const collective = new CollectiveControl<Proposal>()
const source: readonly Proposal[] = [{ id: 'a', direction: 'expand', evidence: ['E1'] }, { id: 'b', direction: 'maintain', evidence: ['E1'] }]
const pool = collective.freezeCandidates(source)
const chosen = collective.select(pool, 'a')
// @ts-expect-error nested arrays are recursively readonly
chosen.evidence.push('E2')
// @ts-expect-error frozen properties cannot be assigned
chosen.direction = 'maintain'
// @ts-expect-error candidate IDs are strings
collective.select(pool, 1)

const repository = new MemoryRepository<{ id: string; counter: number }>()
repository.create({ id: 'a', counter: 1 })
// @ts-expect-error required fields remain required
repository.create({ id: 'a' })
new HybridPipeline<number>({ id: 'typed', steps: [{ id: 'inc', owner: 'program', run: value => value + 1, validate: value => value > 0 }] })
