#!/bin/bash
# FIXTURE: real local Git repositories; fake Claude and fault-injected Git. No network.
set -euo pipefail
suite_dir=$(cd "$(dirname "$0")/../.." && pwd)
land="$suite_dir/scripts/land.sh"
if [ ! -f "$land" ]; then
  echo 'FAIL: scripts/land.sh is missing' >&2
  exit 1
fi
mkdir -p "$suite_dir/.local"
scratch=$(mktemp -d "$suite_dir/.local/land-tests.XXXXXX")
printf 'FIXTURE evidence: %s\n' "$scratch"
export REAL_GIT
REAL_GIT=$(command -v git)
mkdir "$scratch/bin"
cat > "$scratch/bin/claude" <<'FAKE_CLAUDE'
#!/bin/bash
set -eu
[ "$1" = plugin ] && [ "$2" = test ] && [ -d "$3/tests" ]
printf '%s\n' "${3##*/}" >> "$CLAUDE_MODS_HOME/calls"
if [ "${FAKE_FAIL:-}" = "${3##*/}" ]; then
  printf '2 passed, 1 failed\n'; exit 1
fi
if [ "${FAKE_UNKNOWN:-0}" = 1 ]; then
  printf 'Finished, no test counts available\n'; exit 0
fi
mkdir -p "$3/.claude-plugin/types"
printf 'generated fixture\n' > "$3/.claude-plugin/types/fixture"
printf '3 passed, 0 failed\n'
FAKE_CLAUDE
cat > "$scratch/bin/git" <<'FAKE_GIT'
#!/bin/bash
set -eu
case " $* " in
  *' checkout --detach '*)
    if [ "${FAKE_CHECKOUT_FAIL:-0}" = 1 ]; then echo 'fixture checkout refused' >&2; exit 1; fi ;;
  *' push origin '*)
    if [ "${FAKE_PUSH_FAIL:-0}" = 1 ]; then echo 'fixture push refused' >&2; exit 1; fi ;;
esac
exec "$REAL_GIT" "$@"
FAKE_GIT
chmod +x "$scratch/bin/claude" "$scratch/bin/git"
export PATH="$scratch/bin:$PATH"
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
expect_equal() { [ "$1" = "$2" ] || fail "$3: got $1, expected $2"; }
prepare_repo() {
  export CLAUDE_MODS_HOME="$scratch/$1"
  repo="$CLAUDE_MODS_HOME/git/claude-mods"
  live="$CLAUDE_MODS_HOME/git/worktrees/claude-mods/live"
  state="$CLAUDE_MODS_HOME/.claude/state"
  receipt="$state/claude-mods-live.json"
  mkdir -p "$repo" "$(dirname "$live")" "$state"
  git init -q -b main "$repo"
  git -C "$repo" config user.name Fixture
  git -C "$repo" config user.email fixture@example.invalid
  mkdir -p "$repo/track/tests" "$repo/image-thumbs/tests" "$repo/scripts/tests"
  mkdir -p "$repo/track/.claude-plugin" "$repo/image-thumbs/.claude-plugin" "$repo/track/hooks"
  printf 'fixture\n' > "$repo/track/tests/input"
  printf 'fixture\n' > "$repo/image-thumbs/tests/input"
  printf '{}\n' > "$repo/track/.claude-plugin/plugin.json"
  printf '{}\n' > "$repo/image-thumbs/.claude-plugin/plugin.json"
  # Has tests/ but is not a mod (no .claude-plugin/plugin.json): land.sh must skip it.
  printf 'fixture\n' > "$repo/scripts/tests/input"
  git -C "$repo" add .
  # Every case carries valid identity metadata, so the identity preflight never fails an unrelated case.
  identity
  git -C "$repo" commit -qm base
  base=$(git -C "$repo" rev-parse HEAD)
  git -C "$repo" worktree add -q --detach "$live" "$base"
  git -C "$repo" checkout -qb candidate
  printf 'candidate\n' > "$repo/change"
  git -C "$repo" add change
  git -C "$repo" commit -qm candidate
  target=$(git -C "$repo" rev-parse HEAD)
  git -C "$repo" checkout -q main
  git init --bare -q "$CLAUDE_MODS_HOME/origin.git"
  git -C "$repo" remote add origin "$CLAUDE_MODS_HOME/origin.git"
  printf '{"commit":"%s","previous_commit":"%s"}\n' "$base" "$base" > "$receipt"
  before_receipt=$(cksum < "$receipt")
}
run_failure() {
  if bash "$land" "$target" > "$CLAUDE_MODS_HOME/output" 2>&1; then fail 'landing unexpectedly passed'; fi
}
expect_unchanged() {
  expect_equal "$(git -C "$repo" rev-parse HEAD)" "$base" 'main moved'
  expect_equal "$(git -C "$live" rev-parse HEAD)" "$base" 'live moved'
  expect_equal "$(cksum < "$receipt")" "$before_receipt" 'receipt changed'
  expect_equal "$(git -C "$repo" worktree list --porcelain | grep -c '^worktree ')" 2 'temporary worktree leaked'
}
# The shared generator over the fixture's tracked track/ tree (failure-intake D1); the fixture's source base is a stand-in.
identity() {
  python3 "$suite_dir/scripts/land-state.py" identity generate "$repo" track "$(printf '0%.0s' {1..40})" > /dev/null
  git -C "$repo" add track/hooks/build-identity.ts
}
commit_checks() {
  git -C "$repo" checkout -q candidate
  git -C "$repo" add .
  identity
  git -C "$repo" commit -qm 'fixture release checks'
  target=$(git -C "$repo" rev-parse HEAD)
  git -C "$repo" checkout -q main
}
# A candidate commit whose identity metadata is left as the case made it.
commit_raw() {
  git -C "$repo" add -A .
  git -C "$repo" commit -qm 'fixture identity case'
  target=$(git -C "$repo" rev-parse HEAD)
  git -C "$repo" checkout -q main
}

