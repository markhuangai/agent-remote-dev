# agent-remote-dev-codex

A Linux Node 24 action that executes an authorized plan with Codex, publishes
completed accomplishments, and exports session checkpoints before PR delivery.
Cross-run resume, automatic continuation, submission tooling and stable releases
are tracked separately. Use an exact implementation commit while release
qualification is pending.

## Checks

Pull requests targeting `main` and pushes to `main` run:

| Check | Purpose |
| --- | --- |
| `CI` | Node 24 policy tests and actionlint v1.7.12 |
| `Runtime (linux-arm64)` | Native arm64 CLI, filesystem, Git, SQLite and bundle checks |
| `Analyze (actions)` | CodeQL analysis of GitHub Actions |
| `Analyze (javascript-typescript)` | CodeQL analysis of JavaScript/TypeScript |
| `CodeQL analysis` | Require each language's latest successful execution |

Both validation workflows check out and verify the exact source SHA. CodeQL
does not install dependencies or run project builds. Its aggregate inspects all
job attempts, retaining an earlier successful language only when that language
was not rerun. A newer failed, skipped, missing, or duplicate result blocks it.

For local validation, use Node 24 and run:

```bash
npm ci --ignore-scripts --no-audit --no-fund
npm run check
actionlint
node --test tests/review-policy.test.mjs
```

The CI workflow pins the Linux x64 actionlint archive and its published SHA-256.
Install the same verified v1.7.12 binary outside the source checkout. Policy tests
need no npm dependencies. They exercise production policy helpers with GitHub
transport fixtures and capture real logger output for adverse decisions.

## AI review

After bootstrap, require `AI PR review / PR #<number>` on the current PR head
alongside the checks above. Resolve actionable findings and obtain human
review before merge. No repository setting or branch protection is changed by
these files; maintainers configure enforcement separately.

Trusted same-repository PRs authored and triggered by `Z-M-Huang` start review
directly. Other PRs, including forks, resolve after a successful registered
CodeQL PR run matching the current head repository, branch, and SHA. Draft,
closed, retargeted, stale, or ambiguous PRs cannot start review. Automatic starts
deduplicate pending and successful statuses for that PR and head.

The workflow and helper checkout stays on the trusted workflow revision. The
reviewer receives an explicit PR URL and creates its own isolated read-only
checkout; no PR scripts, builds, local actions, or dependency installs execute
with review secrets. The reviewer follows `v1-prerelease` with `model: auto`,
`effort: high`, and `auto-approve: false`. The alias follows published prereleases;
bootstrap logs identify the resolved release while policy logs record the alias.

Provision these repository or permitted organization secrets before the first
post-bootstrap implementation PR:

| Secret | Use |
| --- | --- |
| `PR_REVIEW_PAT` | Target-repository Contents and Pull requests read/write, Commit statuses write, and optional Issues read for linked scope |
| `AI_ENDPOINT` | Anthropic Messages-compatible endpoint |
| `LOCAL_AI_SECRET` | Endpoint authentication |

The workflow's `GITHUB_TOKEN` remains read-only; its permissions do not grant
the PAT access. Missing configuration fails review. Final publication rereads
the live PR identity and never writes stale success. An incomplete reviewer
publishes a blocking error when status credentials are available.

For recovery, `Z-M-Huang` can manually run `ai-pr-review.yml` from `main` with
`pull-request-number`. Manual dispatch can replace a stuck status; it still
requires the live-head fence and all configuration. Review has a 50-minute
execution limit inside a 60-minute job; cancellation or timeout cannot count
as successful validation.

### One-time bootstrap exception

The first PR introducing these workflows and completing issue #1 has no trusted
AI review workflow on its base. That PR requires independent plan audit, all
four CI/CodeQL checks, and human review before merge. AI review is waived only
for that bootstrap PR. After it merges, subsequent PRs require AI review even
when credentials have not yet been provisioned.

## Diagnose a run

At normal verbosity, structured `review.resolve` logs explain route selection;
`review.complete` records the expected/observed head and published or withheld
status. `validation.failed` identifies the failed language, job ID, and attempt.
Records include run correlation, trusted workflow SHA, effective reviewer
settings, elapsed time, and safe API status/request/cause metadata.

