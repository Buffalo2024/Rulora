<div align="center">
  <img src="assets/brand/rulora-logo-256.png" width="136" alt="Rulora logo">
  <h1>Rulora</h1>
  <p><strong>Models understand and create. Programs control, validate and deliver.</strong></p>
  <p>Open-source control components you can embed in existing AI agents.</p>
  <p><a href="README.md">中文</a> · <a href="docs/getting-started.md">Getting started</a> · <a href="docs/api.md">API</a></p>
</div>

Use one component or combine several in an agent or a collective. Hybrid model–program cooperation
keeps execution bounded, validates candidates before delivery and makes failures explicit.
It does not guarantee correct model judgments or replace your existing agent framework.

> Current version: `@rulora/core@0.1.0-alpha.4` (Alpha).
> Install with the alpha tag; the public npm registry is authoritative for the published version.

## A small example

Core requires Node.js 20+. Install the published package with `npm install @rulora/core@alpha`.

```js
const { OutputBoundary } = require('@rulora/core')
const boundary = new OutputBoundary({
  recover: raw => JSON.parse(raw),
  adapt: value => value,
  validateCore: value => value !== null &&
    typeof value.summary === 'string' && value.summary.trim().length > 0
})
async function main() {
  console.log((await boundary.process('{"summary":"Synthetic summary"}')).value)
}
main().catch(console.error)
```

This validates structure, not factual truth. You supply evidence and business checks.
Core cannot automatically prove that a custom adapter preserved the original conclusion.

## Three controls to try

From the repository root:

```bash
npm ci --ignore-scripts
npm test
npm run examples:quickstart
```

| Command | Demonstrates |
| --- | --- |
| npm run example:output | Reject missing fields and unknown references |
| npm run example:loop | Stop after repeated no-progress attempts |
| npm run example:candidates | Isolated immutable snapshots; select existing IDs only |

No API keys or live model calls. [Source](examples/quickstart/README.md).
For JSON Schema integration, run `npm run example:schema` or read the [Ajv example](examples/integrations/README.md).
Ajv is a development dependency; Core remains free of runtime dependencies.
For workflow state and evidence, see the [state-and-ownership example](examples/state-and-ownership/README.md).

## One collective-decision case, three levels

From the repository root, without model credentials or scenario dependencies:

```bash
node examples/collective-decision/examples/controlled-collective.js
```

seat-a initially references unknown evidence and succeeds after revision; seat-b succeeds immediately;
seat-c stops after two failures and requests human attention. Programs freeze the two accepted proposals,
and the reviewer can only select an existing ID. The example directly combines the three Core controls.

| Level | Task | Links |
| --- | --- | --- |
| Minimal controls | Reject outputs, bound loops, freeze candidates | [Quickstart](examples/quickstart/README.md) |
| Minimal collective | Validate proposals, bound revisions, freeze and select | [Core integration](examples/collective-decision/examples/controlled-collective.js) |
| Complete system (advanced) | Two five-seat layers, enterprise decisions and checkpoint replay | [Inputs and outputs](examples/collective-decision/examples/fixtures/static/README.md) · [Run](examples/collective-decision/README_EN.md) · [Code map](examples/collective-decision/docs/CODE-MAP.md) |

The enterprise case evaluates whether to contract, maintain or expand operations and selects a complete action plan.
Models judge independently; programs control disclosure, exchange budgets, frozen candidates and delivery.
The two layers judge direction and action plans. Five seats means five independent judgment roles per layer,
not necessarily five different model products; separate calls to the same model are supported.
Offline demos require no API keys. Control tests do not establish business-decision accuracy.
Network reconnects, constraint revisions and business exchanges use separate counters.
Core owns counters and stop states; the host schedules calls and implements persistent checkpoints.

## What ships where

Core exports OutputBoundary, LoopControl, CollectiveControl, OrchestrationMachine,
MemoryRepository and HybridPipeline. It includes only in-memory storage and workflow-state recovery.

The collective case implements model-call checkpoints, evidence aliases, role disclosure and a local console.
These are not automatically included in Core.
Your host owns models, authorized data, persistence, authentication, tenant isolation and operations.

[API](docs/api.md) · [Guarantees and limits](docs/guarantees.md) · [Integration](docs/integration.md).

## Repository

```text
src/                    Small control components and types
tests/                  Core contract tests
examples/quickstart/    Minimal calls
examples/collective-decision/
docs/                   Usage, boundaries and release notes
labs/                   Experimental code, not advertised capabilities
.github/workflows/      Separate Core and scenario checks
```

One repository, one detailed case. Extract reusable controls incrementally with regression evidence.
[Contribution guide](CONTRIBUTING.md) · [Security](SECURITY.md) · [Migration](docs/MONOREPO.md).

## Contact and license

Technical and commercial collaboration: `zzjeff1993.agent@gmail.com`.
Rulora has automated tests and scenario validation and remains under active development. Reproduction steps, evaluation data and technical review help identify architecture, performance, security and compatibility issues.

Core and Collective Decision: [Apache-2.0](LICENSE).
Check each case's LICENSE/NOTICE for assets and [TRADEMARKS.md](TRADEMARKS.md) for branding.