# GR-1 (2026-10-20): the native runner passed while real helper checks were skipped.
prepare_repo python-helper
mkdir -p "$repo/track/tests/helpers"
cat > "$repo/track/tests/helpers/test_release.py" <<'PYTHON_FAILURE'
import unittest
class ReleaseCheck(unittest.TestCase):
    def test_real_helper_failure(self):
        self.fail('fixture Python assertion must prevent landing')
PYTHON_FAILURE
commit_checks
run_failure
expect_unchanged
printf 'PASS failing Python helper prevents publication\n'

prepare_repo bun-helper
mkdir -p "$repo/track/tests/helpers"
cat > "$repo/track/tests/helpers/check_release.ts" <<'BUN_FAILURE'
import assert from 'node:assert/strict'
assert.fail('fixture Bun assertion must prevent landing')
BUN_FAILURE
commit_checks
run_failure
expect_unchanged
printf 'PASS failing Bun helper prevents publication\n'

prepare_repo release-shell
cat > "$repo/scripts/tests/land.test.sh" <<'SHELL_FAILURE'
#!/bin/bash
printf 'FAIL: fixture release self-test must prevent landing\n' >&2
exit 1
SHELL_FAILURE
commit_checks
run_failure
expect_unchanged
printf 'PASS failing shell self-test prevents publication\n'

prepare_repo release-python
cat > "$repo/scripts/tests/test_land_state.py" <<'STATE_FAILURE'
import unittest
class ReleaseCheck(unittest.TestCase):
    def test_release_state_failure(self):
        self.fail('fixture release-state assertion must prevent landing')
STATE_FAILURE
commit_checks
run_failure
expect_unchanged
printf 'PASS failing Python self-test prevents publication\n'

prepare_repo typecheck
cat > "$repo/track/package.json" <<'PACKAGE'
{"name":"fixture-checks","version":"1.0.0","private":true,"scripts":{"typecheck":"node -e \"process.exit(23)\""}}
PACKAGE
cat > "$repo/track/package-lock.json" <<'LOCK'
{"name":"fixture-checks","version":"1.0.0","lockfileVersion":3,"packages":{"":{"name":"fixture-checks","version":"1.0.0"}}}
LOCK
commit_checks
run_failure
expect_unchanged
printf 'PASS failing typecheck prevents publication\n'

prepare_repo helper-success
mkdir -p "$repo/track/tests/helpers"
cat > "$repo/track/tests/helpers/test_release.py" <<'PYTHON_SUCCESS'
import os
from pathlib import Path
import unittest
class ReleaseCheck(unittest.TestCase):
    def test_real_helper_runs(self):
        with (Path(os.environ['CLAUDE_MODS_HOME']) / 'checks').open('a') as output:
            output.write('python\n')
        self.assertEqual(Path.cwd().name, 'track')
