export type StepOwner = 'model' | 'program'

export interface PipelineStep<T = unknown, C = Record<string, unknown>> {
  id: string
  owner: StepOwner
  run(value: T, context: C): T | Promise<T>
  validate?(value: T, context: C): true | unknown | Promise<true | unknown>
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
