# Setup

This repository already has a [remote development task runner](../.github/workflows/runner-task.yml)
that calls its own reusable workflow. Use it to develop this project without
publishing a release first. For another repository, follow
[Reuse the workflow](#reuse-the-workflow-from-another-repository) after configuring
the credentials below.

## 1. Prepare the selected runner's configuration

Select `runner: codex` (the default) or `runner: claude` in the caller workflow.
The reusable workflow uses the Codex CLI or Claude Agent SDK respectively.
Both share setup, skills, supervision, snapshots, Git and recovery.

### Codex: CODEX_CONFIG_TOML

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

### Claude: CLAUDE_SETTINGS_JSON

Set `CLAUDE_SETTINGS_JSON` to the raw JSON in the
[sample settings](../examples/claude-settings.json).

Use a model available to your account. Store its API key in `ANTHROPIC_API_KEY`.
For an Anthropic Messages-compatible gateway, replace `env.ANTHROPIC_BASE_URL`
with the gateway's base URL.
See the [native settings reference](https://code.claude.com/docs/en/settings).

### Shared MCP servers

Use the [sample MCP configuration](../examples/mcp-config.json) for either runner.
Both the optional `MCP_CONFIG_JSON` Actions secret and the repository's root
`.mcp.json` use the same `mcpServers` JSON object. Put private server credentials
in the secret. Commit `.mcp.json` to the repository to add its own servers or
replace specific servers from the selected secret.

GitHub supplies the organization secret when the repository has access to it.
A repository secret with the same name replaces the entire organization value,
including entries with distinct server names. Set an Actions **secret** for this
input. [GitHub secret precedence](https://docs.github.com/en/actions/reference/security/secrets#naming-your-secrets)

The matrix applies to both runners for shared transports. A merge keeps distinct
names and gives the complete definition to `.mcp.json` when a server name appears
in both sources. The winning entry supplies its own URL, command, headers,
arguments, and environment.

| Organization secret | Repository secret | Without `.mcp.json` | With `.mcp.json` |
| --- | --- | --- | --- |
| Set | Absent | Organization secret | Organization secret merged with file |
| Absent | Set | Repository secret | Repository secret merged with file |
| Set | Set | Repository secret | Repository secret merged with file |
| Absent | Absent | No shared servers | File only |

For Codex, the order from lowest to highest priority is `CODEX_CONFIG_TOML`,
`MCP_CONFIG_JSON`, `.mcp.json`, and the repository's `.codex/config.toml`. Codex
translates stdio entries (`command`, `args`, `env`) and Streamable HTTP entries
(`type: "http"`, `url`, `headers`). For a winning entry with an unsupported
transport such as legacy SSE, Codex warns with the server name and skips the
entry. Claude uses its native project discovery and transport support.

To migrate, put the existing `CLAUDE_MCP_CONFIG_JSON` value in the
`MCP_CONFIG_JSON` secret and replace the caller's `claude-mcp-config` mapping
with `mcp-config: ${{ secrets.MCP_CONFIG_JSON }}`.

## 2. Create REMOTE_DEV_PAT

A fine-grained personal access token is recommended for Git pushes, pull
requests and GitHub Actions operations. It is the token either agent uses through Git
and `gh`; it is separate from the workflow's automatic `GITHUB_TOKEN`.

Open [GitHub's fine-grained token form](https://github.com/settings/personal-access-tokens/new).
Name it `remote-dev`, choose an expiration, set the resource owner to
`markhuangai`, then select only `agent-remote-dev`. For another consumer,
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

## 3. Add Actions secrets

Open [this repository's Actions secrets](https://github.com/markhuangai/agent-remote-dev/settings/secrets/actions),
then create repository secrets with these exact names:

| Secret | Value |
| --- | --- |
| `CODEX_CONFIG_TOML` | The complete TOML from step 1 |
| `CODEX_API_KEY` | An API key for the model provider selected in the TOML |
| `CLAUDE_SETTINGS_JSON` | Native settings JSON when selecting Claude |
| `ANTHROPIC_API_KEY` | Claude provider API key when selecting Claude |
| `MCP_CONFIG_JSON` | Optional private MCP server JSON for either runner |
| `REMOTE_DEV_PAT` | The GitHub token from step 2 |

Organization secrets also work when this repository is included in their access
policy. Configure `REMOTE_DEV_PAT` and the selected runner's configuration and
API key. The other provider's secrets may be absent and are not passed to the agent.

With GitHub CLI, save your TOML outside the checkout and run:

```bash
gh secret set CODEX_CONFIG_TOML --repo markhuangai/agent-remote-dev < /path/to/remote-dev-config.toml
gh secret set CODEX_API_KEY --repo markhuangai/agent-remote-dev
gh secret set REMOTE_DEV_PAT --repo markhuangai/agent-remote-dev
```

The last two commands prompt for their values. Enter credentials through the
secret form or prompt, rather than putting them in a plan or committing them.

Snapshot transport and automatic recovery use the workflow's `GITHUB_TOKEN`
with `actions: write`. The PAT's Actions permission controls the agent's own GitHub
CLI operations.

## 4. Check repository configuration

The root [`.remote-dev.yml`](../.remote-dev.yml) in this repository currently
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
the optional `user-level-md-url` key in the root `.remote-dev.yml`:

```yaml
user-level-md-url: https://raw.githubusercontent.com/Z-M-Huang/golden-CLAUDE.md/refs/heads/main/CLAUDE.md
```

The runner downloads the Markdown to isolated `$CODEX_HOME/AGENTS.md` for Codex
or `$CLAUDE_CONFIG_DIR/CLAUDE.md` for Claude. The source filename is unrestricted.
Repository instructions and skills use each agent's native discovery. This
repository's `CLAUDE.md` imports `AGENTS.md` to share its instructions.
Set a different public HTTPS URL to use other shared
instructions, or omit the key to use only the repository instructions.

## 5. Start a task

Write your refined plan to `plan.md`, including the linked issue, intended change,
acceptance criteria and delivery requirements. For example, request a task
branch, required validation, commits and a push, then a pull request and the
review loop. Avoid asking the runner to merge.

In [Actions → Remote development task runner](https://github.com/markhuangai/agent-remote-dev/actions/workflows/runner-task.yml),
select **Run workflow**, choose `main`, select `runner`, and paste the plan.
The form contains `runner`, `plan` (or new context), and `resume-run-id`; leave the latter empty for a fresh
task. Alternatively:

```bash
gh workflow run runner-task.yml --repo markhuangai/agent-remote-dev --ref main -f runner=claude -F plan=@plan.md
gh run list --repo markhuangai/agent-remote-dev --workflow runner-task.yml --limit 5
gh run view RUN_ID --repo markhuangai/agent-remote-dev --log
```

The caller's YAML fixes `runs-on: '["ubuntu-latest"]'` and `timeout-minutes: 360`
under `jobs.run.with`. Repository owners change scheduling there, not in the
task form or `.remote-dev.yml`. Read the `remote-dev-result-*` artifact to confirm
what the selected agent completed.

To answer a clarification or continue saved work, run the same caller with the
previous run ID and a file containing the additional context:

```bash
gh workflow run runner-task.yml --repo markhuangai/agent-remote-dev --ref main -f runner=claude -f resume-run-id=RUN_ID -F plan=@context.md
```

## Install the remote-dev skill

Use `$remote-dev` in Codex to dispatch, inspect, resume, or cancel remote
development runs. Run this command from a consumer repository root.

```bash
npx skills add markhuangai/agent-remote-dev --skill remote-dev --agent codex --yes
```

The CLI installs the skill under `.agents/skills/remote-dev/`. Codex discovers
the [checked-in skill](../.agents/skills/remote-dev/SKILL.md) automatically in
this repository.

## Reuse the workflow from another repository

The caller below uses `@v1` to follow stable v1 releases. Use `@latest` to
follow the highest stable version across major versions, or an exact release
such as `@v1.0.0` to pin the workflow.

Commit `.remote-dev.yml` in the consumer repository root:

```yaml
allowed-actors: [YOUR_GITHUB_LOGIN]
skills: []
user-level-md-url: https://raw.githubusercontent.com/Z-M-Huang/golden-CLAUDE.md/refs/heads/main/CLAUDE.md
auto-continue: false
max-continuations: 3
```

Create one caller workflow, for example `.github/workflows/codex.yml`:

```yaml
name: Remote development
on:
  workflow_dispatch:
    inputs:
      runner:
        description: Agent runner
        type: choice
        options: [codex, claude]
        default: codex
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
    uses: markhuangai/agent-remote-dev/.github/workflows/remote-dev.yml@v1
    with:
      runner: ${{ inputs.runner }}
      plan: ${{ inputs.plan }}
      resume-run-id: ${{ inputs.resume-run-id }}
      runs-on: '["ubuntu-latest"]'
      timeout-minutes: 360
    secrets:
      codex-config: ${{ secrets.CODEX_CONFIG_TOML }}
      codex-api-key: ${{ secrets.CODEX_API_KEY }}
      claude-settings: ${{ secrets.CLAUDE_SETTINGS_JSON }}
      claude-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
      mcp-config: ${{ secrets.MCP_CONFIG_JSON }}
      github-token: ${{ secrets.REMOTE_DEV_PAT }}
```

Invoke the caller workflow from the repository's default branch. Consumers choose
its filename and configure `runs-on` and `timeout-minutes` once under the reusable
call's `with:` block. The reusable workflow keeps those optional scheduling inputs
(defaulting to `ubuntu-latest` and 360 minutes) solely for its execution job.
The task inputs are `runner`, `plan`, and `resume-run-id`. `runner` selects the
agent while `runs-on` selects the machine. Automatic recovery forwards the
recorded runner with plan/resume; current caller YAML supplies scheduling again.
Consumer dispatch workflows must accept and forward `runner` for recovery.
Use one executing remote development call per caller workflow run; mutually exclusive
declared calls are supported. GitHub enforces job timeout and runner limits.

Configure the selected runner's Actions secrets using the steps above, with your consumer
repository as the target.

Both initiating and triggering actors must be allowlisted in the latest reviewed
`.remote-dev.yml` on the default branch and have repository write/maintain/admin
access. Authorization is checked again after acquiring the session lock. Automatic
children recheck their initiating operator's current access. This policy is
independent of the repository's AI-review trust policy.

Optional YAML keys are `git-author: {name: ..., email: ...}` and
`user-level-md-url: https://...`. Instruction downloads require public HTTPS,
strict encoding and redirects, a 20-second timeout, and a 64 KiB limit. Skills
accept repository URLs or `{repository, ref, names}` objects. Omitted `ref` uses
the current default branch; omitted `names` installs every discovered skill.
Settings, selected skill revisions, instructions and secret configuration are
resolved anew on each run. Repository skills and `AGENTS.md` use native discovery.

The runner's native instructions ask either agent to include this trailer exactly once
in each Git commit, including resumed conversations and runs without downloaded
user instructions:

```text
Assisted-by: remote-agent-dev <https://github.com/markhuangai/agent-remote-dev>
```

This is project attribution in the commit message. Git author identity and token
authentication are configured separately.

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
Claude uses the SDK permission bypass and native tool/prompt presets. Each agent receives the refined plan, may follow its selected skills, and can report
an indispensable clarification as its ordinary response. A successful run means
native execution returned normally; inspect the response for task completion.

## Resume and cancellation

### Migration from remote-codex

Finish existing sessions before upgrading. Rename `.remote-codex.yml` to
`.remote-dev.yml`, rename `user-level-agents.md-url` to `user-level-md-url`, update
the reusable workflow reference to `remote-dev.yml`, and
[install the renamed dispatch skill](#install-the-remote-dev-skill).
Old names have no aliases. Add and forward the `runner` dispatch input.
Schema-4 checkpoints are unsupported by this release.
Select the original runner on manual resume; a runner or pinned-version mismatch
stops restoration. Automatic continuation preserves the recorded runner.

```bash
gh workflow run codex.yml --repo OWNER/REPO --ref main -F plan=@plan.md
gh run view RUN_ID --repo OWNER/REPO --log
gh run download RUN_ID --repo OWNER/REPO --pattern 'remote-dev-result-*' --dir RESULT_DIRECTORY
gh workflow run codex.yml --repo OWNER/REPO --ref main -f resume-run-id=RUN_ID -F plan=@clarification.md
gh run cancel RUN_ID --repo OWNER/REPO
```

Substitute your default branch and caller filename. The optional
[remote-dev skill](#install-the-remote-dev-skill) guides agents using GitHub CLI
or GitHub MCP. An uncertain dispatch response requires inspection of existing
runs before another submission.

A fresh run requires a plan. Resume selects the newest completed snapshot from
the requested run's latest attempt and uses its explicit native session ID.
Additional plan text becomes a new user turn; the original plan is already in
the conversation. Current YAML settings and fresh secrets apply on every run.
The saved published source commit is restored without merging newer main or
rewriting an existing local branch. When its local branch has moved, restoration
uses detached HEAD so the agent can decide how to continue safely.

Schema-5 artifacts record the runner and pinned version. Codex preserves native
conversation JSONL and supported SQLite state, including goals, queues and memories.
Claude preserves transcripts, subagent transcripts, tool results, MCP task state,
task lists and native memory. Its stable project key follows the root task across
homes and workspaces. Managed writers pause briefly for a file
copy; validation and upload run after writers resume. Snapshots begin when session
state becomes available, repeat every 60 seconds, and save once more after normal
exit, including native errors and clarification responses. Only the last two
completed snapshots of each run attempt remain; older snapshots are deleted only
after a replacement upload succeeds. Existing log/evidence artifacts are retained.

Uncommitted files and unpushed commits are excluded. A dirty checkout or rejected
push still permits conversation export: the artifact records the nearest
published ancestor and an omitted-work warning. Resume tells the agent that omitted
work may need recreating. The platform never stages, commits or pushes on its
own. Repository/user native hooks can publish coherent progress under their own
policy and run with the same privileges as the agent.

Snapshots exclude authentication files, secret configuration, logs, caches and
working files. Archive validation rejects traversal, links, duplicate/encrypted
entries, unexpected files, hash mismatches and expansion beyond 256 MiB. SQLite
integrity, credential exclusion, native version and session references are
verified. Expired artifacts, unrelated producers, unsupported native versions and
legacy checkpoint formats stop restoration with diagnostics.

Enable `auto-continue: true` to recover after GitHub times out the Agent execution
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

## Deliver an audited implementation through a PR

Install `sdlc-plan-implementation`, `plan-audit` and `pr-review-loop` from
[`agent-remote-dev-skills` at the pinned revision](https://github.com/markhuangai/agent-remote-dev-skills/tree/224a5be4ddf40c6cf0a50b97885cb353e8522e2e).
This repository's project configuration already installs these packages. The same
packages work with either selected runner. Begin the task prompt with:

```text
Use $sdlc-plan-implementation to implement the following approved plan through
an audited, tested, non-draft PR and complete the configured PR review loop.
Do not merge. Approved plan:
<complete plan text>
```

The skill performs read-only preflight, branches, implements, obtains an
independent conformance audit, runs required checks, commits and pushes normally,
opens the PR, and completes current-head review/CI before handoff. Delivery
authority comes from the user's request. The platform itself does not enforce
this task-specific workflow on unrelated tasks.

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
allowlisted command names such as `cat`, `git` and `npm`, and changed file paths
with add/update/delete status. Unrecognized commands appear as `shell`; argument
values and command bodies are omitted. MCP calls, agent delegation and web activity
include their tool/action names;
failed or declined tools produce WARN records with available exit codes. Records
include session, item and run identity. Strings use the existing 512-character
limit; file-change lists keep up to 100 paths and report the omitted count.
Tool output, patch bodies, MCP arguments/results, assistant messages and reasoning
are not printed. Use the saved conversation for the full interaction history.
Preserve Actions logs, snapshot/result artifacts and CodeQL evidence.
