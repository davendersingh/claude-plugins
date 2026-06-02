# Crucible — Design-for-Failure Feature Plugin

One Claude Code session orchestrates an **isolated-context subagent team** through a **spec-first
(RED→GREEN) pipeline** to a reviewed, tested, PR'd feature — with a **leader-mode** toggle for bounded
autonomy. Repo-agnostic: it discovers your test/lint/typecheck/build commands and follows your repo's
own conventions.

> **Design for failure** = write the specs **first**, prove they **FAIL** (RED), implement only then to
> make them **PASS** (GREEN), validate before commit, release via PR. Canonical TDD elevated to a team
> workflow with independent review and QA.

## Install

```bash
/plugin marketplace add davendersingh/claude-plugins
/plugin install crucible
# restart the session so the plugin loads
```

## Use

```bash
/crucible "Add password-reset rate limiting"            # gated single feature → opens PR, you merge
/crucible --leader "Add password-reset rate limiting"   # bounded autonomy to PR
/crucible --linear ENG-123 "…"                          # link to an existing Linear issue
/crucible --deep-review "…"                             # adversarial review panel (majority refute-vote)
/crucible --sprint path/to/manifest.json                # batch over a dependency DAG
```

Flags: `--leader` · `--sprint <manifest>` · `--linear <ID>` · `--linear-create` · `--deep-review` ·
`--no-worktree` · `--no-enforce` · `--auto-merge` · `--branch-prefix <p>`.

## The team & the anti-bias mechanic

| Role | Runs as | Sees | Never sees |
|------|---------|------|------------|
| **Manager** | the launching session | everything; decides gates **from evidence**; opens PR | — |
| **Senior** | `crucible:senior` subagent (own worktree) | spec + plan; writes failing specs, implements, commits | review/QA verdicts until a fix is requested |
| **Reviewer** | `crucible:reviewer` subagent (fresh) | **diff + spec/AC + plan only** | the Senior's narrative/reasoning |
| **Tester** | `crucible:tester` subagent (fresh) | **AC + diff only** | the Senior's reasoning AND the Reviewer's verdict |

The invariant that makes review unbiased: reviewer & tester get **artifacts, not intentions** — fresh
context, no inheritance of the implementer's rationalizations.

## The pipeline (each gate needs fresh command output)

```
0 INTAKE   → branch <prefix>/<NNN-slug> + worktree → design spec + story(AC)   ┃ SPEC GATE
1 PLAN     → Senior writes plan → Reviewer reviews the PLAN → loop to approved
2 RED      → failing specs FIRST, prove they fail, zero prod code              ┃ RED verified
3 GREEN    → minimal impl → prove pass → refactor → commit per task            ┃ GREEN verified
4 REVIEW   → Reviewer (diff+spec only) → fix loop on Critical/Important
5 QA       → Tester (AC+diff only) → adversarial tests, bugs → bug loop        ┃ QA GATE
6 VALIDATE → full per-target matrix LOCALLY (test+lint+typecheck+build)        ┃ COMMIT GATE
7 RELEASE  → open PR (gh) → watch CI/auto-fix → MERGE left to the human
```

## Modes

- **Autonomy** — *gated* (default): pauses at the spec gate, you merge. *leader* (`--leader`): drives
  to a PR unattended but **always escalates irreversible actions** (force-push, merge, destructive
  migration, deleting work, secrets, production deploy…).
- **Scope** — single feature (default), or `--sprint <manifest>`: writes all specs upfront, blesses the
  batch once with you, then runs items autonomously across the dependency DAG with stacked PRs.
- **Linear** — off by default; `--linear <ID>` links an existing issue, `--linear-create` creates one
  (requires the Linear MCP).
