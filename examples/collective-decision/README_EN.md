# Rulora Collective Decision

Independent model judgments with program-controlled exchanges, frozen candidates and validated delivery.
[中文](README.md) · [Rulora](../../README_EN.md) · [Contract](docs/COLLECTIVE-CONTRACT.md)

This is an advanced example. Start with [checked-in inputs, outputs and a checkpoint](examples/fixtures/static/README.md),
then follow the [code map](docs/CODE-MAP.md) and [running modes](docs/RUNNING-MODES.md).

A LangGraph.js + Rulora enterprise-operations scenario: contract, maintain or expand, then select a complete plan.
Two five-seat layers provide bounded exchanges, role disclosure, restricted review, checkpoints and a local console.

## Minimal collective

From the repository root:

```bash
node examples/collective-decision/examples/controlled-collective.js
```

Directly uses Core OutputBoundary, LoopControl and CollectiveControl.
Unknown evidence fails, revisions stop at budget, candidates freeze, invented reviewer IDs are rejected.

## Full system

```bash
cd examples/collective-decision
npm ci
npm install --no-save --package-lock=false ../..
npm run example
npm run example:static
npm test
npm run privacy:check
npm run web
```

Use Node.js 22/24. Synthetic inputs and scripted providers require no credentials.
The demo runs twice, asserting identical reports and no additional successful-node calls.
Output: examples/output/enterprise-collective/demo-summary.json.

Models understand and judge; programs own state, contracts, budgets, candidate pools and delivery.
Recovery repairs carriers; Adapter applies deterministic conversions; Reviewer selects an existing whole candidate.
Network, revision and business loops have separate limits. Direction exchange allows six rounds; action exchange ten.
Checkpoint reuse requires matching inputs and protocol. Improvements apply to subsequent versions.
Full-system persistence, checkpoints and scheduling remain scenario implementations. Control tests do not prove decision accuracy.
PostgreSQL is not required for default runs. pg-boss is an optional dependency used only by an explicitly configured host scheduler.

Protocol: 5.3.0-action-object-boundaries; action options: 3.0.0-object-boundaries.
Directions -1 / 0 / 1 mean contract / maintain / expand; null means unresolved.
Action numbers are categories, not scores.

## Live calls and checks

```bash
node src/cli.js run --input my-enterprise-case.json --out-dir examples/output/my-case --live
npm run example:controlled
npm run example:langgraph
npm run eval:reliability
npm run web:smoke
npm run pack:check
```

Live calls require configuration and may incur charges. The console is for local use.
private: true prevents accidental npm publication; source remains open.
[Apache-2.0](LICENSE) · [Third-party licenses](THIRD_PARTY.md).
Contact: zzjeff1993.agent@gmail.com.
