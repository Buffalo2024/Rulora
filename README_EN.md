<div align="center">
  <img src="assets/brand/rulora-logo-256.png" width="148" alt="Rulora logo">
  <h1>Rulora</h1>
  <p><strong>Models understand and create. Programs control, validate, and deliver.</strong></p>
  <p>Rulora is an open-source execution-contract framework for reliable AI agents. Through Hybrid cooperation between probabilistic models and deterministic programs, it makes complex agent tasks verifiable, recoverable, and reproducible.</p>
  <p>
    <a href="https://www.npmjs.com/package/@rulora/core"><img src="https://img.shields.io/npm/v/%40rulora%2Fcore?tag=alpha&label=npm%20alpha" alt="npm alpha version"></a>
    <a href="https://github.com/Buffalo2024/Rulora/actions/workflows/ci.yml"><img src="https://github.com/Buffalo2024/Rulora/actions/workflows/ci.yml/badge.svg" alt="CI status"></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue" alt="Apache-2.0 license"></a>
  </p>
  <p><a href="README.md">中文说明</a> · <a href="#quick-start">Quick Start</a> · <a href="#official-agent-ecosystem">Agent Ecosystem</a></p>
</div>

---

## What Rulora Is

Rulora is an open-source execution-contract framework for reliable AI agents. Through Hybrid
cooperation between probabilistic models and deterministic programs, it makes complex agent tasks
verifiable, recoverable, and reproducible.

Rulora calls this collaboration the **Hybrid mechanism**:

- models interpret language, ask questions, propose structured content, and create visuals;
- programs own fields, state, branches, budgets, evidence, schemas, quality gates, and persistence;
- explicit data contracts connect both sides, and model output never changes business state directly.

Hybrid is Rulora's project term for model-and-program collaboration. It is not a model provider,
agent platform, or image service.

The Rulora repository contains Core, shared conventions, minimal learning examples, and an index of
official Agents. Agents that solve end-user tasks are released as independent open-source projects.
Daily/weekly cadence, industries, and output formats are routed scenario packs inside an Agent rather
than separate Agents.

## Core Rules

1. Programs own state transitions.
2. Models submit candidates rather than final authority.
3. Important conclusions remain traceable to evidence.
4. Retries, stalled progress, token budgets, and human handoff are explicit states.
5. Recovery validates a repository checkpoint before continuing and never silently repairs or advances it.
6. Model, image, channel, and persistence integrations stay behind explicit host-owned boundaries.
7. Pricing, subscriptions, and access-count policies belong to the host application, not Rulora Core.

## Quick Start

Node.js 20 or newer is required. Install the public alpha:

```bash
npm install @rulora/core@alpha
```

You can also run Core from source:

```bash
git clone https://github.com/Buffalo2024/Rulora.git
cd Rulora
npm test
npm run example
```

The minimal example uses fictional input to show how a program validates model-proposed fields,
advances branches, and freezes an evidence-linked result. It needs no API key.

## Official Agent Ecosystem

| Agent | Status | Task | Scenario packs |
|---|---|---|---|
| **[Rulora Report Agent](https://github.com/Buffalo2024/Rulora-Report-Agent)** | Open-source alpha | Turn public sources or business data into validated long-form PNG and one-page PPTX deliverables | Cross-border policy daily, customer-service operations daily, EV export weekly |

Report Agent is released as one independent open-source project. Its scenario packs share the
same evidence-ingestion, normalization, analysis, validation, rendering, and QA foundation. A task router
selects cadence, source profile, template, and output format.

See [Agent ecosystem and project boundaries](docs/AGENT-ECOSYSTEM.md).

## Current Implementation Status

The current alpha implements the program-owned conversation state machine, an in-memory repository,
a minimal sequential `HybridPipeline`, validated recovery from a host repository checkpoint, and one
Core learning example. It does not bundle a real model/image provider, persistent database adapter,
automatic retry scheduler, concurrency control, or production observability. Architecture terms
describe extension boundaries, not bundled features.

Install the preview with the explicit `alpha` dist-tag; no stable release has been declared.

## Core Learning Example and Labs

The [state and ownership example](examples/state-and-ownership/README_EN.md) teaches fields, branches,
evidence, budgets, correction, handoff, and freezing. Exploratory code without a real delivery path lives
under [`labs/`](labs/README.md) and is not presented as an official Agent or shipped Core capability.

## OpenClaw Integration

Rulora does not replace OpenClaw. OpenClaw may provide sessions, tools, channels, and model access;
Rulora acts as the deterministic business-control layer for fields, transitions, validation, and delivery.

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Agent ecosystem and project boundaries](docs/AGENT-ECOSYSTEM.md)
- [OpenClaw integration](docs/OPENCLAW-INTEGRATION.md)
- [Release checklist](docs/RELEASE-CHECKLIST.md)
- [Contributing](CONTRIBUTING.md)
- [Security](SECURITY.md)

## Technical and Business Collaboration

For collaboration around these three cases or other Hybrid scenarios:

- Email: `zzjeff1993.agent@gmail.com`
- WeChat: scan the QR code and mention Rulora or your collaboration topic.

<p align="center">
  <img src="assets/contact/wechat-qr.jpg" width="220" alt="Rulora WeChat contact">
</p>

## License

The code is licensed under [Apache-2.0](LICENSE). The Rulora name and logo identify this open-source
project and follow separate brand-use terms in [TRADEMARKS.md](TRADEMARKS.md).
