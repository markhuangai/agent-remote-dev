# Maintenance

Repository development, validation, AI review and release operations.

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
gh run view <run-id> --repo markhuangai/agent-remote-dev --log
gh run view --job <job-id> --repo markhuangai/agent-remote-dev --log
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

## Task workflows and published-version tests

For audited delivery, invoke `$sdlc-plan-implementation` with the complete
approved plan. Use it and its `plan-audit`/`pr-review-loop` dependencies from
`markhuangai/agent-remote-dev-skills` at `224a5be4ddf40c6cf0a50b97885cb353e8522e2e`.
Require independent audit conformance before tests and final `automation_clean`
on the exact PR head. This repository runs full CI automatically; there is no
review-first validation request or pre-PR remote test route. Keep human review
and merge as separate gates. See the [setup instructions](setup.md#deliver-an-audited-implementation-through-a-pr).

`runner-task.yml` is the normal development entrypoint and keeps its filename for
run history and resume. Its form contains `runner` (`codex` or `claude`, default `codex`), `plan` (or new context) and
`resume-run-id`. Repository owners configure runner labels and job timeout in
`jobs.run.with`; this repository fixes them to `ubuntu-latest` and 360 minutes.
Recovery sends the recorded runner with plan/resume and reapplies the current caller YAML settings.
Both native agents, Git, SQLite, snapshot, resume, cancellation, credential-exclusion
and continuation regressions remain in the local and CI suites.

`runner-published.yml`, named **Test published remote development workflow**, is the single
maintainer test entrypoint. Its form offers `channel` (`stable` or `prerelease`),
agent runner, plan, resume ID, machine labels and timeout. Mutually exclusive jobs call literal
`@v1` and `@v1-prerelease` references. Provider checkout uses the executing job's
workflow identity, not the run's list of all declared reusable calls.

`v1` is published. Published-version smoke execution waits for both declared
channel tags, including `v1-prerelease`. Once both tags exist and the run is
authorized, select the channel and supply a test plan. For manual resume, select
the same channel and prior run ID. Recovery sends
no channel or scheduling overrides, so this maintainer form's YAML defaults apply
to automatic children. Automatic continuation remains disabled in this repository.

## Publish release

`release.yml`, named **Publish release**, is the sole release publisher. It
verifies the dispatched main source, locked build/tests and required CI/CodeQL
results, then publishes an immutable version tag and GitHub release record.
Enter a stable version such as `1.2.3` or a release candidate such as
`1.2.3-rc.0`. The `v` prefix is optional in the input and published version
tags always include it. Every release must be newer than the latest stable
release, and release candidates must also advance their major's prerelease
channel. Stable releases advance their major tag (`vN`) and `latest` and receive
GitHub's **Latest** badge. Prereleases advance `vN-prerelease` alone.

The publisher updates the applicable aliases atomically and requires each update
to move forward. For partial publication, inspect the version tag, release record,
and alias SHAs using `gh run view <run-id> --log | rg 'release\.(verify|aliases)'`.
Use the logged version and verified refs for any authorized alias repair.
It does not execute development tasks or publish custom runtime archives.
Release publication requires its own explicit authorization.
