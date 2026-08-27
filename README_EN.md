<div align="center">
  <img src="assets/brand/rulora-logo-256.png" width="148" alt="Rulora logo">
  <h1>Rulora</h1>
  <p><strong>Models understand and create. Programs control, validate, and deliver.</strong></p>
  <p>Open-source, pluggable control components for adding flow, loop, output-boundary, and collective-decision controls to existing agents.</p>
  <p>
    <a href="https://www.npmjs.com/package/@rulora/core"><img src="https://img.shields.io/npm/v/%40rulora%2Fcore?tag=alpha&label=npm%20alpha" alt="npm alpha version"></a>
    <a href="https://github.com/Buffalo2024/Rulora/actions/workflows/ci.yml"><img src="https://github.com/Buffalo2024/Rulora/actions/workflows/ci.yml/badge.svg" alt="CI status"></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue" alt="Apache-2.0 license"></a>
  </p>
  <p><a href="README.md">中文说明</a> · <a href="#quick-start">Quick Start</a> · <a href="#scenario-examples">Scenario Examples</a></p>
</div>

---

## Creator and Project Note

Rulora was created through vibe coding by an author without a professional programming background.
The implementation has automated tests and scenario validation, but architecture, performance, security,
or compatibility issues may remain. Concrete bug reports, reproduction steps, evaluation data, technical
review, and improvements are welcome.

## What Rulora Is

Rulora is a small set of control components that can be embedded in an existing single agent or agent
collective. Through Hybrid cooperation between probabilistic models
and deterministic programs, it controls flows, loops, structured-output boundaries, and candidate selection.

Rulora calls this collaboration the **Hybrid mechanism**:

- the LLM interprets evidence, performs open-ended semantic reasoning, makes independent judgments, and selects candidates;
- the Program owns flow state, field contracts, validation, statistics, candidate pools, gates, and final results;
- Recovery repairs only JSON or Markdown carriers and never infers business answers;
- Adapter performs only field-alias and deterministic type conversion, without changing conclusions;
- Reviewer selects only candidate IDs frozen by the Program and cannot create a new answer;
- Loop separates network reconnects, constraint revisions, and business broadcasts, each with a hard limit;
- Checkpoint resumes only failed nodes and does not call successful nodes again;
- the Improvement seat uses objective feedback only for the next version and never self-modifies during a run.

Hybrid is Rulora's project term for model-and-program collaboration. It is not a model provider,
agent platform, or image service.

Use one component or compose several. Models, tools, sessions, databases, and user interfaces remain
owned by the host agent.

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

## Scenario Examples

| Agent | Status | Task | Scenario packs |
|---|---|---|---|
| **[Rulora Report Agent](https://github.com/Buffalo2024/Rulora-Report-Agent)** | Open-source alpha | Turn public sources into validated long-form PNG deliverables | Cross-border policy daily, EV export weekly |
| **[Rulora AGTI](https://github.com/Buffalo2024/Rulora-AGTI)** | Open-source alpha | Deterministic identity assessment, controlled diagnosis, and stable visual delivery | 20 questions, 24 identities, A/B report protocols |
| **[Rulora Collective Decision](https://github.com/Buffalo2024/Rulora-Collective-Decision)** | Open-source alpha | Independent seats, candidate pools, quorum, constrained review, and failed-node recovery | Fictional credit-risk research case |
| **Rulora DeepSeek Harness Adapter** | Under development | Embed Rulora controls in Harness lifecycles | Real SDK integration still needs debugging |

Report Agent, AGTI, and Collective Decision are released as independent open-source projects. Report Agent's
scenario packs share one ingestion, normalization, analysis, validation, rendering, and QA foundation. AGTI
demonstrates deterministic scoring and controlled diagnosis. Collective Decision demonstrates frozen candidate
pools, quorum, constrained review, and failed-node recovery.

These independent repositories demonstrate the controls in real tasks; they are not a required ecosystem.

## Current Implementation Status

The current alpha implements the program-owned conversation state machine, an in-memory repository,
`HybridPipeline`, `LoopControl`, `OutputBoundary`, `CollectiveControl`, validated checkpoint recovery,
and one learning example. It does not bundle providers, databases, schedulers, UI, or production observability.

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
