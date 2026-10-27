#!/bin/bash
# CC-159 (2026-10-10): tested commits were repeatedly left off the live checkout.
# Tier B, human/agent caller. One explicit commit authorizes test -> local deploy -> push.
set -euo pipefail
umask 077
usage() {
  printf 'Usage: land.sh <commit-ish> | --status | --help\n'
  printf 'Tests every mod, fast-forwards main, updates live and its receipt, then pushes main.\n'
  printf 'CLAUDE_MODS_HOME overrides the layout root (default: your home directory).\n'
}
if [ "$#" -ne 1 ]; then usage >&2; exit 2; fi
case "$1" in -h|--help) usage; exit 0 ;; --status) ;; -*) usage >&2; exit 2 ;; esac
layout_root=${CLAUDE_MODS_HOME:-$HOME}
case "$layout_root" in /*) ;; *) echo 'land: layout root must be absolute' >&2; exit 2 ;; esac
repo="$layout_root/git/claude-mods"
live="$layout_root/git/worktrees/claude-mods/live"
state="$layout_root/.claude/state"
receipt="$state/claude-mods-live.json"
lock="$state/claude-mods-land.lock"
script_dir=$(cd "$(dirname "$0")" && pwd)
helper="$script_dir/land-state.py"
head_at() { git -C "$1" rev-parse --verify HEAD; }
if [ "$1" = --status ]; then
  live_head=$(head_at "$live")
  main_head=$(git -C "$repo" rev-parse --verify refs/heads/main)
  printf 'live %s\nmain %s\n' "$live_head" "$main_head"
  if [ -f "$receipt" ]; then cat "$receipt"; else printf 'receipt: absent\n'; fi
  if [ "$live_head" != "$main_head" ]; then printf 'DRIFT\n'; fi
  exit 0
fi

phase=preflight
target=unresolved
log_dir=not-created
temporary_tree=
receipt_tmp=
has_lock=false
die() { printf 'land: %s\n' "$*" >&2; exit 1; }
cleanup() {
  result=$?
  trap - EXIT
  if [ -n "$temporary_tree" ] && [ -d "$temporary_tree" ]; then
    # Only the detached worktree created by this run; tests may generate ignored types.
    if ! git -C "$repo" worktree remove --force "$temporary_tree"; then
      printf 'land: cleanup failed for temporary worktree %s\n' "$temporary_tree" >&2
      result=1
    fi
  fi
  if [ -n "$receipt_tmp" ] && [ -f "$receipt_tmp" ]; then rm -f -- "$receipt_tmp"; fi
  if [ "$has_lock" = true ]; then
    if ! python3 "$helper" unlock "$lock" "$$"; then result=1; fi
  fi
  if [ "$result" -ne 0 ]; then
    current_main=$(head_at "$repo" 2>/dev/null) || current_main=unknown
    current_live=$(head_at "$live" 2>/dev/null) || current_live=unknown
    printf 'land: phase=%s main=%s live=%s target=%s logs=%s\n' "$phase" "$current_main" "$current_live" "$target" "$log_dir" >&2
    printf 'land: no rollback was attempted; inspect these SHAs, then rerun the same commit.\n' >&2
  fi
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
mkdir -p "$state"
python3 "$helper" lock "$lock" "$$"
has_lock=true

check_clean() {
  local tree=$1 label=$2 status
  status=$(git -C "$tree" status --porcelain -uall) || die "cannot inspect $label"
  [ -z "$status" ] || die "$label is dirty; preserve or commit its changes before landing"
}
check_layout() {
  [ "$(git -C "$repo" symbolic-ref --short HEAD)" = main ] || die 'canonical checkout is not on main'
  if git -C "$live" symbolic-ref -q HEAD > /dev/null; then die 'live must be detached'; fi
  [ "$(git -C "$repo" rev-parse --path-format=absolute --git-common-dir)" = "$(git -C "$live" rev-parse --path-format=absolute --git-common-dir)" ] || die 'live belongs to another repository'
  check_clean "$repo" main
  check_clean "$live" live
}
check_layout
target=$(git -C "$repo" rev-parse --verify --end-of-options "$1^{commit}") || die 'commit cannot be resolved'
main_before=$(head_at "$repo")
live_before=$(head_at "$live")
git -C "$repo" merge-base --is-ancestor "$main_before" "$target" || die 'commit must descend from main (fast-forward only)'
git -C "$repo" remote get-url origin > /dev/null || die 'origin is not configured'
log_dir=$(mktemp -d "$state/claude-mods-land-logs.XXXXXX")
temporary_tree="$log_dir/test-tree"
git -C "$repo" worktree add --detach "$temporary_tree" "$target" > "$log_dir/worktree.log" 2>&1
mods_file="$log_dir/mods.json"
printf '{}\n' > "$mods_file"
sdk_file="$log_dir/sdk.json"
printf '{}\n' > "$sdk_file"
phase=tests
mod_count=0
has_failed=false
# Failure-intake E-I4: Track's generated build identity must match its own tree before any mod check
# runs; the receipt then maps that source fingerprint to the deployed commit. Any target tree with a track/
# directory is checked, with or without track/.claude-plugin/plugin.json.
identity_file=
if [ -d "$temporary_tree/track" ]; then
  identity_file="$log_dir/identity.json"
  printf '{}\n' > "$identity_file"
  python3 "$helper" identity check "$temporary_tree" track --record "$identity_file" > /dev/null ||
    die 'track build identity check failed; main, live and receipt were not changed'
fi

# GR-1 (2026-10-20): native fixture tests do not execute OS helpers or type checks.
# Every check uses the tested tree, a bounded child group and its own private log.
run_check() {
  local label=$1 directory=$2
  shift 2
  if (cd "$directory" && python3 "$helper" run 600 "$@") > "$log_dir/$label.log" 2>&1; then
    return 0
  fi
  printf 'land: failing check %s; log %s\n' "$label" "$log_dir/$label.log" >&2
  return 1
}
run_python_checks() {
  local label=$1 directory=$2 tests=$3
  if ! run_check "$label" "$directory" python3 -m unittest discover -s "$tests" -p 'test_*.py'; then
    return 1
  fi
  if ! grep -Eq '^Ran [1-9][0-9]* tests? in ' "$log_dir/$label.log" || ! grep -qx OK "$log_dir/$label.log"; then
    printf 'land: missing nonzero unittest success footer; log %s\n' "$log_dir/$label.log" >&2
    return 1
  fi
}
for mod in "$temporary_tree"/*; do
  # A mod has a plugin manifest; scripts/tests is land.sh's own suite, not a mod.
  [ -f "$mod/.claude-plugin/plugin.json" ] && [ -d "$mod/tests" ] || continue
  name=${mod##*/}
  mod_count=$((mod_count + 1))
  log="$log_dir/$name.log"
  # Ten minutes per mod; terminate its process group before cleaning up on timeout/cancel.
  if python3 "$helper" run 600 claude plugin test "$mod" > "$log" 2>&1; then
    :
  else
    printf 'land: failing mod %s; log %s\n' "$name" "$log" >&2
    has_failed=true
  fi
  if ! python3 "$helper" counts "$log" "$name" "$mods_file"; then
    printf 'land: non-passing or unverified counts for mod %s; log %s\n' "$name" "$log" >&2
    has_failed=true
  fi
  python_tests=("$mod"/tests/helpers/test_*.py)
  if [ -f "${python_tests[0]}" ]; then
    if ! run_python_checks "$name-python" "$mod" "$mod/tests/helpers"; then has_failed=true; fi
  fi
  for check in "$mod"/tests/helpers/check_*.ts; do
    [ -f "$check" ] || continue
    if ! run_check "$name-${check##*/}" "$mod" bun "$check"; then has_failed=true; fi
  done
  if [ -f "$mod/package.json" ]; then
    if [ -f "$mod/tsconfig.json" ]; then
      if ! run_check "$name-engine-version" "$mod" claude --version; then has_failed=true; continue; fi
      if ! run_check "$name-sdk" "$mod" python3 "$helper" sdk "${CLAUDE_MODS_SDK_ROOT:-}" "$mod" "$script_dir/sdk-types.json" "$log_dir/$name-engine-version.log" "$sdk_file" --layout-root "$layout_root"; then
        has_failed=true
        continue
      fi
    fi
    # Install only locked development dependencies; never run dependency lifecycle scripts.
    if ! run_check "$name-dependencies" "$mod" npm ci --ignore-scripts --include=dev --no-audit --no-fund; then
      has_failed=true
    elif ! run_check "$name-typecheck" "$mod" npm run --if-present typecheck; then
      has_failed=true
    fi
  fi
