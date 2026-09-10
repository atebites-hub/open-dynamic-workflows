# Worktree isolation

Use `agent(prompt, {isolation: "worktree"})`, or set
`runWorkflow({..., isolation: "worktree"})` to isolate every agent, including
nested calls. The run-wide requirement cannot be disabled by a node option.

Each writer gets `.odw/worktrees/<run-id>-agent-<id>` and a named branch
`odw/<run-id>/agent-<id>`. All writers share the first captured committed base;
the caller's existing staged and unstaged edits remain in the caller checkout.
Starting from a subdirectory preserves that subdirectory in the worker cwd.

The journal's agents directory contains a `.worktree.json` receipt and a `.diff`
patch per isolated agent. The patch includes tracked committed and uncommitted
changes. Untracked and ignored paths are listed in status and remain available
in the retained worktree. No automatic merge or cherry-pick is performed.

Only successful, uncancelled, pristine worktrees still at the original base are
removed, without force. Commits, dirty/untracked/ignored files, failures and
uncertain cleanup retain the worktree. Named branches protect committed output.
Failed evidence capture cannot turn a completed writer into an accepted run.
As with other node failures, a fault-tolerant script can return a value; consumers
must inspect `failedAgents` and `failedWorkflows` as well as `ok` and `durable`.

Isolated writers execute freshly rather than replaying cached text as if it had
re-created filesystem effects. Non-isolated resume behavior is unchanged.

Verification: `npm run typecheck && npm run smoke`. The two-writer regression
uses real Git worktrees and an execution barrier, but fake model executors;
shipped-plugin/model runtime acceptance remains a separate live check.
