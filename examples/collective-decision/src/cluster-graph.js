const { Annotation, END, START, StateGraph } = require('@langchain/langgraph')

const STAGES = [
  'public_evidence_planning_and_intake',
  'information_collection_monitoring',
  'group_debate',
  'conclusion_output'
]

function buildClusterGraph(handlers, { checkpointer } = {}) {
  for (const stage of STAGES) if (typeof handlers[stage] !== 'function') throw new Error(`missing cluster stage handler: ${stage}`)
  const State = Annotation.Root({
    context: Annotation(),
    stage_events: Annotation({
      reducer: (current, update) => [...(current || []), ...(update || [])],
      default: () => []
    })
  })
  const graph = new StateGraph(State)
  for (const stage of STAGES) {
    graph.addNode(stage, async state => {
      const startedAt = new Date().toISOString()
      const context = await handlers[stage](state.context)
      return {
        context,
        stage_events: [{ stage, started_at: startedAt, completed_at: new Date().toISOString() }]
      }
    })
  }
  graph.addEdge(START, STAGES[0])
  for (let index = 0; index < STAGES.length - 1; index += 1) graph.addEdge(STAGES[index], STAGES[index + 1])
  graph.addEdge(STAGES.at(-1), END)
  return graph.compile(checkpointer ? { checkpointer } : undefined)
}

function buildBoundedDecisionStageGraph(handlers) {
  for (const name of ['evaluate_initial', 'freeze_initial', 'self_review', 'freeze_reviewed']) {
    if (typeof handlers[name] !== 'function') throw new Error(`missing decision stage handler: ${name}`)
  }
  const State = Annotation.Root({ context: Annotation() })
  const graph = new StateGraph(State)
  for (const name of ['evaluate_initial', 'freeze_initial', 'self_review', 'freeze_reviewed']) {
    graph.addNode(name, async state => ({ context: await handlers[name](state.context) }))
  }
  graph.addEdge(START, 'evaluate_initial')
  graph.addConditionalEdges('evaluate_initial', state => state.context.route, {
    freeze_initial: 'freeze_initial',
    self_review: 'self_review'
  })
  graph.addEdge('freeze_initial', END)
  graph.addEdge('self_review', 'freeze_reviewed')
  graph.addEdge('freeze_reviewed', END)
  return graph.compile()
}

function buildEnterpriseDecisionGraph(handlers) {
  const names = ['intake', 'direction', 'condition', 'supplemental_search', 'finalize']
  for (const name of names) if (typeof handlers[name] !== 'function') throw new Error(`missing enterprise graph handler: ${name}`)
  const State = Annotation.Root({ context: Annotation() })
  const graph = new StateGraph(State)
  for (const name of names) graph.addNode(name, async state => ({ context: await handlers[name](state.context) }))
  graph.addEdge(START, 'intake')
  graph.addConditionalEdges('intake', state => state.context.route, { direction: 'direction', supplemental_search: 'supplemental_search', finalize: 'finalize' })
  graph.addEdge('direction', 'condition')
  graph.addConditionalEdges('condition', state => state.context.route, { supplemental_search: 'supplemental_search', finalize: 'finalize' })
  graph.addConditionalEdges('supplemental_search', state => state.context.route, { intake: 'intake', finalize: 'finalize' })
  graph.addEdge('finalize', END)
  return graph.compile()
}

function buildEnterpriseSeatLoopGraph(handlers) {
  const names = ['initial', 'broadcast', 'self_review', 'freeze']
  for (const name of names) if (typeof handlers[name] !== 'function') throw new Error(`missing enterprise seat handler: ${name}`)
  const State = Annotation.Root({ context: Annotation() })
  const graph = new StateGraph(State)
  for (const name of names) graph.addNode(name, async state => ({ context: await handlers[name](state.context) }))
  graph.addEdge(START, 'initial')
  graph.addConditionalEdges('initial', state => state.context.route, { broadcast: 'broadcast', freeze: 'freeze' })
  graph.addEdge('broadcast', 'self_review')
  graph.addConditionalEdges('self_review', state => state.context.route, { broadcast: 'broadcast', freeze: 'freeze' })
  graph.addEdge('freeze', END)
  return graph.compile()
}

module.exports = { STAGES, buildBoundedDecisionStageGraph, buildClusterGraph, buildEnterpriseDecisionGraph, buildEnterpriseSeatLoopGraph }