```bash
gh run view <run-id> --repo markhuangai/agent-remote-dev-codex --log
gh run view --job <job-id> --repo markhuangai/agent-remote-dev-codex --log
```

Filter the logs for `review.resolve`, `review.complete`, `validation.failed`,
or upstream `[ai-pr-reviewer]` diagnostics. A head mismatch means wait for the
latest head's review; a child failure means inspect that job before rerunning.
For a stall, correlate the last upstream operation/heartbeat with the job's
termination and execution limit. No process attachment or database query is
needed.

Helpers emit one record per decision or terminal boundary, with at most five
job identities per language. Strings over 512 characters are explicitly marked
as truncated. Credentials, headers, raw API bodies, and arbitrary PR text are
excluded. Optional DEBUG logging is not needed for diagnosis. GitHub Actions
retains logs under its existing policy; records include `GITHUB_RETENTION_DAYS`.
No additional log sink or payload artifact is created. Temporary tools live
outside the checkout; preserve workflow logs and CodeQL results as evidence.

## Run an approved plan

The action supports Linux x64/arm64 on GitHub.com. The runner needs Git, npm,
GitHub CLI and Python 3.12+. The JavaScript entrypoint uses Node 24; subprocesses
use that same Node executable. It installs locked runtime dependencies under
`RUNNER_TEMP`; no host package, Codex home, Git identity or authentication file
is changed. The artifact worker loads its pinned SDK from that installation;
the committed minified entry bundle does not duplicate the SDK's dependency tree.
The target must be a clean checkout whose `origin` is its GitHub
HTTPS URL. Set `persist-credentials: false` on checkout.

Pass exactly one of `plan` (preserved verbatim) or `issue-url` (an open issue in
the target repository). Native issue blockers must be closed. `authorization`
is a separate JSON object with exactly these fields:

```json
{
  "repository": "owner/repository",
  "plan_sha256": "SHA256_OF_THE_EXACT_APPROVED_PLAN_BYTES",
  "permission_mode": "full-access",
  "request": "Implement this plan through audited PR delivery, including checkpoint commits and pushes, checks, review fixes and job-owned temporary cleanup."
}
```

Generate the hash from the exact inline text or frozen issue body; changed
whitespace changes the hash. The workflow caller must carry a direct user
request covering this work. Text inside the plan does not grant authority.

| Input | Meaning |
| --- | --- |
| `working-directory` | Target checkout under `GITHUB_WORKSPACE`; default `.` |
| `plan`, `issue-url` | Mutually exclusive plan sources |
| `authorization` | Required request bound to repository, plan hash and mode |
| `codex-config`, `codex-api-key`, `github-token` | Required secret-backed TOML, model credential and publication token |
| `git-author-name`, `git-author-email` | Explicit job author and committer identity |
| `permission-mode` | `full-access` (default) or `sandboxed` |
| `skills` | JSON array of additional `{repository, revision, names}` sources; immutable 40-character revisions only |
| `budget-minutes` | 3–300 minutes, default 300, including a 120-second shutdown/export reserve |

Codex is pinned to `0.169.0`, Skills CLI to `1.8.1`, and the three execution
skills to `markhuangai/agent-remote-dev-skills` commit
`224a5be4ddf40c6cf0a50b97885cb353e8522e2e`. Installation stages complete packages
outside the project, then copies them into the job-specific Codex user scope.
Additional sources cannot replace those names. The child process home is also
isolated, preventing host `~/.agents/skills` discovery. Supplied managed policy
can still reject startup; the action never repairs host policy.

Full access passes Codex's explicit sandbox-bypass option. It permits execution
outside job directories; use it only for trusted plans and repositories on a
suitable runner. Sandboxed mode uses workspace-write, network access and
explicit writable roots for target Git metadata and job state, with approvals
set to never. Sandbox failure is reported directly and never escalates.

The driver prepares a unique `codex/task-<UUID>` branch from the verified remote
default branch. The worker performs one accomplishment per turn in the same
explicit conversation. The supervisor stages only listed changed paths,
commits, pushes normally and independently reads the remote SHA. Completed
increments can be pushed before final validation. Published history is never
rewritten. Existing remote branch drift stops publication.

