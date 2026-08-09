<div align="center">
  <img src="assets/brand/rulora-logo-256.png" width="148" alt="Rulora logo">
  <h1>Rulora</h1>
  <p><strong>Models are responsible for understanding and creation. Programs are responsible for control, validation, and delivery.</strong></p>
  <p>An open-source LLM + Program orchestration framework built around the Hybrid mechanism.</p>
  <p><a href="README.md">中文说明</a> · <a href="#quick-start">Quick Start</a> · <a href="#official-agent-ecosystem">Agent Ecosystem</a></p>
</div>

---

## What Rulora Is

Rulora helps build constrained AI workflows for real business processes. Models handle open-ended
understanding and creation, while deterministic programs own state, rules, validation, and delivery.

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
5. Model, image, channel, and persistence integrations stay behind explicit host-owned boundaries.
6. Pricing, subscriptions, and access-count policies belong to the host application, not Rulora Core.

## Official Agent Ecosystem

| Agent | Status | Task | Scenario packs |
|---|---|---|---|
| **Rulora Report Agent** | In design · repository not published | Turn public sources or business data into validated long-form PNG and one-page PPTX deliverables | Cross-border policy daily, customer-service operations daily, EV export weekly |

Report Agent will be released as one independent open-source project. Its scenario packs share the
same collection, normalization, analysis, validation, rendering, and QA foundation. A task router
selects cadence, source profile, template, and output format. This page will link to the repository
after a runnable release exists; Rulora does not publish empty placeholder repositories.

See [Agent ecosystem and project boundaries](docs/AGENT-ECOSYSTEM.md).

## Core Learning Examples

| Case | Status | Model responsibility | Program responsibility |
|---|---|---|---|
| [01 · Guided Diagnosis](examples/01-guided-diagnosis/README.md) | Alpha | Interpret replies and propose fields | Branch loops, validation, progress correction, evidence, freeze |
| [02 · Native Image Report](examples/02-native-image-report/README.md) | Lab · Mock | Propose report content and an image task | Basic field checks, story selection, and a simulated QA gate |
| [03 · Stable Image Reproduction](examples/03-stable-image-reproduction/README.md) | Lab · Mock | Propose copy within slot capacity | Character limits, simulated fusion, and a simulated pixel gate |

These examples explain the Hybrid mechanism; they are not released business Agents. Report-related
labs will move into Report Agent's shared foundation after real rendering, evidence, and QA paths work.

## Quick Start

Node.js 20 or newer is required.

```bash
git clone https://github.com/Buffalo2024/rulora.git
cd rulora
npm test
npm run example:diagnosis
npm run example:native-image
npm run example:stable-image
```

Examples use local mock providers and require no API key.

## Current Implementation Status

Version `0.1.0-alpha.1` implements the program-owned conversation state machine, an in-memory
repository, and a minimal sequential `HybridPipeline`. The image examples use mock URIs and mock OCR
text: this repository does not yet include a real model/image provider, OCR engine, deterministic image
fusion, pixel-difference implementation, persistent database adapter, concurrency control, recovery,
or production observability. Architecture terms describe extension boundaries, not bundled features.

The npm package has not been published yet. Use the source checkout for the current preview.

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
