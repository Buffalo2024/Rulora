# Proposal: a governed collective-decision reference application for LangGraph

## Problem

LangGraph provides graph execution, state, routing, persistence, and human-in-the-loop primitives. A multi-agent
decision graph can still accept malformed carriers, merge incompatible candidates, allow a reviewer to create a
new answer, or disclose more state than a role needs.

## Proposed reference application

This repository demonstrates an additional application-level control chain:

```text
independent model outputs
  -> deterministic carrier Recovery
  -> semantics-preserving Adapter
  -> Program-frozen candidate IDs and hash
  -> Reviewer selects IDs only
  -> Program expands and validates
  -> auditable JSON delivery
```

LangGraph remains responsible for workflow execution. Rulora does not replace its checkpointer, routing, retry,
or interrupt model. The additional layer is limited to decision contracts and role permissions.

## Reproduction

```bash
git clone https://github.com/Buffalo2024/Rulora.git
cd Rulora/examples/collective-decision
npm install
npm run example:langgraph
npm run test:minimal
npm run eval:reliability
npx @langchain/langgraph-cli dev --no-browser
```

No model key is required. The example deliberately includes valid JSON, fenced JSON, a missing-comma carrier,
ambiguous business values, invalid values, and invented Reviewer IDs.

## Questions for the LangGraph community

1. Is this most useful as a reference application, template, guide, or community integration?
2. Should the reusable boundary expose graph nodes, node wrappers, or a graph factory?
3. Which LangGraph-native persistence and interrupt example would make the application most useful without
   duplicating framework responsibilities?

## Limits

The full application is a synthetic enterprise-operations collective-decision scenario. The checked-in evaluation corpus is a
small regression corpus, not a claim of model accuracy or universal reliability. Feedback supported by new failure
fixtures, measurements, or minimal reproductions is especially welcome.
