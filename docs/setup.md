# Setup

This repository already has a [Codex task runner](../.github/workflows/runner-task.yml)
that calls its own reusable workflow. Use it to develop this project without
publishing a release first. For another repository, follow
[Reuse the workflow](#reuse-the-workflow-from-another-repository) after configuring
the credentials below.

## 1. Prepare CODEX_CONFIG_TOML

The secret contains the raw contents of a Codex `config.toml`, without Markdown
fences. It selects the model, provider and optional MCP servers. Keep the model
API key in the separate `CODEX_API_KEY` secret.

For OpenAI directly, start with:

```toml
model = "gpt-6.1-sol"
model_reasoning_effort = "high"
forced_login_method = "api"
```

Use a model available to your API account. The runner exposes `CODEX_API_KEY` as
both `CODEX_API_KEY` and `OPENAI_API_KEY` inside the Codex process.
See the official [configuration reference](https://developers.openai.com/codex/config-reference)
and [API-key authentication guide](https://developers.openai.com/codex/auth).

For a custom provider supporting the Responses API, copy the
[sample TOML](../examples/codex-config.toml):

```toml
model = "YOUR_PROVIDER_MODEL"
model_provider = "remote"
model_reasoning_effort = "high"

[model_providers.remote]
name = "Remote provider"
base_url = "https://api.example.com/v1"
wire_api = "responses"
env_key = "CODEX_API_KEY"
```

Replace `YOUR_PROVIDER_MODEL` and `https://api.example.com/v1` with your
provider's model ID and base URL. Include `/v1` only if your provider requires it.
The endpoint must be reachable from the selected runner. Put that provider's API
key in `CODEX_API_KEY`.

`model_reasoning_effort` is a top-level setting, before
`[model_providers.remote]`. Choose an effort supported by the model and provider,
or remove the setting to use Codex's default for that model. Supported values
depend on the model; examples include `low`, `medium`, `high` and `xhigh`.

Start without MCP servers; Git and GitHub CLI are already available. Add MCP
configuration later if a task needs it. The runner manages execution permissions,
storage paths and credential files, so those do not need TOML settings.

## 2. Create REMOTE_DEV_PAT

A fine-grained personal access token is recommended for Git pushes, pull
requests and GitHub Actions operations. It is the token Codex uses through Git
and `gh`; it is separate from the workflow's automatic `GITHUB_TOKEN`.

Open [GitHub's fine-grained token form](https://github.com/settings/personal-access-tokens/new).
Name it `remote-codex`, choose an expiration, set the resource owner to
`markhuangai`, then select only `agent-remote-dev-codex`. For another consumer,
select that repository's owner and repository.

Grant repository permissions according to the work:

| Permission | Access | Purpose |
| --- | --- | --- |
| Contents | Read and write | Read source and push task branches and commits |
| Pull requests | Read and write | Create/update PRs, comment and resolve review threads |
| Issues | Read-only; read and write if needed | Read linked issues; write access allows comments and follow-up issues |
| Actions | Read-only; read and write if needed | Inspect jobs, logs and artifacts; write access allows dispatch, reruns and cancellation |
| Commit statuses | Read-only | Inspect statuses reported by CI and reviewers |
| Workflows | Read and write if needed | Push changes under `.github/workflows/` |
| Metadata | Read-only, automatic | Basic repository information |

For development of this repository with issue follow-ups, CI reruns and workflow
changes, enable the write options for Issues, Actions and Workflows. Organization
and administration permissions are not required for that work. A pending token
needs organization approval before it can write. Selected private skill
repositories also need Contents read access and must belong to the same resource
owner; public skill repositories can be read without selecting them.

GitHub currently lists the Checks API as a fine-grained PAT limitation. Inspect
Actions jobs and commit statuses with these permissions; tooling that requires
authenticated Checks API access needs a compatible credential, such as a GitHub
App token. Check that requirement before choosing a token for a full review loop.
See GitHub's [token limitations and setup](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens)
and [permission reference](https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens).

## 3. Add the three Actions secrets

Open [this repository's Actions secrets](https://github.com/markhuangai/agent-remote-dev-codex/settings/secrets/actions),
then create repository secrets with these exact names:

| Secret | Value |
| --- | --- |
| `CODEX_CONFIG_TOML` | The complete TOML from step 1 |
| `CODEX_API_KEY` | An API key for the model provider selected in the TOML |
| `REMOTE_DEV_PAT` | The GitHub token from step 2 |

Organization secrets also work when this repository is included in their access
policy. These are the three secrets required by the task runner.

With GitHub CLI, save your TOML outside the checkout and run:

```bash
gh secret set CODEX_CONFIG_TOML --repo markhuangai/agent-remote-dev-codex < /path/to/remote-codex-config.toml
gh secret set CODEX_API_KEY --repo markhuangai/agent-remote-dev-codex
gh secret set REMOTE_DEV_PAT --repo markhuangai/agent-remote-dev-codex
```

The last two commands prompt for their values. Enter credentials through the
secret form or prompt, rather than putting them in a plan or committing them.

Snapshot transport and automatic recovery use the workflow's `GITHUB_TOKEN`
with `actions: write`. The PAT's Actions permission controls Codex's own GitHub
CLI operations.

## 4. Check repository configuration

The root [`.remote-codex.yml`](../.remote-codex.yml) in this repository currently
allows `Z-M-Huang`, installs the skills from `markhuangai/agent-remote-dev-skills`,
and disables automatic continuation.
It downloads the shared Golden instructions as user-level `AGENTS.md` on each run.
Both the initiating and triggering user must be allowed and have repository
write, maintain or admin access. Changes must reach the default branch before
they apply to a run.

Skills are optional. Put branch creation, commits, pushes, PR creation and review
requirements in the plan or selected skills; the platform does not perform those
delivery steps itself. This repository's `AGENTS.md` also applies to task execution.

This repository and the consumer example use the Golden instructions through
the optional `user-level-agents.md-url` key in the root `.remote-codex.yml`:

```yaml
user-level-agents.md-url: https://raw.githubusercontent.com/Z-M-Huang/golden-CLAUDE.md/refs/heads/main/CLAUDE.md
```

The runner downloads the Markdown to its isolated `$CODEX_HOME/AGENTS.md`;
the source filename can be `CLAUDE.md`. The repository's own `AGENTS.md` is still
discovered automatically. Set a different public HTTPS URL to use other shared
instructions, or omit the key to use only the repository instructions.

## 5. Start a task

Write your refined plan to `plan.md`, including the linked issue, intended change,
acceptance criteria and delivery requirements. For example, request a task
branch, required validation, commits and a push, then a pull request and the
review loop. Avoid asking the runner to merge.

In [Actions → Codex task runner](https://github.com/markhuangai/agent-remote-dev-codex/actions/workflows/runner-task.yml),
select **Run workflow**, choose `main`, and paste the plan. The form contains only
`plan` (or new context) and `resume-run-id`; leave the latter empty for a fresh
task. Alternatively:

```bash
gh workflow run runner-task.yml --repo markhuangai/agent-remote-dev-codex --ref main -F plan=@plan.md
gh run list --repo markhuangai/agent-remote-dev-codex --workflow runner-task.yml --limit 5
gh run view RUN_ID --repo markhuangai/agent-remote-dev-codex --log
```

The caller's YAML fixes `runs-on: '["ubuntu-latest"]'` and `timeout-minutes: 360`
under `jobs.run.with`. Repository owners change scheduling there, not in the
task form or `.remote-codex.yml`. Read the `codex-result-*` artifact to confirm
what Codex completed.

To answer a clarification or continue saved work, run the same caller with the
previous run ID and a file containing the additional context:

```bash
gh workflow run runner-task.yml --repo markhuangai/agent-remote-dev-codex --ref main -f resume-run-id=RUN_ID -F plan=@context.md
```

## Reuse the workflow from another repository

Releases have not been published. Until a maintainer publishes a version, use an
explicitly authorized exact commit in place of `v1`. The caller below shows the
interface for a published release.

Commit `.remote-codex.yml` in the consumer repository root:

```yaml
allowed-actors: [YOUR_GITHUB_LOGIN]
skills: []
user-level-agents.md-url: https://raw.githubusercontent.com/Z-M-Huang/golden-CLAUDE.md/refs/heads/main/CLAUDE.md
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
permissions:
  contents: read
  actions: write
jobs:
  run:
    uses: markhuangai/agent-remote-dev-codex/.github/workflows/remote-codex.yml@v1
    with:
      plan: ${{ inputs.plan }}
      resume-run-id: ${{ inputs.resume-run-id }}
      runs-on: '["ubuntu-latest"]'
      timeout-minutes: 360
    secrets:
      codex-config: ${{ secrets.CODEX_CONFIG_TOML }}
      codex-api-key: ${{ secrets.CODEX_API_KEY }}
      github-token: ${{ secrets.REMOTE_DEV_PAT }}
```

Invoke the caller workflow from the repository's default branch. Consumers choose
its filename and configure `runs-on` and `timeout-minutes` once under the reusable
call's `with:` block. The reusable workflow keeps those optional scheduling inputs
(defaulting to `ubuntu-latest` and 360 minutes) solely for its execution job.
Only `plan` and `resume-run-id` are task inputs. Automatic recovery dispatches
only those two fields, so the consumer's current YAML supplies scheduling again.
Use one executing remote Codex call per caller workflow run; mutually exclusive
declared calls are supported. GitHub enforces job timeout and runner limits.

Configure the three Actions secrets using the steps above, with your consumer
repository as the target.

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

On GitHub.com, the executing job's `workflow_repository`, `workflow_file_path`,
`workflow_ref` and `workflow_sha` identify the reusable provider, independently of
other declared calls or the caller's revision. These job context fields are not
available on GitHub Enterprise Server. The workflow validates provider and caller
identity, checks out the immutable provider SHA, installs locked `package.json`
dependencies, and compiles on the runner.
There is no root Action, committed distribution bundle, custom binary downloader,
local application or copied consumer helper directory. Node 24, npm, Git 2.36+,
GitHub CLI and Python 3.12+ are required on self-hosted Linux x64/arm64 runners.

Codex runs noninteractively with explicit full-access/YOLO and trusted-hook
bypasses. Job-owned homes, credentials and configuration preserve host setup;
YOLO execution requires an appropriate runner and authorized task/skill sources.
Codex receives the refined plan, may follow its selected skills, and can report
an indispensable clarification as its ordinary response. A successful run means
native execution returned normally; inspect the response for task completion.

## Resume and cancellation

```bash
gh workflow run codex.yml --repo OWNER/REPO --ref main -F plan=@plan.md
gh run view RUN_ID --repo OWNER/REPO --log
gh run download RUN_ID --repo OWNER/REPO --pattern 'codex-result-*' --dir RESULT_DIRECTORY
gh workflow run codex.yml --repo OWNER/REPO --ref main -f resume-run-id=RUN_ID -F plan=@clarification.md
gh run cancel RUN_ID --repo OWNER/REPO
```

Substitute your default branch and caller filename. The optional
[remote-codex skill](../skills/remote-codex/SKILL.md) contains only Markdown and teaches
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
During execution, `runtime.tool` INFO records show command starts/completions,
the first line of each redacted command, and changed file paths with add/update/delete
status. MCP calls, agent delegation and web activity include their tool/action names;
failed or declined tools produce WARN records with available exit codes. Records
include session, item and run identity. Command previews use the existing 512-character
limit; file-change lists keep up to 100 paths and report the omitted count.
Tool output, patch bodies, MCP arguments/results, assistant messages and reasoning
are not printed. Use the saved conversation for the full interaction history.
Preserve Actions logs, snapshot/result artifacts and CodeQL evidence.