done
[ "$mod_count" -gt 0 ] || die 'no top-level mod test directories found'
# Fixture candidate repositories contain no release suites unless a case installs one.
# Checking the target tree therefore runs the real self-tests once, without a skip flag.
if [ -f "$temporary_tree/scripts/tests/land.test.sh" ]; then
  if ! run_check release-shell "$temporary_tree" bash scripts/tests/land.test.sh; then has_failed=true; fi
fi
release_python=("$temporary_tree"/scripts/tests/test_*.py)
if [ -f "${release_python[0]}" ]; then
  if ! run_python_checks release-python "$temporary_tree" "$temporary_tree/scripts/tests"; then has_failed=true; fi
fi
[ "$has_failed" = false ] || die 'tests did not pass; main, live and receipt were not changed'

# Repeat preflight after tests: the lock serializes land.sh, not unrelated Git commands.
phase=preflight
check_layout
[ "$(head_at "$repo")" = "$main_before" ] || die 'main moved during testing'
[ "$(head_at "$live")" = "$live_before" ] || die 'live moved during testing'
receipt_tmp=$(mktemp "$state/.claude-mods-live.XXXXXX")
python3 "$helper" receipt "$receipt" "$target" "$live_before" "$mods_file" "$log_dir" --sdk "$sdk_file" ${identity_file:+--identity "$identity_file"} > "$receipt_tmp"

# Publication is resumable, not atomic across two worktrees and a remote.
phase=merge
if [ "$main_before" != "$target" ]; then git -C "$repo" merge --ff-only "$target"; fi
phase=checkout
if [ "$live_before" != "$target" ]; then git -C "$live" checkout --detach "$target"; fi
[ "$(head_at "$repo")" = "$target" ] && [ "$(head_at "$live")" = "$target" ] || die 'a checkout moved during publication'
phase=receipt
mv -f -- "$receipt_tmp" "$receipt"
receipt_tmp=
phase=push
# Plain non-forced push. A failure retains the consistent local deploy and its receipt.
python3 "$helper" run 120 git -C "$repo" push origin "$target:refs/heads/main"
[ "$(head_at "$repo")" = "$target" ] && [ "$(head_at "$live")" = "$target" ] || die 'a checkout moved during push; only the tested SHA was pushed'
printf 'land: deployed and pushed %s; receipt %s\n' "$target" "$receipt"
