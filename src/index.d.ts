export type StepOwner = 'model' | 'program'
/** Only the primitive true accepts. Other supported values are rejection diagnostics. */
export type ValidationResult = boolean | string | readonly string[] | Record<string, unknown> | null
export type Validator<T, C = Record<string, unknown>> = (value: T, context: C) => ValidationResult | Promise<ValidationResult>

export interface PipelineStep<T = unknown, C = Record<string, unknown>> {
  id: string
  owner: StepOwner
  run(value: T, context: C): T | Promise<T>
  validate?: Validator<T, C>
}

export interface PipelineEvent {
  stepId: string
  owner: StepOwner
  startedAt: string
  completedAt: string
}

export class PipelineError extends Error {
  code: string
  details: unknown
  constructor(code: string, message: string, details?: unknown)
}

export class HybridPipeline<T = unknown, C = Record<string, unknown>> {
  id: string
  steps: Array<PipelineStep<T, C>>
  constructor(options: { id: string; steps?: Array<PipelineStep<T, C>> })
  run(input: T, context?: C): Promise<{ pipelineId: string; output: T; events: PipelineEvent[] }>
}

export type LoopKind = 'network_reconnect' | 'constraint_revision' | 'business_broadcast'
export type LoopStatus = 'active' | 'exhausted' | 'human_handoff'
export interface LoopSnapshot {
  kind: LoopKind
  attempts: number
  noProgress: number
  status: LoopStatus
  remainingAttempts: number
}
export class LoopControlError extends Error {
  code: string
  details: unknown
  constructor(code: string, message: string, details?: unknown)
}
export class LoopControl {
  kind: LoopKind
  maxAttempts: number
  maxNoProgress: number
  attempts: number
  noProgress: number
  status: LoopStatus
  constructor(options?: { kind?: LoopKind; maxAttempts?: number; maxNoProgress?: number })
  record(input: { progressed: boolean }): LoopSnapshot
  snapshot(): LoopSnapshot
}

export class OutputBoundaryError extends Error {
  code: 'OUTPUT_REJECTED'
  stage: 'core' | 'audit'
  details: unknown
  constructor(stage: 'core' | 'audit', message: string, details?: unknown)
}
export class OutputBoundary<T = unknown, C = Record<string, unknown>, Raw = unknown, Recovered = unknown> {
  constructor(options: {
    recover?: (raw: Raw, context: C) => Recovered | Promise<Recovered>
    adapt?: (value: Recovered, context: C) => T | Promise<T>
    validateCore: Validator<T, C>
    validateAudit?: Validator<T, C>
  })
  process(raw: Raw, context?: C): Promise<{ value: T; accepted: true }>
}

export class CollectiveControlError extends Error { code: string; constructor(code: string, message: string) }
export type DeepReadonly<T> = T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T
export class CollectiveControl<T extends { id?: string } = { id?: string; [key: string]: unknown }> {
  constructor(options?: { quorum?: number })
  /** Accepts plain, finite, acyclic JSON only. The pool belongs to this instance. */
  freezeCandidates(submissions: readonly T[]): ReadonlyArray<DeepReadonly<T & { id: string }>>
  select(candidates: ReadonlyArray<DeepReadonly<T & { id: string }>>, selectedId: string): DeepReadonly<T & { id: string }>
}

export interface Repository<T = Record<string, unknown>> {
  create(record: T): Promise<T>
  get(id: string): Promise<T | null>
  save(record: T): Promise<T>
}

export class MemoryRepository<T extends { id: string } = { id: string; [key: string]: unknown }>
implements Repository<T> {
  records: Map<string, T>
  create(record: T): Promise<T>
  get(id: string): Promise<T | null>
  save(record: T): Promise<T>
}

export interface FieldSchema {
  type?: 'string' | 'boolean' | 'array' | 'object'
  minLength?: number
  maxLength?: number
  enum?: string[]
  minItems?: number
  maxItems?: number
  required?: string[]
}

export interface ScenarioBranch {
  id: string
  label?: string
  openingQuestion: string
  requiredFields: string[]
  fields: Record<string, FieldSchema | { schema: FieldSchema }>
}

export interface ScenarioDefinition {
  id: string
  opening?: string | ((input: { subject: Record<string, unknown> }) => string)
  branches: ScenarioBranch[]
  output?: Record<string, unknown>
}

export interface WorkflowState {
  id: string
  status: 'active' | 'human_handoff' | 'ready_for_output' | 'frozen'
  currentBranch: null | {
    id: string
    label?: string
    requiredFields: string[]
    openingQuestion: string
  }
  usage: { tokenLimit: number | null; tokensUsed: number; blocked: boolean }
  progress: { correctionRequired: boolean; humanHandoff: boolean }
  completedFields: string[]
  readyForOutput: boolean
}

export class WorkflowError extends Error {
  code: string
  statusCode: number
  details: unknown
  constructor(code: string, message: string, statusCode?: number, details?: unknown)
}

export class OrchestrationMachine {
  constructor(options: {
    repository: Repository
    scenario: ScenarioDefinition
    defaults?: { tokenLimit?: number }
  })
  createSession(options?: {
    id?: string
    subject?: Record<string, unknown>
    sessionKey?: string
    tokenLimit?: number
  }): Promise<WorkflowState>
  openingMessage(subject?: Record<string, unknown>): {
    message: string
    branchId: string
    isUserTurn: false
  }
  getState(id: string, options?: { sessionKey?: string }): Promise<WorkflowState>
  recoverSession(id: string, options?: { sessionKey?: string }): Promise<WorkflowState>
  recordUserTurn(id: string, input: {
    turnId: string
    text: string
    sessionKey?: string
  }): Promise<{ duplicate: boolean }>
  recordUsage(id: string, input: {
    tokens?: number
    operationId: string
    sessionKey?: string
  }): Promise<WorkflowState['usage']>
  submitFields(id: string, input: {
    fields: Record<string, unknown>
    sourceTurnId: string
    sessionKey?: string
  }): Promise<Record<string, unknown> & { state: WorkflowState }>
  recordNoProgress(id: string, input: {
    sourceTurnId: string
    sessionKey?: string
  }): Promise<Record<string, unknown> & { state: WorkflowState }>
  freeze(id: string, options?: { sessionKey?: string }): Promise<{
    scenarioId: string
    subject: Record<string, unknown>
    fields: Record<string, unknown>
    evidence: Record<string, string>
    frozenAt: string
  }>
  reportContract(): Record<string, unknown>
}
