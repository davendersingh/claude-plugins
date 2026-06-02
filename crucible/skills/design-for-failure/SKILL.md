---
name: design-for-failure
description: The canonical discipline behind the Crucible plugin — spec-first RED→GREEN→review→QA→validate→PR with evidence gates and unbiased, input-isolated review. Use when running /crucible or when authoring/operating any role (manager, senior, reviewer, tester) in the design-for-failure pipeline.
---

# Design for Failure

"Design for failure" = **write the specs first, prove they FAIL, then implement to make them PASS,
validate before commit, release via PR.** Canonical TDD (RED→GREEN→REFACTOR) elevated to a team
workflow with independent review and QA.

This skill is the single source of truth for the gate rules. The `/crucible` command and the
`crucible:senior` / `crucible:reviewer` / `crucible:tester` agents all defer to it.

## The Iron Laws

1. **NO PRODUCTION CODE WITHOUT A FAILING SPEC FIRST.** A spec that is green before any
   implementation exists is a broken spec — stop and fix the spec.
2. **NO GATE PASSES WITHOUT FRESH EVIDENCE.** Run the decisive command, read its full output,
   quote the decisive line(s). Never "should pass", "seems fine", "probably green".
3. **REVIEWER AND TESTER JUDGE ARTIFACTS, NOT INTENTIONS.** They receive the diff + spec/AC only.
   They never see the implementer's reasoning. This is what makes review unbiased.
4. **IRREVERSIBLE ACTIONS ALWAYS ESCALATE TO THE HUMAN** — even in leader mode (see §Autonomy).

## The Pipeline & Gates

```
0  INTAKE   Manager: feature → branch <prefix>/<NNN-slug> + worktree → design spec + story
                     (acceptance criteria, non-goals, constraints)
            ┃ SPEC GATE   gated: human approves · leader: self-approve + record assumptions
1  PLAN     Senior: implementation plan (bite-sized tasks, exact commands, NO placeholders)
            Reviewer: reviews the PLAN vs spec → BLOCKER/nit → loop until approved
2  RED      Senior, per task: write spec/test FIRST → run it → prove it FAILS for the right reason
            ┃ RED GATE     captured failing output; ZERO production code yet
3  GREEN    Senior, per task: minimal impl → run the repo's test cmd → prove PASS → refactor
            ┃ GREEN GATE   captured passing output; commit per task
4  REVIEW   Reviewer (diff + spec ONLY): findings → Critical/Important loop to Senior → re-review
5  QA       Tester (AC + diff ONLY): test-story + adversarial tests + edge cases → bugs loop
            ┃ QA GATE      all AC checked; all bugs closed or explicitly wont-fixed (recorded)
6  VALIDATE Manager: full per-target matrix LOCALLY (test+lint+typecheck+build for touched targets)
            ┃ COMMIT GATE  fresh green evidence; CI is a weak net
7  RELEASE  Manager: open PR (gh) → watch CI → bounded auto-fix → MERGE left to human (default)
```

Evidence for every gate is recorded in the story / plan / test-story file as
`command → quoted decisive output`.

## Anti-bias input isolation (the heart)

| Role | Receives | Must NOT receive |
|------|----------|------------------|
| Manager | everything (it orchestrates) | — |
| Senior | spec + AC + approved plan + (on fix loops) the findings/bugs text | review/QA verdicts until a fix is requested |
| Reviewer | `git diff BASE..HEAD` + design spec + story AC + plan | the Senior's narrative/chat/self-assessment |
| Tester | story AC + diff + how-to-run commands | the Senior's reasoning AND the Reviewer's verdict |

Construct reviewer/tester prompts from files and `git diff` only. Reviewer and Tester run
independently of each other so two genuinely independent signals reach the Manager.

## Reviewer selection (`claude` | `codex` | `both`)

