# agent-remote-dev-codex

Repository infrastructure for a Codex plan runner. Runner execution and session
features are tracked separately; this bootstrap establishes validation first.

## Checks

Pull requests targeting `main` and pushes to `main` run:

| Check | Purpose |
| --- | --- |
| `CI` | Node 24 policy tests and actionlint v1.7.12 |
| `Analyze (actions)` | CodeQL analysis of GitHub Actions |
| `Analyze (javascript-typescript)` | CodeQL analysis of JavaScript/TypeScript |
| `CodeQL analysis` | Require each language's latest successful execution |

Both validation workflows check out and verify the exact source SHA. CodeQL
does not install dependencies or run project builds. Its aggregate inspects all
job attempts, retaining an earlier successful language only when that language
was not rerun. A newer failed, skipped, missing, or duplicate result blocks it.

For local validation, use Node 24 and run:

```bash
actionlint
node --test tests/review-policy.test.mjs
```

The CI workflow pins the Linux x64 actionlint archive and its published SHA-256.
Install the same verified v1.7.12 binary outside the source checkout. The tests
need no npm dependencies. They exercise production policy helpers with GitHub
transport fixtures and capture real logger output for adverse decisions.

## AI review

After bootstrap, require `AI PR review / PR #<number>` on the current PR head
alongside the four checks above. Resolve actionable findings and obtain human
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
with review secrets. The reviewer is pinned to `v1.2.3-rc.0` with `model: auto`,
`effort: xhigh`, and `auto-approve: false`.

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
