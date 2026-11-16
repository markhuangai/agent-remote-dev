---
name: runner-acceptance
description: Execute one explicitly authorized Linux runner qualification scenario in markhuangai/agent-remote-dev-codex. Use only when the qualification task supplies its exact task ID, temporary branch, marker and scenario.
---

# Runner acceptance fixture

This skill owns the smoke workflow; the runtime does not implement its phases. Require the direct request to authorize the supplied temporary branch and draft PR in `markhuangai/agent-remote-dev-codex`. Never merge, force-push, change configuration/credentials, delete another resource, or touch another task. The qualification controller performs separately authorized scoped cleanup.

Read the JSON qualification context in the supplied prompt. Use only its `branch` and `marker` paths. Preserve the explicit job Git identity and authentication environment. Read the current checkout and remote before editing. For a new case, refuse an already existing remote branch, create the specified branch from the current clean checkout, write the marker JSON with `task_id`, `qualification_run_id`, `scenario`, and `phase: 1`, commit that file, push normally, and open a draft PR to `main` with body marker `qualification:<qualification_run_id>:<task_id>`. Keep that URL in the marker and publish the updated marker normally. Do not write secrets into files or output.

- `fresh`: finish after the published marker and draft PR exist.
- `cold-resume` or `deadline`: if the marker is phase 1, wait in a long-running shell command until the infrastructure interrupts this invocation. On a resumed invocation with that published marker, preserve the branch, set phase 2, commit and push normally, then finish. Do not rely on a prior terminal process surviving on a fresh runner.
- `cancellation`: after publishing the marker/PR, wait until explicitly cancelled. Do not dispatch or restart anything.
- `failed-push`: clone only this task's branch into a new directory under the job's `$TMPDIR`; commit and push a second marker change there so the remote advances. In the original checkout make a different local commit from its preceding revision, then attempt one normal push. Require a real non-fast-forward rejection. Leave the original local commit unpublished so the runtime cannot create a false checkpoint. Never force, reset, rebase or repair the rejected push. Report both local and observed remote SHAs and the safe rejection cause.

After a case finishes, return one JSON object as the ordinary final message, without a Markdown fence: `scenario`, `task_id`, `branch`, `pr_url`, and, for `failed-push`, `push_rejected: true`, `local_sha`, `remote_sha`, `cause: "non-fast-forward"`. This is this fixture's output convention, not a runner-required output schema. On a real blocker report it honestly; do not fabricate successful evidence.