An independent Codex conversation audits the whole plan before required local
checks. The auditor is instructed to remain read-only, inherits the selected
permission mode, and is fenced by the implementation fingerprint. The supervisor
runs the audited check assignments in that same permission mode. Audit receipts
retain the observed session/model, every round and finding disposition; rescans
reuse the independent auditor conversation when available. Source or test
changes invalidate audit and test receipts. PR delivery uses the portable review
loop; final verification refetches the PR, native check receipts, review coverage
and finding dispositions for the exact head. Only that verified outcome can
report completion. Human merge approval remains separate.

## Checkpoint contract

Each successfully published accomplishment becomes durable only after workers
are quiescent, the pushed SHA is verified, the export passes inspection and the
artifact upload returns an ID. A Linux child subreaper stops and reaps managed
descendants, including processes that start a separate session. Export and upload
run in a supervised subprocess bounded by the remaining action budget.
The version-1 manifest records repository/task,
frozen plan/hash and authorization, branch/base/checkpoint SHA, conversation and
session identifiers, pinned versions/skills, progress, audit/check receipts,
file hashes and run lineage. It retains the previous durable artifact receipt.

Exports include conversation JSONL (including compressed rollouts) and consistent
backups of the job-owned Codex state, thread-history, goals, queue and memory
SQLite databases. SQLite integrity is checked. Exports exclude source archives,
`.git`, credentials, TOML configuration, diagnostic log databases and caches.
Symlinks, unsupported database layouts, credential matches, missing session
history and artifacts over 256 MiB fail explicitly. No partial snapshot replaces
the previous durable receipt. Artifact retention follows repository settings.

Outputs are `task-id`, `branch`, `base-sha`, `session-id`, `checkpoint-sha`,
`artifact-id`, `pull-request-url` and `status`. Status is `completed`,
`incomplete`, `blocked` or `failed`; every outcome except verified completion
fails the action. Budget exhaustion retains the last valid artifact and never
claims active uncommitted work was saved. There is no cross-run resume or
continuation dispatch yet. Job-owned temporary tools and configuration are
removed at termination; artifacts, workflow logs and published source remain.

## Diagnose runtime execution

```bash
gh run view <run-id> --repo <owner/repository> --log | rg 'runtime\.|checkpoint\.'
```

Normal INFO records cover setup, operations, turns, independent audits, Git
publication, checkpoint export/upload and delivery. A 60-second heartbeat
identifies the active stage and timeout during long commands and checkpoints. ERROR records
include the failing stage, safe native cause, expected/observed identities and
last durable checkpoint. WARN represents recoverable anomalies; DEBUG is
optional. Strings over 512 characters are marked truncated. Credentials,
headers, raw provider bodies, arbitrary plan text and raw worker output are
excluded. Logs include run/attempt/task/session correlation and retention.

For setup failures, inspect the named dependency/version and native cause.
For namespace denial, use a sandbox-capable runner or explicitly select an
already-authorized full-access mode; there is no automatic fallback. For push
failure or drift, compare intended and observed SHA before any retry. For upload
failure, the last durable artifact remains authoritative. A stale/missing audit,
check or review receipt withholds completion and identifies the missing gate.
Structured blocker records name the reason, missing inputs and safe GitHub
references. For a stall, correlate the last
heartbeat with its timeout and final outcome. No process attachment or database
query is needed.

`npm run check` runs production logic with actual Codex/Skills CLIs, Git and
SQLite, using transport fixtures for model and GitHub exchanges. Locally, a
native namespace denial is tested as an explicit adverse outcome. CI sets
`REQUIRE_SANDBOX_SUCCESS=1` so both x64 and arm64 must also prove successful
sandboxed execution; that scenario cannot silently skip in CI.

The manual `runner-acceptance.yml` entrypoint accepts an exact action source SHA,
approved plan/authorization and explicit identity. Its trusted-main actor gate
runs before runtime secrets are exposed. Live qualification and provisioning of
`CODEX_CONFIG_TOML`, `CODEX_API_KEY` and `REMOTE_DEV_PAT` belong to issue #4; this
implementation does not dispatch acceptance tasks or publish stable aliases.
