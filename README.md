# agent-remote-dev-codex

Run native Codex on GitHub-hosted or self-hosted Linux with selected skills and
optional user-level instructions. Skills own workflow state, Git changes, tests,
audits, PRs and completion. The runner provisions an isolated job, supervises
processes and transports verified native sessions across fresh runners.

Release qualification is pending. Use an explicitly authorized exact source
commit until the post-merge qualification and publication gates pass.

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
npm run test:skill-install
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

## Run the action

Commit `remote-codex.yml` in the target repository root:

```yaml
allowed-actors: [YOUR_GITHUB_LOGIN]
skills:
  - repository: https://github.com/markhuangai/agent-remote-dev-skills
    ref: 224a5be4ddf40c6cf0a50b97885cb353e8522e2e
    names: [sdlc-plan-implementation, plan-audit, pr-review-loop]
user-level-agents.md-url: https://raw.githubusercontent.com/Z-M-Huang/golden-CLAUDE.md/refs/heads/main/CLAUDE.md
git-author:
  name: YOUR_GIT_NAME
  email: YOUR_GIT_EMAIL
budget-minutes: 300
auto-continue: false
max-continuations: 3
runner: [ubuntu-latest]
```

The skills and URL above are examples. Omit `skills` for no external packages and
omit `user-level-agents.md-url` for no downloaded user instructions. Git identity
defaults to `github-actions[bot]` in the isolated child. Unknown keys, malformed
YAML, duplicate keys, aliases, invalid identities and unsupported runners fail
explicitly. Keep credentials in GitHub secrets rather than this file.

A consumer needs one workflow, this configuration file, and three secrets.
The reusable workflow loads our prebuilt implementation on the runner:

```yaml
name: Remote Codex
on:
  workflow_dispatch:
    inputs:
      plan:
        description: Prompt for Codex, including any issue references
        required: true
        type: string
permissions:
  contents: read
  actions: write
jobs:
  execute:
    uses: markhuangai/agent-remote-dev-codex/.github/workflows/remote-codex.yml@v1
    with:
      plan: ${{ inputs.plan }}
    secrets:
      github-token: ${{ secrets.REMOTE_DEV_PAT }}
      codex-api-key: ${{ secrets.CODEX_API_KEY }}
      codex-config: ${{ secrets.CODEX_CONFIG_TOML }}
```

No support scripts, parser bundles, protocol manifests or qualification workflows
are copied into the consumer repository. GitHub checks out our exact referenced
implementation into a temporary runner checkout. The reusable workflow selects
configured runner labels, checks operator authority before using task credentials,
then installs Codex, selected skills and optional user instructions and runs the
plan in YOLO mode. Its write permission is confined to continuation and cancellation
jobs; execution and preparation use read-only workflow tokens.

Use an exact published version or commit when pinning; `v1` becomes available
only after the separately authorized release process. The action derives and
verifies the installed implementation's exact source from `uses:` metadata or
a local action checkout. If a moving ref changes between download and source
verification, mismatched resources reject execution. Callers do not provide
source identities, task IDs, authorization JSON or continuation context.
You can also call the root action directly from an existing job with `plan`,
the three secret inputs and an optional `working-directory`. That form uses
the job's existing checkout and `runs-on` selection.

Run manual workflows on trusted `main`. The exact prompt is passed to Codex;
issue URLs, issue content and dependency decisions belong to the selected skills.
For example, `plan: Implement https://github.com/OWNER/REPO/issues/4 using $my-skill`.
The repository PAT authenticates Codex's GitHub operations. Both workflow actors
must also be allowlisted with repository write permission.

Skill repositories accept URLs or objects with `repository`, optional `ref`, and
optional `names`. Omit `names` to install all discovered packages; omit `ref` to
resolve the default branch once. Resolved commits and names, project configuration
bytes/hash, and user instructions are frozen for checkpoint restoration. Complete
packages install in the isolated user scope; repository skills and instructions
remain native checkout content. Instruction URLs must be public HTTPS; downloads
have a 20-second timeout and 64 KiB limit, with strict encoding/hash/redirect checks.

## Optional local client

Install the complete `remote-codex` skill with Skills CLI 1.8.1 when a local agent
should submit and manage tasks. Its [usage guide](skills/remote-codex/references/usage.md)
describes Node 24, GitHub CLI and Python 3.12+ prerequisites. It never transfers
local Codex history or credentials. The client reads the target's committed
`remote-codex.yml` rather than requiring settings on every invocation.

The optional installer writes exactly two files: `remote-codex.yml` and
`.github/workflows/runner-task.yml`. That caller template includes the internal
request input and completion event needed for queue/resume/stop and optional
automatic continuation. All executable helpers remain in our bundled package.
Review and merge these two files before using the client. Installation refuses
existing files and linked destinations; it does not commit, push, configure
secrets or register runners. Set `auto-continue: true` only with this compatible
single-file caller. Qualification and release tooling stays in this provider repository.

