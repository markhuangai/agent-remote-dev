# agent-remote-dev-codex

Execute a refined plan with native Codex on GitHub-hosted or self-hosted Linux.
Selected skills own branches, commits, tests, reviews, PRs and completion. The
workflow provides isolated setup, process supervision and resumable native state.

Releases have not been published. Until a maintainer publishes a version, use an
explicitly authorized exact commit in place of `v1`.

## Consumer setup

Commit `.remote-codex.yml` in the consumer repository root:

```yaml
allowed-actors: [YOUR_GITHUB_LOGIN]
skills: []
auto-continue: false
max-continuations: 3
```

Create one caller workflow, for example `.github/workflows/codex.yml`:

```yaml
name: Remote Codex
on:
  workflow_dispatch:
    inputs:
      plan:
        description: Refined plan, or new context for a resumed conversation
        type: string
      resume-run-id:
        description: Prior workflow run containing the conversation
        type: string
      runs-on:
        description: JSON array of Linux runner labels
        type: string
        default: '["ubuntu-latest"]'
      timeout-minutes:
        description: GitHub job timeout in minutes
        type: number
        default: 360
permissions:
  contents: read
  actions: write
jobs:
  run:
    uses: markhuangai/agent-remote-dev-codex/.github/workflows/remote-codex.yml@v1
    with:
      plan: ${{ inputs.plan }}
      resume-run-id: ${{ inputs.resume-run-id }}
      runs-on: ${{ inputs.runs-on }}
      timeout-minutes: ${{ inputs.timeout-minutes }}
    secrets:
      codex-config: ${{ secrets.CODEX_CONFIG_TOML }}
      codex-api-key: ${{ secrets.CODEX_API_KEY }}
      github-token: ${{ secrets.REMOTE_DEV_PAT }}
```

Invoke the caller workflow from the repository's default branch. Consumers choose
its filename and Linux runner labels; forward the four inputs shown above so
automatic continuation can redispatch that workflow. Use one remote Codex call
per caller workflow run. GitHub enforces the selected job timeout and runner limits.

Provision `CODEX_CONFIG_TOML` for model/provider/MCP settings, `CODEX_API_KEY` for
model authentication, and `REMOTE_DEV_PAT` for Codex's GitHub operations. Grant the
PAT only the access the task needs: Contents/Pull requests read-write, Issues
read for issue plans, and access to private selected skill repositories. Tasks
editing workflow files also need Workflows write. Snapshot transport and recovery
use the workflow's separate `GITHUB_TOKEN`, with Actions read-write permission.

Both initiating and triggering actors must be allowlisted in the latest reviewed
`.remote-codex.yml` on the default branch and have repository write/maintain/admin
access. Authorization is checked again after acquiring the session lock. Automatic
children recheck their initiating operator's current access. This policy is
independent of the repository's AI-review trust policy.

Optional YAML keys are `git-author: {name: ..., email: ...}` and
`user-level-agents.md-url: https://...`. Instruction downloads require public HTTPS,
strict encoding and redirects, a 20-second timeout, and a 64 KiB limit. Skills
accept repository URLs or `{repository, ref, names}` objects. Omitted `ref` uses
the current default branch; omitted `names` installs every discovered skill.
Settings, selected skill revisions, instructions and secret configuration are
resolved anew on each run. Repository skills and `AGENTS.md` use native discovery.

The provider source is checked out at the reusable workflow's resolved commit,
installed through locked `package.json` dependencies, and compiled on the runner.
There is no root Action, committed distribution bundle, custom binary downloader,
local application or copied consumer helper directory. Node 24, npm, Git 2.36+,
GitHub CLI and Python 3.12+ are required on self-hosted Linux x64/arm64 runners.

Codex runs noninteractively with explicit full-access/YOLO and trusted-hook
bypasses. Job-owned homes, credentials and configuration preserve host setup;
YOLO execution requires an appropriate runner and authorized task/skill sources.
Codex receives the refined plan, may follow its selected skills, and can report
an indispensable clarification as its ordinary response. A successful run means
native execution returned normally; inspect the response for task completion.

## Checks

Pull requests targeting `main` and pushes to `main` run:

| Check | Purpose |
| --- | --- |
| `CI` | Node 24 policy tests and actionlint v1.7.12 |
| `Runtime (linux-arm64)` | Native arm64 CLI, filesystem, Git, SQLite checks |
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
Install the same verified v1.7.12 binary outside the source checkout. Review-policy tests
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

## Resume and cancellation

