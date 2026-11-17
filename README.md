# agent-remote-dev-codex

Run native Codex on a Linux GitHub Actions runner to implement a refined plan.
Repositories call a reusable workflow, keep project settings in
`.remote-codex.yml`, and provide credentials through Actions secrets.

Codex and optional skills handle implementation, branches, commits, tests,
reviews and pull requests. The workflow provides the runner, isolated setup,
conversation snapshots and cross-run resume.

Follow the [setup guide](docs/setup.md) for configuration examples, credentials
and instructions for running a task in this repository or another repository.

## How it works

1. An authorized user supplies a plan through the repository's caller workflow.
2. The workflow reads the current default-branch configuration and starts Codex
   on the selected GitHub-hosted or self-hosted Linux runner.
3. Codex works in the repository using the plan, repository instructions and any
   selected skills. Delivery requirements belong in those instructions or skills.
4. The workflow saves native conversation state when it becomes available,
   every 60 seconds, and once more on ordinary exit.
5. A later run can resume the saved conversation with additional context.

Codex runs noninteractively with full access. It can report an indispensable
clarification in its response; supply the answer when resuming the conversation.
A successful workflow run means Codex returned normally. Read its result to
determine whether the task is complete.

## Resume and continuation

Resume restores the conversation and its recorded published source revision,
then applies current configuration and fresh credentials. It does not merge
newer default-branch changes.

Snapshots keep the last two completed copies of native session state.
Credentials, logs, caches and working files are excluded. Uncommitted files
and unpushed commits must be recreated if the runner is lost. Recovery depends
on the latest successful upload, so a 60-second interval does not guarantee
only 60 seconds of lost progress.

Automatic continuation is optional and disabled by default. When enabled,
a separate job can resume after the Codex execution times out, up to the
configured limit. The default limit is three automatic continuations; manual
resume starts a new allowance.

## Workflow interface

The normal task form has two fields: `plan` (or new context) and an optional
`resume-run-id`. Repository owners configure Linux runner labels and job timeout
in the caller's YAML. This repository uses `ubuntu-latest` and 360 minutes.

The [setup guide](docs/setup.md) covers the caller workflow, optional skills,
resuming, cancellation and runtime diagnostics. Repository development, checks
and release operations are documented in the [maintenance guide](docs/maintenance.md).