The REVIEW phase reviewer is configurable (`--reviewer` flag > config `reviewer` > default `claude`):
- **`claude`** — the `crucible:reviewer` subagent (default).
- **`codex`** — a cross-model review via `scripts/codex-review.sh` (the Codex CLI) instead of Claude.
- **`both`** — Claude **and** Codex in parallel; the Manager merges + dedups findings (union).

`both` adds a genuinely independent **second model** — the strongest anti-bias signal. The same
isolation contract holds for every reviewer: Codex receives only the diff + spec/AC, never the
implementer's reasoning, and in `both` mode neither reviewer sees the other's verdict. Blocking is on
the **union** (Critical/Important from any reviewer blocks). If Codex is missing/unauthenticated the
wrapper returns `available:false` and the pipeline **falls back** (codex→claude, both→claude-only) —
it never leaves the review with zero reviewers.

## Retry / escalation

- Review **Critical/Important** and QA **Critical/Important bugs** loop back to the Senior; re-run
  review/QA after each fix. **Minor** findings/bugs are recorded (filed to backlog), not blocking.
- **Fix-attempt budget = 3 per finding.** On exhaustion, apply systematic debugging (root cause
  before more fixes); if still failing, **escalate to the human** — "3 fixes failed, question the
  approach" — even in leader mode.

## Autonomy

- **Gated (default):** stop for human approval at the SPEC gate; surface blockers; human merges.
- **Leader (`--leader`):** proceed through gates unattended; resolve ambiguity by documenting an
  explicit assumption in the story; open the PR; **still escalate irreversible actions**.
- **Always escalate (both modes):** force-push · branch/worktree deletion with unmerged work ·
  **PR merge** · destructive data/DB migration · secret/settings changes · `git reset --hard` /
  `clean -fdx` · cancelling work · `wont-fix` on a bug · production deploy.

## Spec-first state file

The Manager maintains a state file at `<stateDir>/state.json` (default `.crucible/state.json`,
git-ignored) so the spec-first guard hook knows the active phase:

```json
{ "active": true, "enforce": true, "story": "004-slug", "branch": "feat/004-slug",
  "worktree": ".worktrees/crucible-004-slug", "phase": "red", "mode": "gated",
  "implGlobs": ["src/","lib/","app/"], "updated": "<iso8601>" }
```

`phase` ∈ `intake | plan | red | green | review | qa | validate | release | done`. The hook blocks
edits to implementation paths (those under `implGlobs`) while `phase ∈ {intake, plan, red}`. On
`done` / pipeline exit, set `active:false`.

The hook is **defense-in-depth only** — implementation edits are made by the senior subagent, and
PreToolUse hooks may not fire for subagent tool calls. The real spec-first guarantee is Iron Law 1
(the Senior's RED-first discipline) plus the Manager **independently re-running and verifying the RED
gate** before allowing GREEN. Never rely on the hook alone.

## Artifacts (configurable; sensible generic defaults)

Resolve paths from `crucible.config.json` if present, else use the defaults below. Number by reading
the highest existing `NNN` in the artifacts dir and incrementing.

| Artifact | Default path |
|----------|--------------|
| design spec | `<artifactsDir>/<NNN>-<slug>/spec.md` |
| story | `<artifactsDir>/<NNN>-<slug>/story.md` (acceptance criteria, non-goals, constraints, `<!-- status -->`) |
| plan | `<artifactsDir>/<NNN>-<slug>/plan.md` (bite-sized tasks, reviewer-comment blocks) |
| test-story | `<artifactsDir>/<NNN>-<slug>/test-story.md` (steps w/ expected results, AC checklist) |
| review findings | `<artifactsDir>/<NNN>-<slug>/review.md` (FINDING-N, severity, resolution + commit SHA) |

`artifactsDir` default `docs/crucible`. A repo with an existing methodology can map these onto its own
layout via `crucible.config.json`. **Match the repo's own conventions** (commit style, branch naming,
doc locations) — read its `CLAUDE.md` / `AGENTS.md` / rules first.

See `lib/validation-matrix.md` for how per-target validation commands are resolved.