- **Reviewer (cross-model)** — `reviewer: claude | codex | both` (config or `--reviewer`). `claude` is
  the default; `codex` swaps in a cross-model review via the [Codex CLI](https://github.com/openai/codex);
  `both` runs Claude **and** Codex independently and merges findings — a second model's eyes, the
  strongest anti-bias signal. Codex sees only the diff + spec/AC (same isolation). If the Codex CLI is
  missing/unauthenticated it falls back to Claude automatically.

```bash
/crucible --reviewer codex "Add password-reset rate limiting"   # Codex reviews instead of Claude
/crucible --reviewer both  "Add password-reset rate limiting"   # Claude + Codex, merged
```

- **Browser QA (opt-in)** — a `browser` config block adds an **additional** browser pass to QA for UI
  features (on top of the normal suite). `runner: playwright|cypress|custom` runs your E2E suite;
  `runner: mcp` drives a **live browser via the Playwright MCP** for repos with no E2E runner. Each UI
  acceptance criterion is checked against the rendered page (screenshots into the test-story); failures
  block. Auto-applies when the story touches `uiGlobs`; `--browser`/`--no-browser` override. Skips
  gracefully (with a reason) if the browser tooling/app is unavailable. See
  [`lib/browser-testing.md`](./lib/browser-testing.md).

## Configuration (optional)

Crucible works with **zero config** — it auto-detects validation commands from your manifests
(`package.json`, `Gemfile`/`.rspec`, `pyproject.toml`, `go.mod`, `Cargo.toml`, …) and writes artifacts
under `docs/crucible/`. To pin exact commands, paths, or source globs, add a `crucible.config.json` at
your repo root:

```jsonc
{
  "branchPrefix": "feat",
  "prTarget": "main",
  "reviewer": "claude",                     // "claude" | "codex" | "both"  (--reviewer overrides)
  "codexModel": "",                          // optional model for the Codex reviewer (blank = default)
  "stateDir": ".crucible",                 // git-ignore this
  "artifactsDir": "docs/crucible",
  "implGlobs": ["src/", "lib/", "app/"],    // what the spec-first hook treats as "implementation"
  "browser": {                              // optional: opt-in browser pass in QA (see lib/browser-testing.md)
    "enabled": true, "runner": "mcp",       // "playwright" | "cypress" | "custom" | "mcp"
    "startCommand": "npm run dev", "url": "http://localhost:3000",
    "appliesWhen": "ui", "uiGlobs": ["app/", "components/"]
  },
  "validation": {
    "web": { "dir": "apps/web", "testAll": "npm test", "lint": "npm run lint",
             "typecheck": "tsc --noEmit", "build": "npm run build",
             "testOne": "npm test -- {file}" }
  }
}
```

See `lib/validation-matrix.md` for resolution rules and the marketplace `examples/` for a full config.
**Add `.crucible/` (or your `stateDir`) to `.gitignore`.**

## The spec-first guard hook (defense-in-depth)

A `PreToolUse` hook blocks edits to implementation files (paths under `implGlobs`) while an active
Crucible story is in phase `intake|plan|red` — before a failing spec is proven RED. It is
**fail-open**: a strict no-op whenever there is no active run, `jq` is missing, or the path is a
test/spec/artifact path — so it can never block normal development. Disable for a run with
`--no-enforce`.

> **It's a backstop, not the primary enforcement.** Implementation edits are made by the *senior
> subagent*, and PreToolUse hooks are not guaranteed to fire for subagent tool calls. The real
> spec-first guarantee comes from the Senior's RED-first discipline plus the Manager independently
> re-running and verifying the RED gate before allowing GREEN.

## Requirements

- Claude Code with subagent (`Agent`) support; the `Workflow` tool for `--sprint` / `--deep-review`.
- `git` + `gh` (GitHub CLI) for branch/PR operations.
- `jq` for the spec-first hook (without it the hook is a no-op).
- Optional: the Linear MCP for `--linear*`.

## Files

| Path | Role |
|------|------|
| `commands/crucible.md` | `/crucible` entry + the Manager's orchestration contract (primary engine) |
| `agents/{senior,reviewer,tester}.md` | isolated role subagents + anti-bias contracts |
| `skills/design-for-failure/SKILL.md` | the canonical gate discipline (DRY source of truth) |
| `lib/validation-matrix.md` | how per-target validation commands are resolved |
| `workflows/crucible-pipeline.js` | accelerator: sprint DAG fan-out + adversarial deep-review panel |
| `hooks/hooks.json` + `scripts/hooks/crucible-spec-first-guard.sh` | PreToolUse spec-first guard |

## License

MIT — see the repository `LICENSE`.
