#!/usr/bin/env bash
# crucible — PreToolUse spec-first guard.
#
# Blocks edits to IMPLEMENTATION files (paths under the repo's `implGlobs`, non-test) while an ACTIVE
# crucible story is in an early phase (intake | plan | red) — i.e. before a failing spec has been
# written and proven RED. This enforces "design for failure": specs first, implementation after RED.
#
# FAIL-OPEN BY DESIGN. The hook is a strict no-op (exit 0 = allow) whenever ANY of these hold:
#   - jq is not installed
#   - not in a git repo / cannot resolve the repo root
#   - no crucible state file (no active run)
#   - state says active!=true, enforce!=true, or phase not in {intake,plan,red}
#   - the edited path is a test/spec/config path, or is not under any implGlobs prefix
# So it can NEVER block normal (non-crucible) development work.
#
# Reads the tool-call JSON on stdin. Exit codes:
#   0 — allow
#   2 — block (stderr carries the message shown to the model)

set -u

# --- read stdin ---------------------------------------------------------------
STDIN_JSON=$(cat 2>/dev/null || echo "")
[ -n "$STDIN_JSON" ] || exit 0

# --- jq required; absent => fail-open ----------------------------------------
command -v jq >/dev/null 2>&1 || exit 0

TOOL_NAME=$(printf '%s' "$STDIN_JSON" | jq -r '.tool_name // empty' 2>/dev/null)
case "$TOOL_NAME" in
  Write|Edit|MultiEdit|NotebookEdit) ;;
  *) exit 0 ;;
esac

FILE_PATH=$(printf '%s' "$STDIN_JSON" \
  | jq -r '.tool_input.file_path // .tool_input.notebook_path // empty' 2>/dev/null)
[ -n "$FILE_PATH" ] || exit 0

# --- resolve the main repo root (works from linked worktrees too) ------------
COMMON_DIR=$(git rev-parse --git-common-dir 2>/dev/null) || exit 0
[ -n "$COMMON_DIR" ] || exit 0
case "$COMMON_DIR" in
  /*) ;;                                  # already absolute
  *) COMMON_DIR="$(pwd)/$COMMON_DIR" ;;   # make absolute relative to cwd
esac
MAIN_ROOT=$(cd "$(dirname "$COMMON_DIR")" 2>/dev/null && pwd) || exit 0

# --- locate the state file (stateDir is configurable; default .crucible) -----
STATE_DIR=".crucible"
CONFIG="$MAIN_ROOT/crucible.config.json"
if [ -f "$CONFIG" ]; then
  sd=$(jq -r '.stateDir // empty' "$CONFIG" 2>/dev/null)
  [ -n "$sd" ] && STATE_DIR="$sd"
fi
STATE="$MAIN_ROOT/$STATE_DIR/state.json"

# --- no active crucible run => fail-open -------------------------------------
[ -f "$STATE" ] || exit 0

# NOTE: jq's `//` treats boolean false as "empty", so `.enforce // true` would wrongly yield true
# when enforce is explicitly false. Use explicit boolean checks instead.
ACTIVE=$(jq  -r 'if .active  == true  then "true"  else "false" end' "$STATE" 2>/dev/null)
ENFORCE=$(jq -r 'if .enforce == false then "false" else "true"  end' "$STATE" 2>/dev/null)
PHASE=$(jq   -r '.phase // ""'  "$STATE" 2>/dev/null)
STORY=$(jq   -r '.story // "?"' "$STATE" 2>/dev/null)

[ "$ACTIVE" = "true" ]   || exit 0
[ "$ENFORCE" = "false" ] && exit 0
case "$PHASE" in
  intake|plan|red) ;;     # only these phases gate implementation edits
  *) exit 0 ;;
esac

# implementation globs (repo-relative prefixes); from state, else a sensible default set
IMPL_GLOBS=$(jq -r '(.implGlobs // []) | .[]' "$STATE" 2>/dev/null)
[ -n "$IMPL_GLOBS" ] || IMPL_GLOBS=$'src/\nlib/\napp/\napps/\ninternal/\npkg/\ncmd/'

# --- classify the path -------------------------------------------------------
# Test / spec / config paths are ALWAYS allowed (writing specs first is the point).
if printf '%s' "$FILE_PATH" | grep -qE '(^|/)(spec|specs|tests|__tests__)/|\.(test|spec)\.[jt]sx?$|_spec\.rb$|_test\.rb$|_test\.go$|(^|/)test_[^/]*\.py$|_test\.py$|(^|/)jest\.([^/]*\.)?config\.js$|(^|/)vitest[^/]*\.config\.[jt]s$'; then
  exit 0
fi

# Implementation = under an implGlobs prefix (relative to the file's worktree top) and not a test
# path. Anchor to the worktree top of the file being edited so an ancestor dir literally named like a
# glob, or a docs path that merely contains the segment, does NOT misfire. Everything else is allowed.
ABS_PATH="$FILE_PATH"
case "$ABS_PATH" in /*) ;; *) ABS_PATH="$(pwd)/$ABS_PATH" ;; esac
# Resolve the file's path RELATIVE TO ITS REPO TOPLEVEL via git (symlink-safe). String-stripping the
# toplevel from a pwd-derived absolute path breaks when the two disagree on symlinks (e.g. /tmp vs
# /private/tmp on macOS, firmlinks, symlinked checkouts). Walk up to the nearest existing ancestor
# (the file — or even its subdir — may be brand new) and ask git for that dir's repo-relative prefix.
ANCESTOR=$(dirname "$ABS_PATH")
while [ ! -d "$ANCESTOR" ] && [ "$ANCESTOR" != "/" ] && [ "$ANCESTOR" != "." ]; do
  ANCESTOR=$(dirname "$ANCESTOR")
done
[ -d "$ANCESTOR" ] || exit 0
PREFIX=$(git -C "$ANCESTOR" rev-parse --show-prefix 2>/dev/null) || exit 0   # "" at root, else "sub/dir/"
REL="${PREFIX}${ABS_PATH#"$ANCESTOR"/}"

BLOCK=0
while IFS= read -r g; do
  [ -n "$g" ] || continue
  case "$REL" in "$g"*) BLOCK=1; break ;; esac
done <<EOF
$IMPL_GLOBS
EOF

if [ "$BLOCK" = 1 ]; then
  cat >&2 <<MSG
crucible spec-first gate (story ${STORY}, phase=${PHASE}): editing implementation is blocked until a
failing spec exists and RED is proven.

  Blocked path: ${FILE_PATH}

Write the failing spec/test FIRST (under spec/ , tests/ , __tests__/ , or *.test.* / *_spec.rb / etc.),
run it, and confirm it FAILS for the expected reason. The crucible pipeline advances the phase to
'green' once RED is proven, which lifts this gate. To disable enforcement for this run, set
"enforce": false in ${STATE_DIR}/state.json.
MSG
  exit 2
fi

exit 0
