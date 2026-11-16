# Installation and requests

Install the complete `remote-codex` package with Skills CLI 1.8.1, selecting an exact release or commit from `markhuangai/agent-remote-dev-codex`. Node 24, authenticated `gh`, Git and Python 3.12+ are required. The installed helper has no npm runtime dependencies and never uses local Codex history.

For a new consumer, explicitly authorize bootstrap files in a clean target checkout:

```bash
node <skill-directory>/scripts/install-workflows.mjs --directory . --actors LOGIN
```

The installer refuses existing resources and linked destinations. Review its complete `.github/remote-codex/` support directory and `runner-task.yml` / `runner-continuation.yml`, then deliver them through the repository's normal PR and human merge process. This command does not commit, push, configure secrets, or register runners. Subsequent customization of protocol-owned files requires regenerating their SHA-256 inventory in `protocol.json`.

Provision runtime secrets `CODEX_CONFIG_TOML`, `CODEX_API_KEY`, and `REMOTE_DEV_PAT`. The task credential needs Contents/Pull requests/Actions read-write, Checks/Commit statuses read, Issues read for issue plans, and Workflows write only when the selected task edits workflows. Give it read access to any selected private skill repositories. The allowlist is a separate gate: dispatching users need write/maintain/admin permission, and both original and triggering actors must be allowed. Self-hosted Linux requires Git, npm, `gh`, Python 3.12+ and a working Node 24 toolchain; default labels are `["self-hosted","Linux"]`, with optional architecture/custom labels.

Review automation is a consuming repository's policy. This runner does not install a reviewer. This project's own review workflow separately uses `AI_ENDPOINT`, `LOCAL_AI_SECRET`, and `PR_REVIEW_PAT`; the PAT requires Contents/Pull requests read-write and Commit statuses write, plus Issues read when needed.

The Skills JSON file contains a list of repository URLs or objects:

```json
[{"repository":"https://github.com/markhuangai/agent-remote-dev-skills","ref":"224a5be4ddf40c6cf0a50b97885cb353e8522e2e","names":["sdlc-plan-implementation","plan-audit","pr-review-loop"]}]
```

Omit `names` to select every discovered skill from that source. Omit `ref` to resolve its default branch once. The prepared request records only exact revisions and expanded names. No source is installed automatically. Repository `.agents/skills` and AGENTS files remain native checkout content.

Queue preparation accepts `--plan-file` or `--issue-url`, `--request-text`, explicit `--git-author-name` / `--git-author-email`, optional `--skills-file`, `--user-agents-url`, `--runner` (JSON array), `--budget-minutes` (3–300), `--max-continuations` (0–100), and `--auto-continue true|false`. `--task-id` can provide a previously generated unique identity. The default action ref is published `v1`; before releases exist, use an explicitly authorized immutable `--source-ref SHA`. `--source-repository` defaults to `markhuangai/agent-remote-dev-codex`.

Registration binds the exact frozen request hash into the native run title. Reusing a task ID with different inputs fails. Each explicit `resume` generates an activation key, printed before dispatch and included in its receipt. To reconcile an uncertain resume, reuse that key with `--activation-key KEY`; do not generate another activation until status has established the prior result. A new explicit resume after a stopped or cancelled activation uses a new key and the retained checkpoint, within the frozen continuation allowance.

For optional global instructions, an example URL is `https://raw.githubusercontent.com/Z-M-Huang/golden-CLAUDE.md/refs/heads/main/CLAUDE.md`. The helper freezes the body hash; the runner fetches that exact content once and saves it for resume. URLs must be public HTTPS without embedded credentials. Downloads are limited to 20 seconds and 64 KiB. Do not include secrets in prompts, skill sources or user instructions.

`queue --dry-run` prints prepared request data for review/save. `queue --prepared FILE` rechecks the hashes before one authenticated dispatch. The workflow input limit is 65,535 bytes; use an existing issue for larger prompts. Source issues and native blockers must be valid; closing implementation commits must be merged into `main`.

`status` reports native runs, parent/child/controller URLs, artifacts, frozen identities and infrastructure outcomes. `--show-result` retrieves the opaque native response, which may describe completion, a blocker or anything else the selected skill decided. It never becomes authority for additional work. `resume --artifact-id ID` uses a specific unexpired schema-3 checkpoint; settings cannot change. `stop` requests cancellation of active/queued runs and fences automatic continuation. Inspect status after any uncertain operation rather than repeating dispatch.

The task budget defaults to 300 minutes with a 120-second shutdown/export reserve inside a 360-minute job. Three additional runs are allowed by default. Native nonzero exits and cancellation do not automatically restart. A normal return is invocation completion, not a verified PR or task-success claim. Sessions are exported only after managed processes are quiescent and source is clean at an exact remote revision. Skills must publish anything needed on another runner; dirty files, ignored temporary state and source archives are not saved. Earlier artifacts remain authoritative when a new checkpoint is unavailable. Protocol/checkpoint versions 1 and 2 are explicitly unsupported.

Diagnostics use normal INFO/WARN/ERROR records on stderr; stdout contains request data or receipts. Workflow logs use the same event families. Follow task/run IDs, source and instruction hashes, version, branch/SHA, artifact and claim identities, safe API causes and deadlines. Credentials, raw prompts, instructions and provider bodies are excluded from logs. Preserve logs/artifacts under repository retention; remove only verified helper-owned temporary paths.
