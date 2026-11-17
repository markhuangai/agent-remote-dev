# agent-remote-dev-codex

Run native Codex on GitHub-hosted or self-hosted Linux with selected skills and
optional user-level instructions. Skills own workflow state, Git changes, tests,
audits, PRs and completion. The runner provisions an isolated job, supervises
processes and transports verified native sessions across fresh runners.

Releases have not been published. Use an explicitly authorized exact source
commit until a maintainer publishes a version.

## Run the action

Commit `remote-codex.yml` in the target repository root:

```yaml
allowed-actors: [YOUR_GITHUB_LOGIN]
skills: []
```

Select any skill packages under `skills`; the default is no external packages.
Optionally set `user-level-agents.md-url` to a public HTTPS instructions file.
There is no downloaded instructions file by default. Repository skills and
`AGENTS.md` remain available through native Codex discovery.

Create a workflow using the prebuilt root action and three repository secrets:

```yaml
name: Remote Codex
on:
  workflow_dispatch:
    inputs:
      plan:
        description: Prompt for Codex, including any issue references
        type: string
      resume-run-id:
        description: Prior run whose saved conversation should be restored
        type: string
permissions:
  contents: read
  actions: read
jobs:
  execute:
    runs-on: ubuntu-latest
    timeout-minutes: 360
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7
        with:
          persist-credentials: false
      - uses: markhuangai/agent-remote-dev-codex@v1-prerelease
        with:
          plan: ${{ inputs.plan }}
          resume-run-id: ${{ inputs.resume-run-id }}
          github-token: ${{ secrets.REMOTE_DEV_PAT }}
          codex-api-key: ${{ secrets.CODEX_API_KEY }}
          codex-config: ${{ secrets.CODEX_CONFIG_TOML }}
```

Use an explicitly authorized exact commit until releases are published; afterward
use an exact version or the `v1-prerelease` / `v1` release channel. The action
installs Codex, selected skills and optional user instructions in an isolated
home, then executes the prompt in YOLO mode. Consumers do not install this
project's dependencies or copy implementation files into their repositories.

The action uses the existing checkout and job runner. An action cannot select
an already allocated runner; set `runs-on` in the job. The optional
[reusable workflow](.github/workflows/remote-codex.yml) reads configured runner
labels before allocating execution. Its single caller also supports the local
client, cross-run resume, stop and automatic continuation described below.

The action uses the package selected by `uses:`. Build and release checks verify
that committed bundles match source; execution does not download a second
package inventory. Callers supply no source identities, task IDs or authorization
JSON. Configure skills, user instructions and task settings in `remote-codex.yml`;
keep credentials in GitHub secrets. Runner selection belongs to the workflow.

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

## Local skill and GitHub tools

The optional [remote-codex skill](skills/remote-codex/SKILL.md) contains only
`SKILL.md`. It teaches a local agent to use GitHub CLI or GitHub MCP. There is no
local application, installer, generated caller or consumer helper directory.
Create the workflow and project configuration shown above using your normal
repository process.

```bash
gh workflow run remote-codex.yml --repo OWNER/REPO --ref main -F plan=@prompt.md
gh run list --repo OWNER/REPO --workflow remote-codex.yml
gh run view RUN_ID --repo OWNER/REPO --log
gh workflow run remote-codex.yml --repo OWNER/REPO --ref main -f resume-run-id=RUN_ID
gh run cancel RUN_ID --repo OWNER/REPO
```

Use the filename of your consumer workflow. If a dispatch response is uncertain,
inspect existing runs before submitting again. GitHub run IDs identify executions;
resume takes the prior run ID and selects its latest checkpoint.

`npm run build` builds the native action and optional workflow helper into
`dist/`. These are prebuilt Node 24 programs with supporting Python files;
consumers neither build them nor install this project's dependencies. The local
skill has no generated code or package inventory.

## Runners, credentials and trust

Execution is Linux x64/arm64 with Node 24, Git, npm, GitHub CLI and Python 3.12+.
Set `jobs.<job>.runs-on` in the consumer workflow, for example `ubuntu-latest`,
`ubuntu-24.04-arm`, or `[self-hosted, Linux, ARM64]`. The project configuration
rejects `runner`; it never allocates machines or freezes runner labels in a
conversation. Self-hosted machines must already have the required host tools.
The optional reusable workflow takes `runs-on` from its caller workflow; its
internal dispatch preserves that workflow choice for automatic children.

Both the original and triggering user must appear in the latest `main` version
of `remote-codex.yml` under `allowed-actors` and have repository write/maintain/admin
permission. Resume checks the current policy, independently of the source commit
being restored. Automatic children verify their transport claim and recheck the
current permissions of the initiating user. There are no historical approval
snapshots. This policy is separate from AI-review trust.

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
Invalid saved settings, expired artifacts, producer mismatches and missing source commits stop
resume. A newer branch tip does not block restoration: the saved commit is
checked out without merging main or rewriting an existing local branch. Versions 1 and 2 are explicitly rejected, with no
migration of their SDLC state.

Outputs describe infrastructure: observed `branch`, `base-sha`,
`checkpoint-sha`, `session-id`, `artifact-id`, `result-artifact-id`, `native-outcome`,
`status`, `root-run-id`, `parent-run-id`, and `continuation-count`. `completed` means
the native invocation returned; `continuing` means a durable deadline handoff.
The response artifact is protected task output, not an execution authority.

Resume restores the saved conversation, original skill revisions, instruction
bytes and committed source revision. Current main changes do not alter that
workspace. A checkpoint contains no uncommitted files or unpushed commits;
those changes cannot be recovered on another runner.

Native Codex hooks load from its standard user configuration or the restored
repository's `.codex/hooks.json` / `.codex/config.toml`. The action enables hooks
noninteractively for this authorized YOLO invocation. Configure a native
`PostToolUse` hook to commit and push coherent progress frequently. The repository
or selected skill supplies that hook's policy and commands; the platform does not
stage, commit, push, create branches or force-push for checkpointing. A local
commit alone is insufficient: the revision must be available from the remote.
Hooks from task code execute with the same privileges as Codex.

GitHub cancellation stops the selected run. For optional automatic continuation,
the reusable workflow also has a task-wide stop route that fences queued children;
a later explicit manual resume can reactivate the task. Cancellation or native
failure does not automatically restart execution.

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

## Live platform tests and publication

Our repository retains `runner-acceptance.yml`, `runner-published.yml`, the
qualification harness and its fixtures. These are maintainer integration tests,
not consumer setup. After merge and separate authorization, they exercise fresh
execution, cold resume, deadlines, cancellation and failed pushes on hosted and
self-hosted Linux. They verify native sessions and test-owned Git changes, clean
up only their own branches/PRs, and retain evidence. They do not prescribe the
consumer's development workflow.

`release.yml` takes a version and publishes the exact main commit selected by
that workflow dispatch. It requires successful source CI/CodeQL jobs and a fresh
bundle check. Builds run in a read-only job, and the publisher verifies the build
artifact against that source before creating the release. There is no manual
source-SHA input or required qualification-run receipt.

Exact version tags are creation-only. Prereleases such as `v1.0.0-rc.0` advance
`v1-prerelease`; stable releases such as `v1.0.0` advance `v1`. Later major versions
use `vN-prerelease` / `vN`. Alias updates must move forward without force. A partial
publication stops for maintainer inspection. This PR does not merge, run live
qualification, publish releases, change aliases or provision secrets/runners.