PYTHON_SUCCESS
cat > "$repo/track/tests/helpers/check_release.ts" <<'BUN_SUCCESS'
import assert from 'node:assert/strict'
import { appendFileSync } from 'node:fs'
import { basename, join } from 'node:path'
assert.equal(basename(process.cwd()), 'track')
appendFileSync(join(process.env.CLAUDE_MODS_HOME!, 'checks'), 'bun\n')
BUN_SUCCESS
cat > "$repo/scripts/tests/land.test.sh" <<'SHELL_SUCCESS'
#!/bin/bash
set -euo pipefail
printf 'shell\n' >> "$CLAUDE_MODS_HOME/checks"
SHELL_SUCCESS
cat > "$repo/scripts/tests/test_land_state.py" <<'STATE_SUCCESS'
import os
from pathlib import Path
import unittest
class ReleaseCheck(unittest.TestCase):
    def test_release_state_runs(self):
        with (Path(os.environ['CLAUDE_MODS_HOME']) / 'checks').open('a') as output:
            output.write('state\n')
STATE_SUCCESS
commit_checks
bash "$land" "$target" > "$CLAUDE_MODS_HOME/output" 2>&1
expect_equal "$(sort "$CLAUDE_MODS_HOME/checks" | tr '\n' ' ')" 'bun python shell state ' 'helper checks skipped or repeated'
expect_equal "$(git -C "$repo" rev-parse HEAD)" "$target" 'helper success did not land'
python3 "$suite_dir/scripts/tests/verify-receipt.py" "$receipt" "$target" "$base"
printf 'PASS all helper families execute once before publication\n'

prepare_repo dirty
printf 'untracked\n' > "$repo/dirty"
run_failure
expect_unchanged
grep -q 'dirty' "$CLAUDE_MODS_HOME/output" || fail 'missing dirty explanation'
printf 'PASS dirty main\n'

prepare_repo divergent
printf 'main change\n' > "$repo/main-only"
git -C "$repo" add main-only
git -C "$repo" commit -qm main-change
main_before=$(git -C "$repo" rev-parse HEAD)
run_failure
expect_equal "$(git -C "$repo" rev-parse HEAD)" "$main_before" 'divergent main changed'
expect_equal "$(git -C "$live" rev-parse HEAD)" "$base" 'divergent live changed'
expect_equal "$(cksum < "$receipt")" "$before_receipt" 'divergent receipt changed'
grep -q 'descend' "$CLAUDE_MODS_HOME/output" || fail 'missing ancestry explanation'
printf 'PASS non-descendant\n'

prepare_repo failed-test
export FAKE_FAIL=track
run_failure
unset FAKE_FAIL
expect_unchanged
grep -q 'track.*\.log' "$CLAUDE_MODS_HOME/output" || fail 'missing failing mod/log'
printf 'PASS test failure preserves all three\n'

prepare_repo success
bash "$land" "$target" > "$CLAUDE_MODS_HOME/output" 2>&1
expect_equal "$(git -C "$repo" rev-parse HEAD)" "$target" 'main not advanced'
expect_equal "$(git -C "$live" rev-parse HEAD)" "$target" 'live not advanced'
expect_equal "$(git --git-dir="$CLAUDE_MODS_HOME/origin.git" rev-parse main)" "$target" 'remote not advanced'
python3 "$suite_dir/scripts/tests/verify-receipt.py" "$receipt" "$target" "$base"
expect_equal "$(sort "$CLAUDE_MODS_HOME/calls" | tr '\n' ' ')" 'image-thumbs track ' 'not every mod tested'
expect_equal "$(git -C "$repo" worktree list --porcelain | grep -c '^worktree ')" 2 'temporary worktree leaked'
bash "$land" --status > "$CLAUDE_MODS_HOME/status"
if grep -q DRIFT "$CLAUDE_MODS_HOME/status"; then fail 'false drift'; fi
printf 'PASS landing, counts, cleanup and status\n'

# K1 (failure-intake E-I4), FIXTURE release-gate proof: the landing path refuses a track/ tree whose identity is
# missing or does not match its own recomputation, and still lands one the shared generator produced.
prepare_repo identity-missing
git -C "$repo" checkout -q candidate
git -C "$repo" rm -q track/hooks/build-identity.ts
commit_raw
run_failure
expect_unchanged
grep -q 'identity missing' "$CLAUDE_MODS_HOME/output" || fail 'landing output does not name the missing identity'
printf 'PASS K1 missing identity prevents publication\n'

