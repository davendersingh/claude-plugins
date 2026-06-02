#!/usr/bin/env bash
# crucible — Codex reviewer wrapper.
#
# Runs an INDEPENDENT, cross-model code review via the Codex CLI and emits findings normalized to
# crucible's finding shape. Used by /crucible when `reviewer` is "codex" or "both".
#
# Anti-bias contract: Codex receives ONLY the diff + the spec/acceptance-criteria text. It never sees
# the implementer's reasoning or the Claude reviewer's verdict — same isolation as crucible:reviewer.
#
# GRACEFUL: if the Codex CLI is missing or unauthenticated, it writes an "available:false" sentinel and
# exits 0, so the pipeline simply falls back (codex→claude, both→claude-only) instead of failing.
#
# Usage:
#   codex-review.sh --base <branch|sha> --worktree <dir> --spec <file> --ac <file> --out <file> [--model <m>]
#
# Output (JSON written to --out):
#   { "available": true,  "source": "codex", "verdict": "...", "findings": [ ... ] }
#   { "available": false, "source": "codex", "reason": "<why it was skipped>" }
#
# Env:
#   CRUCIBLE_CODEX_DRYRUN=1  → assemble everything and write the would-run command to --out; do NOT
#                              call Codex (for headless testing).

set -u

BASE=""; WORKTREE="."; SPEC=""; AC=""; OUT=""; MODEL=""
while [ $# -gt 0 ]; do
  case "$1" in
    --base) BASE="$2"; shift 2 ;;
    --worktree) WORKTREE="$2"; shift 2 ;;
    --spec) SPEC="$2"; shift 2 ;;
    --ac) AC="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --model) MODEL="$2"; shift 2 ;;
    *) echo "codex-review: unknown arg: $1" >&2; exit 64 ;;
  esac
done

[ -n "$OUT" ] || { echo "codex-review: --out is required" >&2; exit 64; }
emit(){ printf '%s\n' "$1" > "$OUT"; }                 # write JSON to --out
skip(){ emit "{\"available\":false,\"source\":\"codex\",\"reason\":\"$1\"}"; exit 0; }

# --- availability checks (fail-soft) -----------------------------------------
command -v codex >/dev/null 2>&1 || skip "codex CLI not on PATH"
if [ -z "${OPENAI_API_KEY:-}" ] && [ ! -f "${CODEX_HOME:-$HOME/.codex}/auth.json" ]; then
  skip "codex not authenticated (no OPENAI_API_KEY and no ~/.codex/auth.json)"
fi
[ -n "$BASE" ] || skip "no --base provided"

SCHEMA="$(cd "$(dirname "$0")/../lib" 2>/dev/null && pwd)/findings.schema.json"
[ -f "$SCHEMA" ] || skip "findings.schema.json not found next to the wrapper"

# --- gather the artifacts the reviewer is allowed to see (diff + spec/AC only) -
DIFF=$(git -C "$WORKTREE" diff "$BASE"...HEAD 2>/dev/null) || skip "could not compute git diff against $BASE"
[ -n "$DIFF" ] && DIFF=$(printf '%s' "$DIFF" | head -c 600000)   # guard pathological sizes
SPEC_TXT=""; [ -n "$SPEC" ] && [ -f "$SPEC" ] && SPEC_TXT=$(cat "$SPEC")
AC_TXT="";   [ -n "$AC" ]   && [ -f "$AC" ]   && AC_TXT=$(cat "$AC")

PROMPT="You are an INDEPENDENT code reviewer. You have NOT seen how this change was built and must not
assume — judge the artifact (the diff) strictly against the spec / acceptance criteria below. The diff
is provided in the appended <stdin> block (git diff ${BASE}...HEAD).

Report only genuine issues with confidence >= 50: real bugs (logic, null/undefined, races, missing
error handling, silent failures, security — authz gaps, injection, secret exposure, unsafe redirects,
path traversal), spec/AC violations, and violations of conventions evident in the diff. Map each
acceptance criterion to evidence. Do not pad; if it meets the spec with no Critical/Important issues,
return verdict APPROVED with an empty findings array.

Return ONLY JSON conforming to the provided output schema (verdict + findings[]).

=== DESIGN SPEC ===
${SPEC_TXT:-(none provided)}

=== ACCEPTANCE CRITERIA ===
${AC_TXT:-(none provided)}"

RAW=$(mktemp "${TMPDIR:-/tmp}/crucible-codex-XXXX.json")

if [ "${CRUCIBLE_CODEX_DRYRUN:-}" = "1" ]; then
  emit "{\"available\":true,\"source\":\"codex\",\"dryrun\":true,\"base\":\"$BASE\",\"worktree\":\"$WORKTREE\",\"schema\":\"$SCHEMA\",\"model\":\"${MODEL:-default}\",\"diffBytes\":${#DIFF},\"promptBytes\":${#PROMPT}}"
  rm -f "$RAW"; exit 0
fi

# --- run Codex headless: read-only sandbox, no approvals, structured output ---
# (generic `codex exec` is used rather than `codex exec review` because only `exec` supports
#  --output-schema / -o, which we need for structured, parseable findings.)
set +e
printf '%s' "$DIFF" | codex exec \
  -C "$WORKTREE" \
  -s read-only \
  -c approval_policy="never" \
  --output-schema "$SCHEMA" \
  -o "$RAW" \
  --skip-git-repo-check \
  --ephemeral \
  ${MODEL:+-m "$MODEL"} \
  "$PROMPT" >/dev/null 2>"$RAW.err"
rc=$?
set -e 2>/dev/null || true

if [ $rc -ne 0 ]; then
  reason=$(head -c 300 "$RAW.err" 2>/dev/null | tr '\n' ' ' | sed 's/"/\\"/g')
  emit "{\"available\":false,\"source\":\"codex\",\"reason\":\"codex exec exited $rc: ${reason}\"}"
  rm -f "$RAW" "$RAW.err"; exit 0
fi

# Normalize: the final message ($RAW) should be JSON matching the schema. Validate + wrap.
if command -v jq >/dev/null 2>&1 && jq -e '.findings' "$RAW" >/dev/null 2>&1; then
  jq -c '{available:true, source:"codex", verdict:(.verdict // "CHANGES_REQUESTED"), findings:(.findings // [])}' "$RAW" > "$OUT"
else
  # Couldn't parse structured output — surface raw so the Manager can decide, don't crash.
  raw=$(head -c 4000 "$RAW" 2>/dev/null | sed 's/"/\\"/g' | tr '\n' ' ')
  emit "{\"available\":true,\"source\":\"codex\",\"verdict\":\"CHANGES_REQUESTED\",\"findings\":[],\"unparsed\":\"${raw}\"}"
fi
rm -f "$RAW" "$RAW.err"
exit 0