```bash
gh workflow run codex.yml --repo OWNER/REPO --ref main -F plan=@plan.md
gh run view RUN_ID --repo OWNER/REPO --log
gh run download RUN_ID --repo OWNER/REPO --pattern 'codex-result-*' --dir RESULT_DIRECTORY
gh workflow run codex.yml --repo OWNER/REPO --ref main -f resume-run-id=RUN_ID -F plan=@clarification.md
gh run cancel RUN_ID --repo OWNER/REPO
```

Substitute your default branch and caller filename. The optional
[remote-codex skill](skills/remote-codex/SKILL.md) contains only Markdown and teaches
an agent to use GitHub CLI or GitHub MCP. An uncertain dispatch response requires
inspection of existing runs before another submission.

A fresh run requires a plan. Resume selects the newest completed snapshot from
the requested run's latest attempt and uses its explicit native session ID.
Additional plan text becomes a new user turn; the original plan is already in
the conversation. Current YAML settings and fresh secrets apply on every run.
The saved published source commit is restored without merging newer main or
rewriting an existing local branch. When its local branch has moved, restoration
uses detached HEAD so the agent can decide how to continue safely.

Schema-4 artifacts preserve native conversation JSONL and supported SQLite state,
including goals, queues and memories. Managed writers pause briefly for a file
copy; validation and upload run after writers resume. Snapshots begin when session
state becomes available, repeat every 60 seconds, and save once more after normal
exit, including native errors and clarification responses. Only the last two
completed snapshots of each run attempt remain; older snapshots are deleted only
after a replacement upload succeeds. Existing log/evidence artifacts are retained.

Uncommitted files and unpushed commits are excluded. A dirty checkout or rejected
push still permits conversation export: the artifact records the nearest
published ancestor and an omitted-work warning. Resume tells Codex that omitted
work may need recreating. The platform never stages, commits or pushes on its
own. Repository/user native hooks can publish coherent progress under their own
policy and run with the same privileges as Codex.

Snapshots exclude authentication files, secret configuration, logs, caches and
working files. Archive validation rejects traversal, links, duplicate/encrypted
entries, unexpected files, hash mismatches and expansion beyond 256 MiB. SQLite
integrity, credential exclusion, native version and session references are
verified. Expired artifacts, unrelated producers, unsupported native versions and
legacy checkpoint formats stop restoration with diagnostics.

Enable `auto-continue: true` to recover after GitHub times out the Codex execution
job. A separate recovery job checks the actual execution step, current policy,
saved session and continuation limit before dispatching the same consumer
workflow. Setup or upload timeouts, normal returns, clarification, errors and
cancellation do not trigger continuation. The default maximum is three automatic
runs; explicit manual resume starts a fresh allowance. Recovery dispatch happens
only on the parent's first attempt, without automatic retries of ambiguous API
responses. Manual cancellation stops that run; inspect and cancel any child
already dispatched during a race.

Recovery uses the last completed upload, not the terminated runner's disk. A
60-second capture interval does not guarantee only 60 seconds of lost progress:
upload failures, validation failures or slow storage can leave an older snapshot.
A downstream job cannot retrieve files from a terminated runner. Final-save is a
separate step, so a failure while saving cannot masquerade as a native timeout.

## Diagnose runtime infrastructure

```bash
gh run view RUN_ID --repo OWNER/REPO --log | rg 'submission\.|runtime\.|checkpoint\.|resume\.|continuation\.|release\.'
```

INFO records identify setup, dependency versions, selected skills, current config
hash, session/run identity and completed snapshots. WARN records identify failed
snapshots and retention problems while preserving the prior artifact. ERROR
records identify native failures, rejected archives and required operations.
Commands emit a 60-second heartbeat. Credentials, raw prompts, secret configuration
and provider response bodies are excluded from logs; truncation is marked.
Preserve Actions logs, snapshot/result artifacts and CodeQL evidence.

## Live platform tests and releases

The acceptance harness and published workflow callers remain maintainer tests.
After merge and explicit live-qualification authorization, they exercise fresh
execution, manual cold resume, GitHub's actual job timeout and automatic recovery,
cancellation and rejected pushes on hosted and self-hosted Linux. Their registry
records owned test resources, and cleanup only touches proven task branches/PRs.
Live preflight requires the exact current merged source, provisioned runners and
secrets, and reviewed configuration enabling at least one automatic continuation.
Optional `v1`/`v1-prerelease` smoke pairs exercise the published reusable workflow.

`release.yml` verifies the dispatched main source, locked build/tests and required
CI/CodeQL results, then publishes an immutable version tag and GitHub release.
There are no custom runtime archives or mandatory qualification receipts. Stable
versions advance `vN`; prereleases advance `vN-prerelease`. Aliases move forward
without force; partial publication requires maintainer inspection. Release
publication and live qualification require their own explicit authorization.