```bash
node <installed-skill>/scripts/install-workflows.mjs --directory . --actors LOGIN --ref v1
node <installed-skill>/scripts/remote-codex.mjs queue --repo OWNER/REPO \
  --plan-file prompt.md --dry-run
node <installed-skill>/scripts/remote-codex.mjs queue --prepared prepared-task.json
```

Save dry-run JSON as `prepared-task.json` in a task-owned temporary directory.
Prompt and configuration hashes are rechecked before one dispatch. Workflow
requests are limited to 65,535 bytes; use a short prompt referencing an existing
issue for larger task descriptions. A request identity exists only to reconcile
ambiguous pre-dispatch responses. The resulting GitHub run ID identifies the
task and remains its root through continuation. Initial-run reruns are rejected;
use an explicit resume for retained checkpoints.

`npm run build` in this provider repository produces the runtime, workflow helper
and local client bundles in `dist/` and regenerates the self-contained skill
package. These are prebuilt Node 24 programs for both supported Linux
architectures. Consumers do not build them or install this project's npm
dependencies. Separate native executables are unnecessary for GitHub Actions.

## Runners, credentials and trust

Execution is Linux x64/arm64 with Node 24, Git, npm, GitHub CLI and Python 3.12+.
Use `["ubuntu-latest"]` or `["self-hosted","Linux"]` with optional architecture or
custom labels. Native arm64 hosted execution can use `["ubuntu-24.04-arm"]`.
The selected labels are frozen across continuation. A self-hosted runner must
already be provisioned; the action does not install host packages or register it.

Both the original and triggering user must appear in reviewed
`remote-codex.yml` under `allowed-actors` and have repository write/maintain/admin
permission. The initial allowlist here is `Z-M-Huang`; consumer installation
requires explicit logins. The reusable workflow checks actors on trusted `main` before the secret-bearing execution
step and again after acquiring the per-task lock; standalone action setup checks
actors before native execution. Automatic bot children need
a unique verified controller claim. Each automatic dispatch and execution also
rechecks the humans behind the current explicit activation against current `main`
and repository write permission. Activation is bound to its exact run attempt;
rerunning that activation invalidates its automatic children. An authorized manual
resume can establish a new activation after another operator loses access.
This policy is separate from AI-review trust.

Provision these runtime secrets:

| Secret | Purpose |
|---|---|
| `CODEX_CONFIG_TOML` | Model/provider/MCP configuration |
| `CODEX_API_KEY` | Model authentication |
| `REMOTE_DEV_PAT` | GitHub access for the selected task and explicit qualification dispatch |

The task token needs Contents/Pull requests/Actions read-write, Checks/Commit
statuses read, Issues read for issue prompts, and Workflows write only for tasks
that edit workflows. Give it read access to selected private skill repositories.
Review secrets and their separate scopes are documented above; the runner never
installs a reviewer or makes one mandatory for consumers.

Codex is pinned to `0.169.0`, Skills CLI to `1.8.1`, and the artifact SDK to `6.3.1`.
Tools, user home, credentials, configuration and npm cache are job-owned under
`RUNNER_TEMP`. Host Git identity, global configuration and authentication files
remain untouched by setup. The checkout uses `persist-credentials: false` and its
HTTPS origin. Task Git identity comes from project configuration for the isolated child.

Execution always uses Codex's explicit full-access/YOLO bypass. There is no
permission-mode selector, and legacy mode fields are rejected. Isolated homes
preserve host configuration; YOLO execution is not a containment boundary. Run
only authorized prompts and skill packages on a suitable runner.

## Native execution and checkpoints

The supplied prompt runs through native Codex create/resume. There is no required
worker output schema, mandatory SDLC skill, supervisor branch, Git publisher,
audit/test phase or PR-completion verifier. Skills decide their own workflow and
can finish without creating a PR. A normal invocation return does not certify
business success; inspect the selected skill's opaque final response.

Default action budget is 300 minutes inside a 360-minute task job, including a
120-second shutdown/export reserve. Automatic continuation is disabled by default; when enabled, three additional runs are allowed unless configured otherwise.
The trusted completion controller handles only deadline transport and verified
native timeouts. Failure, cancellation, stop requests and exhausted limits do not
automatically restart a task. Task execution and child dispatch are serialized.
Ambiguous dispatch responses reconcile by deterministic identity for five minutes;
a persisted claim never permits a blind second POST.

Schema-3 checkpoints contain native conversation JSONL, supported SQLite snapshots,
frozen prompt and project configuration, selected skill revisions, user instructions, source
identity and run lineage. They contain no runner-owned business phases or review
budgets. Exports require managed-process quiescence, a clean checkout and an exact
remote branch/revision chosen by the skill. The runner never stages, commits,
pushes, resets or creates a task branch to make checkpointing succeed. Unpublished
files, source archives, arbitrary temporary state, credentials, secret provider configuration and
caches are not exported. A checkpoint failure retains the preceding durable
receipt and does not reinterpret the skill's response.

