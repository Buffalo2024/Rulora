# Case 01 · Guided Diagnosis Agent

[中文](README.md) · [Run](run.js) · [Scenario](scenario.js) · [Agent protocol](protocol/AGENT.md)

This case lets an LLM understand and ask naturally while a program controls
fields, branch loops, budget, evidence, handoff and the final freeze.

The model proposes fields and questions. The state machine alone validates
evidence, advances branches and freezes facts. Two consecutive no-progress
turns trigger correction; one more no-progress turn after correction triggers
human handoff. The counter resets when the branch advances.

```bash
npm run example:diagnosis
```

The sample uses fictional data and a mock flow. Access, payment and channel
policies belong to the host application and are intentionally absent.