prepare_repo identity-mismatch
git -C "$repo" checkout -q candidate
printf 'drifted after generation\n' > "$repo/track/tests/input"
commit_raw
run_failure
expect_unchanged
grep -q 'identity mismatch' "$CLAUDE_MODS_HOME/output" || fail 'landing output does not name the identity mismatch'
printf 'PASS K1 mismatched identity prevents publication\n'

prepare_repo identity-valid
printf 'changed under track\n' > "$repo/track/tests/input"
commit_checks
bash "$land" "$target" > "$CLAUDE_MODS_HOME/output" 2>&1 || fail 'a valid generated identity did not land'
expect_equal "$(git -C "$live" rev-parse HEAD)" "$target" 'live not advanced with a valid identity'
printf 'PASS K1 valid generated identity lands\n'

prepare_repo locked
mkdir "$state/claude-mods-land.lock"
printf '{"pid":%s,"created_at":0,"host":"%s"}\n' "$$" "$(hostname)" > "$state/claude-mods-land.lock/owner.json"
run_failure
expect_unchanged
grep -q 'lock' "$CLAUDE_MODS_HOME/output" || fail 'missing lock explanation'
[ -f "$state/claude-mods-land.lock/owner.json" ] || fail 'stole live old lock'
printf 'PASS old live-owner lock blocks\n'

prepare_repo checkout-retry
export FAKE_CHECKOUT_FAIL=1
run_failure
unset FAKE_CHECKOUT_FAIL
expect_equal "$(git -C "$repo" rev-parse HEAD)" "$target" 'main should be advanced at partial checkout'
expect_equal "$(git -C "$live" rev-parse HEAD)" "$base" 'failed checkout changed live'
expect_equal "$(cksum < "$receipt")" "$before_receipt" 'failed checkout changed receipt'
grep -q 'phase=checkout' "$CLAUDE_MODS_HOME/output" || fail 'missing checkout phase'
bash "$land" "$target" > "$CLAUDE_MODS_HOME/retry" 2>&1
python3 "$suite_dir/scripts/tests/verify-receipt.py" "$receipt" "$target" "$base"
printf 'PASS resume after checkout failure\n'

prepare_repo push-retry
export FAKE_PUSH_FAIL=1
run_failure
unset FAKE_PUSH_FAIL
expect_equal "$(git -C "$live" rev-parse HEAD)" "$target" 'push failed before local deploy'
python3 "$suite_dir/scripts/tests/verify-receipt.py" "$receipt" "$target" "$base"
grep -q 'phase=push' "$CLAUDE_MODS_HOME/output" || fail 'missing push phase'
bash "$land" "$target" > "$CLAUDE_MODS_HOME/retry" 2>&1
python3 "$suite_dir/scripts/tests/verify-receipt.py" "$receipt" "$target" "$base"
expect_equal "$(git --git-dir="$CLAUDE_MODS_HOME/origin.git" rev-parse main)" "$target" 'retry did not push'
printf 'PASS resume after push failure retains previous_commit\n'

prepare_repo unknown-counts
export FAKE_UNKNOWN=1
run_failure
unset FAKE_UNKNOWN
expect_unchanged
printf 'PASS unknown counts fail closed\n'

prepare_repo usage
bash "$land" --help > "$CLAUDE_MODS_HOME/help"
if bash "$land" > "$CLAUDE_MODS_HOME/noargs" 2>&1; then fail 'no args should exit 2'; else expect_equal "$?" 2 'no args exit'; fi
if bash "$land" --invalid > "$CLAUDE_MODS_HOME/badargs" 2>&1; then fail 'bad args should exit 2'; else expect_equal "$?" 2 'bad args exit'; fi
expect_unchanged
printf 'PASS non-mutating usage\n'
prepare_repo pinned-push
cat > "$scratch/bin/git" <<'MOVING_MAIN'
#!/bin/bash
set -eu
if [ "${3:-}" = push ]; then
  "$REAL_GIT" -C "$2" commit --allow-empty -qm 'concurrent untested main'
fi
exec "$REAL_GIT" "$@"
MOVING_MAIN
if bash "$land" "$target" > "$CLAUDE_MODS_HOME/output" 2>&1; then result=0; else result=$?; fi
expect_equal "$(git --git-dir="$CLAUDE_MODS_HOME/origin.git" rev-parse main)" "$target" 'pushed untested concurrent main'
expect_equal "$result" 1 'concurrent main change not reported'
printf 'PASS pinned push detects concurrent main\n'
printf 'PASS 19 landing cases (FIXTURE; no real Claude or remote service)\n'