Archive validation rejects traversal, absolute/drive paths, links, duplicate or
encrypted entries, unexpected files, hash mismatches and expansion beyond 256 MiB.
SQLite integrity and credential exclusion are checked. Native session IDs and
relocated rollout paths are verified before resuming the explicit conversation.
Changed settings, expired artifacts, producer mismatches and source drift stop
resume without rewinding Git. Versions 1 and 2 are explicitly rejected, with no
migration of their SDLC state.

Outputs describe infrastructure: observed `branch`, `base-sha`,
`checkpoint-sha`, `session-id`, `artifact-id`, `result-artifact-id`, `native-outcome`,
`status`, `root-run-id`, `parent-run-id`, and `continuation-count`. `completed` means
the native invocation returned; `continuing` means a durable deadline handoff.
The response artifact is protected task output, not an execution authority.

```bash
node <installed-skill>/scripts/remote-codex.mjs status --repo OWNER/REPO --run-id ROOT_RUN_ID
node <installed-skill>/scripts/remote-codex.mjs status --repo OWNER/REPO --run-id ROOT_RUN_ID --show-result
node <installed-skill>/scripts/remote-codex.mjs resume --repo OWNER/REPO --run-id ROOT_RUN_ID --artifact-id ID
node <installed-skill>/scripts/remote-codex.mjs stop --repo OWNER/REPO --run-id ROOT_RUN_ID
```

Stop requests persist a cancellation receipt and fence child dispatch and queued
execution through native run identity, even after artifacts expire. A later
explicit manual resume can establish a new activation within the same frozen
continuation allowance. The helper follows parent/child/controller URLs; it does
not parse skill phases or claim a PR passed review.

## Diagnose runtime infrastructure

```bash
gh run view <run-id> --repo <owner/repository> --log | \
  rg 'submission\.|runtime\.|checkpoint\.|resume\.|continuation\.|release\.'
```

INFO records identify setup, effective versions/settings, selected revisions,
instruction/prompt hashes, actor, runner, native session, run/attempt lineage,
artifact/claim identity and final infrastructure outcomes. A 60-second heartbeat
identifies the active command and deadline. WARN records explain recoverable
checkpoint unavailability; ERROR records identify rejected inputs, archive/source
invariants, safe native causes and failed required operations. DEBUG is optional.

For changed inputs compare expected/observed hashes before dispatch. For source
drift or failed publication, inspect the selected skill's response and the
recorded local/remote SHA; no runner repair occurs. For a stall, follow the last
heartbeat and timeout. For uncertain registration, inspect the existing native
run/claim before recovery. Preserve logs, result/checkpoint artifacts and CodeQL
evidence under repository retention. Strings over 512 characters and bounded-list
omissions are marked; credentials, raw prompts/instructions/provider bodies and
arbitrary PR text are excluded from logs.

## Qualification and publication

No live qualification or release is claimed by this implementation PR. After
human merge, provision runtime secrets and a self-hosted Linux runner, then
separately authorize `runner-acceptance.yml` on trusted `main`. Supply an exact
merged source SHA and direct authorization for uniquely identified smoke branches,
draft PRs, resume/cancellation and scoped cleanup. The harness runs `fresh`,
`cold-resume`, `deadline`, `cancellation` and `failed-push` on hosted and self-hosted
Linux. An ordinary test prompt defines each scenario without installing a skill.
The harness checks real run/session/source evidence. Cleanup fences owned tasks, closes proven smoke
PRs without merging, removes only their proven branches and retains evidence.
Missing scenarios, mismatched sessions/source or unproven cleanup fail qualification.

`release.yml` is a separate maintainer-dispatched operation on `main`. It requires
successful exact-source main CI/CodeQL children, complete qualification/cleanup,
fresh source/bundle checks and a complete installed submission package. The initial
versions are `v1.0.0-rc.0` and `v1.0.0`. Exact version tags are creation-only.
Source installation, builds and tests run in a separate read-only job. The
publisher executes only trusted policy and accepts a bounded, digest-bound
artifact from that exact build run/attempt. It treats archives as data, rejects
unsafe entries and independently compares all package bytes with Git blobs at
the qualified source SHA before generating the release manifest.
Prereleases advance `v1-prerelease`; stable releases advance `v1`; aliases use
forward API updates with `force: false`. A partial or ambiguous publication stops
for maintainer inspection rather than overwriting a version or retrying blindly.

First qualify the merged SHA and explicitly publish `v1.0.0-rc.0`. Run qualification
again with `action-ref: v1-prerelease` and that exact SHA. In addition to the five
source cases, this runs a fresh/manual-resume pair per runner family through
literal published `uses:` steps. The two channel jobs are separately gated, so
prerelease qualification does not download the not-yet-published stable alias.
Promotion independently verifies their actual run/attempts, invocation provenance,
artifact producers, frozen settings and native checkpoint/session lineage.
Stable promotion requires this published prerelease smoke receipt.
Publish `v1.0.0`, verify `v1` and `v1-prerelease` resolve to their exact
releases, and smoke the published stable action before remote cutover. Source and
bundle checks, qualification run URLs, release IDs, exact tags/commits and alias
targets are recorded without credentials. Do not move this repository's subsequent
tickets remotely until those cutover gates pass.
