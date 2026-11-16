# Installation and requests

Install the complete `remote-codex` package with Skills CLI 1.8.1, selecting an exact release or commit from `markhuangai/agent-remote-dev-codex`. Node 24, authenticated `gh`, Git and Python 3.12+ are required. The installed helper has no npm runtime dependencies and never uses local Codex history.

For a new consumer, explicitly authorize bootstrap files in a clean target checkout:

```bash
node <skill-directory>/scripts/install-workflows.mjs --directory . --actors LOGIN
```

The installer refuses existing resources and linked destinations. Review its complete `.github/remote-codex/` support directory and `runner-task.yml`, `runner-continuation.yml`, and maintainer-only `runner-published.yml` qualification workflow, then deliver them through the repository's normal PR and human merge process. This command does not commit, push, configure secrets, or register runners. Subsequent customization of protocol-owned files requires regenerating their SHA-256 inventory in `protocol.json`.

Provision runtime secrets `CODEX_CONFIG_TOML`, `CODEX_API_KEY`, and `REMOTE_DEV_PAT`. The task credential needs Contents/Pull requests/Actions read-write, Checks/Commit statuses read, Issues read for issue plans, and Workflows write only when the selected task edits workflows. Give it read access to any selected private skill repositories. The allowlist is a separate gate: dispatching users need write/maintain/admin permission, and both original and triggering actors must be allowed. Self-hosted Linux requires Git, npm, `gh`, Python 3.12+ and a working Node 24 toolchain; default labels are `["self-hosted","Linux"]`, with optional architecture/custom labels.

Review automation is a consuming repository's policy. This runner does not install a reviewer. This project's own review workflow separately uses `AI_ENDPOINT`, `LOCAL_AI_SECRET`, and `PR_REVIEW_PAT`; the PAT requires Contents/Pull requests read-write and Commit statuses write, plus Issues read when needed.

Project settings live in committed repository-root `remote-codex.yml`. Supported keys
are `allowed-actors` (required nonempty login list), `skills` (default `[]`),
`user-level-agents.md-url` (optional HTTPS URL), `git-author` (`name`/`email`,
default GitHub Actions bot), `budget-minutes` (3–300, default 300), `runner`
(default `[ubuntu-latest]`), `auto-continue` (default false), and
`max-continuations` (0–100, default 3). Configuration is data; it grants no local
agent authority. A standalone workflow can call the published action directly
with `plan`, the three secret inputs and an optional `working-directory`.

`skills` accepts repository URLs or objects with `repository`, optional `ref`,
and optional `names`. Omitted names select all discovered packages; omitted refs
resolve the default branch once. No package or instructions URL is automatic.
Repository `.agents/skills` and AGENTS files remain native checkout content.

Queue accepts `--plan TEXT` or `--plan-file PATH`, `--repo OWNER/REPO`, optional
`--source-ref REF` and `--source-repository OWNER/REPO`, `--dry-run`, or
`--prepared FILE`. The source defaults to `markhuangai/agent-remote-dev-codex@v1`;
before releases exist, use an explicitly authorized immutable source SHA.
The helper freezes skills and instructions from repository configuration.
`user-level-agents.md-url` can point to the supplied Golden Rules file, but has
no default. Downloads allow public HTTPS, 20 seconds and 64 KiB. Keep secrets
out of prompts, configuration and downloaded instructions.

Save `queue --dry-run` output in a task-owned file and submit it with
`queue --prepared FILE`. Its immutable settings and hashes are rechecked before
one dispatch. Serialized requests are limited to 65,535 bytes; submit a short
prompt containing an issue URL for larger descriptions. Codex and its skills
interpret the prompt verbatim, including issue and dependency decisions.

The first GitHub run ID identifies the task. The pre-dispatch request nonce/hash
exists to reconcile uncertain registration; reuse the prepared request rather
than creating another task. Status/resume/stop use `--run-id ROOT_RUN_ID`.
Each explicit resume prints a new activation key before dispatch. Reuse it with
`--activation-key KEY` when reconciling uncertainty. A later explicitly authorized
resume after stopping uses a new key and the frozen continuation allowance.
Automatic children recheck both humans behind that explicit activation against
current trusted configuration and repository write permission. Changing its run
attempt invalidates those children; an authorized manual resume establishes new
authority without relying on a revoked original submitter.
The optional workflow kit is required for these dispatch/control commands and
for `auto-continue: true`; it is not required for standalone action execution.
Runner labels in configuration are read in kit preflight. An action's already
allocated runner is selected by the caller's workflow `runs-on`.

`status` reports native runs, parent/child/controller URLs, artifacts, frozen identities and infrastructure outcomes. `--show-result` retrieves the opaque native response, which may describe completion, a blocker or anything else the selected skill decided. It never becomes authority for additional work. `resume --artifact-id ID` uses a specific unexpired schema-3 checkpoint; settings cannot change. `stop` requests cancellation of active/queued runs and fences automatic continuation. Inspect status after any uncertain operation rather than repeating dispatch.

The task budget defaults to 300 minutes with a 120-second shutdown/export reserve inside a 360-minute job. Automatic continuation defaults off, with a frozen allowance of three additional runs when enabled. Native nonzero exits and cancellation do not automatically restart. A normal return is invocation completion, not a verified PR or task-success claim. Sessions are exported only after managed processes are quiescent and source is clean at an exact remote revision. Skills must publish anything needed on another runner; dirty files, ignored temporary state and source archives are not saved. Earlier artifacts remain authoritative when a new checkpoint is unavailable. Protocol/checkpoint versions 1 and 2 are explicitly unsupported.

Diagnostics use normal INFO/WARN/ERROR records on stderr; stdout contains request data or receipts. Workflow logs use the same event families. Follow task/run IDs, source and instruction hashes, version, branch/SHA, artifact and claim identities, safe API causes and deadlines. Credentials, raw prompts, instructions and provider bodies are excluded from logs. Preserve logs/artifacts under repository retention; remove only verified helper-owned temporary paths.
