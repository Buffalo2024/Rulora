# Rulora contributor instructions

Rulora is a Hybrid orchestration framework: models understand and create;
programs control, validate and deliver.

## Non-negotiable rules

- The program-owned state machine is the only authority that may complete a
  field, advance a branch, freeze a diagnosis or approve a deliverable.
- Model output is always a candidate. Validate it before committing it.
- Every accepted diagnostic field must reference an existing source turn.
- No-progress counters belong to the current branch and reset after advancing.
- Access, subscription, payment and channel policies belong to the host app.
- Never commit API keys, real customer data, private host-application
  configuration, or assets that the contributor has no right to distribute.

## Before submitting a change

Run:

```bash
npm test
npm run example
npm run lab:native-image
npm run lab:stable-image
npm run release:check
```

New workflow behavior requires a test. New examples must state which work is
owned by the model and which work is owned by the program.
