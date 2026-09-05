# Upstream fork maintenance

This repository is a **true GitHub fork** of
[imsai-sh/open-dynamic-workflows](https://github.com/imsai-sh/open-dynamic-workflows).
Keep `fork: true` and that parent. Do not convert it to a standalone repo.

Factory-owned behavior lives on `main` as first-class commits. Upstream moves in
through `chore: sync upstream` pull requests. Never force-push `main` unless it
is still identical to upstream and the only path is a reviewable PR.

This fork has **no runtime patch ids**. Divergence is ordinary git history on
`main` (executors, routing policy, resilience). There is nothing like
zcode-cli's minified `runtimePatchPlan` to preserve.

## Remotes

| Remote | URL | Role |
| --- | --- | --- |
| `origin` | https://github.com/atebites-hub/open-dynamic-workflows.git | This fork (push / PRs) |
| `upstream` | https://github.com/imsai-sh/open-dynamic-workflows.git | Parent (fetch only) |

```bash
git remote add origin https://github.com/atebites-hub/open-dynamic-workflows.git   # if missing
git remote add upstream https://github.com/imsai-sh/open-dynamic-workflows.git    # if missing
git remote -v
# origin    https://github.com/atebites-hub/open-dynamic-workflows.git (fetch/push)
# upstream  https://github.com/imsai-sh/open-dynamic-workflows.git (fetch)
```

Do not `git push` to `upstream`.

## Last synced upstream tip

- **Upstream:** https://github.com/imsai-sh/open-dynamic-workflows
- **Parent:** [imsai-sh/open-dynamic-workflows](https://github.com/imsai-sh/open-dynamic-workflows)
- **Last synced upstream tip:** <!-- upstream-tip-begin -->`f6a6be3b50134d66dda281910643d92c4c6d8caa` (`f6a6be3`, `docs: make Chinese the default README`)<!-- upstream-tip-end -->

That SHA is the current merge-base of `origin/main` and `upstream/main` (they
match: this fork is **ahead**, not behind). The weekday sync workflow rewrites
only the `upstream-tip-begin/end` span when it opens a clean sync PR.

## Owners

- **Jaskarn** (atebites-hub)
- **Factory Plugins bot**

## Divergence (commits we own)

These are atebites-only on `origin/main` and not in
`imsai-sh/open-dynamic-workflows`. Inventory via
`gh api repos/atebites-hub/open-dynamic-workflows/compare/imsai-sh:main...atebites-hub:main`
(2026-09-05: **ahead 23 / behind 0**). Do not drop them in an upstream merge
without recording the deferral here.

| Behavior | Why we keep it | Commits |
| --- | --- | --- |
| Failure / cancellation visibility | Surface failed and cancelled workflow state; keep queue + journal consistent | `9c990f3`, `4da0645`, `aa59579` |
| Worktree isolation fail-closed | Stop instead of continuing after isolation errors | `b3a2839` |
| Portable npm lockfile | Refresh lock so CI installs cleanly | `115abf8` |
| zcode first-class executor | Host plugin + invariant #12 (`--prompt`, ODW envelope, `--mode yolo`) | `2df8c3a`, `5347ce6` (PR #6) |
| Executor resilience | Shared JSON extract, run-ok vs swallowed agent failures, transient retry | `ea3c2f8` (PR #1) |
| Codex reasoning isolation | Default per-node overrides to medium unless the script sets effort | `c9280ed` (PR #2) |
| Codex worker secrets / traces | Keep secrets and traces off the worker surface | `78a3d21` (PR #3) |
| grok executor + `defaultExecutor` | First-class `grok -p`; host may omit `{executor}` | `b7a1a88` (PR #4) |
| cursor-agent executor | First-class Cursor CLI next to grok/claude/codex/zcode | `037a6cc` (PR #5) |
| Cursor unattended executor | `--trust` / `--approve-mcps`, no `--plugin-dir`, fingerprint Cursor's `agent` | `3181365` (PR #8) |
| Immutable `routingPolicy` | Bind one route to every model node; tests close acceptance gaps | `bb265f2`, `6230c13` (PR #7) |

Non-merge factory commits (newest first):

```
3181365 feat(cursor): make Cursor CLI a reliable unattended executor
6230c13 test: close ODW routing acceptance gaps
bb265f2 feat: enforce immutable workflow routing policy
037a6cc feat(cursor): add cursor-agent executor
b7a1a88 feat(grok): add grok executor and optional defaultExecutor
78a3d21 fix(codex): protect worker secrets and traces
c9280ed fix(codex): isolate model reasoning overrides
ea3c2f8 fix(executor): harden structured output, run-ok semantics, and transient-failure retry
2df8c3a feat(executor): add zcode as a first-class executor alongside claude/codex
b3a2839 fix(runtime): fail closed on worktree isolation errors
115abf8 fix(ci): refresh portable npm lockfile
aa59579 fix(runtime): preserve queue and journal failure state
4da0645 test: cover failed workflow result status
9c990f3 fix: expose workflow failures and cancellation state
```

Marketplace pins (atebites-plugins and the packaging repo) are **not** updated
from this repository. Nested pin bumps belong in
[atebites-hub/open-dynamic-workflows-plugin](https://github.com/atebites-hub/open-dynamic-workflows-plugin).

## Sync policy (Project Factory FORK-MAINTENANCE)

1. **Keep the GitHub fork relationship.** Parent must stay `imsai-sh/open-dynamic-workflows`.
2. **Never rewrite published `main`.** No force-push to `main`. Exception only if `main` is still byte-identical to `upstream/main` and the change still goes through a PR.
3. **Do not rebase factory commits off `main`.** Replay happens by *merging* `upstream/main` into a branch that already has factory commits.
4. **Sync through a PR titled exactly `chore: sync upstream`** into `main`. Prefer GitHub **Create a merge commit** (not squash, not rebase) so factory SHAs stay reachable and the next merge has a sane merge-base.
5. **Update this file** after each successful sync: last synced tip (the `upstream-tip` markers) and any new divergence or deferral.

### Manual sync

```bash
git fetch origin
git fetch upstream
git checkout -b chore/sync-upstream-$(git rev-parse --short upstream/main) origin/main

# Skip if we already contain upstream/main:
#   git merge-base --is-ancestor upstream/main HEAD && echo already synced

git merge --no-ff upstream/main -m "chore: merge upstream $(git rev-parse --short upstream/main)"
# Resolve conflicts using the divergence table. Keep factory commits.
# Update the Last synced upstream tip markers in this file.

git push -u origin HEAD
# Open PR title: chore: sync upstream
# Merge with a merge commit.
```

Weekday automation: `.github/workflows/sync-upstream.yml` (UTC cron `23 13 * * 1-5`,
plus `workflow_dispatch`). If an open PR already has that exact title, the
workflow leaves it alone.

`GITHUB_TOKEN` pull requests do not start other workflows. Set repository secret
`UPSTREAM_SYNC_TOKEN` (Factory Plugins bot PAT with `contents` + `pull-requests`)
so sync PRs still run CI.

### After every sync

- [ ] Factory commits above still reachable from `main` (or a deferral is recorded)
- [ ] `npm run typecheck` / `npm run smoke` as far as the harness allows
- [ ] This file’s last-synced SHA matches `upstream/main`
- [ ] Fork still `fork: true` with parent `imsai-sh/open-dynamic-workflows`
- [ ] No marketplace / plugin pin bumps in the sync PR
