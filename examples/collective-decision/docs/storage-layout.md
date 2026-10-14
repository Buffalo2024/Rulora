# Runtime data and portable tasks

Application configuration, code and schemas are read from the example directory.
Set `RULORA_DATA_ROOT` to put writable data on a separate persistent volume:

```sh
export RULORA_DATA_ROOT=/var/lib/rulora
npm run web
```

The compatible default is `<example-directory>/.runtime`. Relative values are
resolved against the example directory, never against the shell working directory.
The configured root contains `web-ui/{jobs,logs,outputs,intake}`, source settings,
model output traces, provider health, manual assistance and default evidence/checkpoint
stores. The active enterprise workflow can run with read-only application files
when configuration is prepared and this data directory is writable. Explicit
caller output paths and dedicated storage overrides still take precedence.
`LLM_OUTPUT_TRACE_ROOT`, if relative, is resolved against the data root.

## Moving history

Stop the old process; copy the **whole data root**, including outputs, evidence
snapshots, checkpoints, source settings and logs, to the new machine. Configure
`RULORA_DATA_ROOT` and start the application. Do not merely copy `jobs/*.json`.
New job operation paths are stored as `@rulora/data/...` or `@rulora/code/...`.
`storage_origins` records previous roots only as migration metadata; no old root
needs to exist or remain mounted. Known old absolute paths are rebased in memory
using this metadata, including paths in case and saved evidence packet documents.
Legacy job records infer their source data root only from the exact established
`web-ui/outputs/<job-id>` layout. External file paths outside those roots are not
guessed: explicitly mount or import those files.

Existing evidence, planning files and validated checkpoint files are not rewritten.
Evidence hashes and checkpoint input/output bindings remain authoritative. Reuse
requires matching inputs and successful current validation; migration does not
promise that every historical model call can be reused. Missing evidence requires
recollection or assistance, not automatic approval. The persisted migration
metadata may retain original directory names; it is not an active read/write path.
No production deployment or production history migration is performed by this change.
