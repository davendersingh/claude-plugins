# Cross-model review (`reviewer: claude | codex | both`)

Status: implemented 2026-06-02.

## Why

Crucible's thesis is *unbiased* review — judging artifacts, not intentions. A single model still has a
single model's blind spots. Letting a **different model** (Codex) review the same diff against the same
spec adds a genuinely independent set of eyes. `both` mode runs Claude and Codex in parallel and merges
their findings.

## Configuration

Resolution order: `--reviewer` flag → `crucible.config.json` `"reviewer"` → default `"claude"`.

| value | REVIEW-phase reviewer(s) |
|-------|--------------------------|
| `claude` *(default)* | the `crucible:reviewer` subagent |
| `codex` | the Codex CLI (via `scripts/codex-review.sh`) instead of Claude |
| `both` | `crucible:reviewer` **and** Codex, in parallel → findings merged + deduped (union) |

```jsonc
// crucible.config.json
{ "reviewer": "both", "codexModel": "" }   // codexModel blank = Codex's default model
```
```bash
/crucible --reviewer codex "…"
/crucible --reviewer both  "…"
```

## How Codex is invoked

`scripts/codex-review.sh` runs the **generic** `codex exec` (not `codex exec review`, which lacks
`--output-schema`) so Codex returns **structured** findings:

```
git -C <worktree> diff <BASE>...HEAD \
  | codex exec -C <worktree> -s read-only -c approval_policy="never" \
      --output-schema lib/findings.schema.json -o <tmp> --skip-git-repo-check --ephemeral [-m <model>] \
      "<independent-reviewer instructions + spec + acceptance criteria>"
```

- **read-only sandbox + no approvals** → headless, non-interactive, cannot modify the repo.
- The diff is piped on stdin; the spec + AC are in the prompt.
- `--output-schema lib/findings.schema.json` constrains the final message to
  `{verdict, findings:[{severity, confidence, location, what, why, fix}]}`, which the wrapper
  normalizes to `{available:true, source:"codex", verdict, findings}`.

## Invariants

- **Anti-bias:** Codex receives **only** the diff + the spec/AC text — never the Senior's narrative,
  and in `both` mode never the Claude reviewer's verdict (and vice-versa).
- **Gate:** Critical/Important findings from **any** active reviewer block → loop to the Senior. Minor
  recorded. Same as single-reviewer.
- **Graceful fallback:** if the Codex CLI is missing or unauthenticated (no `OPENAI_API_KEY` and no
  `~/.codex/auth.json`), or the run errors, the wrapper writes `{"available":false,...}` and exits 0.
  The Manager then falls back: `codex` → `claude`, `both` → `claude`-only (with a note). The pipeline
  is never left with zero reviewers.

## Requirements

- The [Codex CLI](https://github.com/openai/codex) on `PATH`, authenticated (ChatGPT login → `~/.codex/auth.json`, or `OPENAI_API_KEY`).
- `jq` (to normalize structured output; without it the wrapper surfaces the raw output instead).

## Testing

- Headless: `CRUCIBLE_CODEX_DRYRUN=1 scripts/codex-review.sh --base main --worktree . --spec S --ac A --out o.json`
  assembles the diff/prompt/command and writes a dry-run summary **without** calling Codex.
- Fallback: with `codex` off `PATH`, the wrapper writes `available:false` and exits 0.
- Live: run `/crucible --reviewer codex "<small change>"` and confirm Codex findings appear in
  `<artifactsDir>/<NNN>-<slug>/review.md`.

## Future

`--deep-review` currently runs a Claude-only skeptic panel; adding a Codex skeptic is a small follow-up
(the wrapper already emits the panel-compatible finding shape). A generic external-reviewer hook
(e.g. Gemini) can reuse the same wrapper pattern.
