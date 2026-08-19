#!/usr/bin/env bash
# Offline gate for main. Must exit 0 on a clean clone with no secrets.
# Contract checks stay; once package.json exists we also typecheck and run
# node:test. Do not require live third-party networks.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

echo "== contract files =="
for f in README.md SPEC.md BUILD.md CONTRIBUTING.md scripts/test.sh; do
  [[ -f "$f" ]] || fail "missing $f"
  [[ -s "$f" ]] || fail "empty $f"
done

echo "== contributing rules are documented =="
grep -q 'main must always be buildable' CONTRIBUTING.md \
  || grep -q 'main` must always be buildable' CONTRIBUTING.md \
  || fail "CONTRIBUTING.md does not state the main-branch rule"

echo "== SPEC mentions git collaboration =="
grep -q 'Git collaboration' SPEC.md || fail "SPEC.md missing Git collaboration section"

echo "== no committed secrets =="
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  if git ls-files | grep -E '(^|/)\.env$|(^|/)id_rsa$|\.pem$|credentials\.json$' >/dev/null; then
    fail "secret-like path is tracked"
  fi
fi

echo "== markdown is UTF-8 text =="
file -b --mime-encoding README.md SPEC.md CONTRIBUTING.md | grep -qiE 'utf-8|us-ascii' \
  || fail "docs are not UTF-8/ASCII"

echo "== no live X/Twitter in unit tests =="
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  if git grep -nE 'api\.twitter\.com|api\.x\.com' -- 'src/' 'tests/' >/dev/null; then
    fail "src/ or tests/ mention live X/Twitter hosts"
  fi
fi
if [[ -f tests/thread.test.ts ]]; then
  grep -q 'SPEC 1' tests/thread.test.ts || fail "tests/thread.test.ts missing SPEC 1"
  grep -q 'missingIds' tests/thread.test.ts || fail "tests/thread.test.ts missing missingIds"
fi
if [[ -f tests/html.test.ts ]]; then
  grep -q 'SPEC 7' tests/html.test.ts || fail "tests/html.test.ts missing SPEC 7"
  grep -q 'LEGAL_FOOTER' tests/html.test.ts || fail "tests/html.test.ts missing legal footer"
  grep -q 'adsbygoogle' tests/html.test.ts || fail "tests/html.test.ts missing ads"
  if grep -qE 'api\.twitter\.com|api\.x\.com' tests/html.test.ts; then
    fail "tests/html.test.ts mentions live X/Twitter hosts"
  fi
fi

if [[ -f package.json ]]; then
  echo "== install =="
  if [[ ! -d node_modules ]]; then
    if [[ -f package-lock.json ]]; then
      npm ci
    else
      npm install
    fi
  fi

  echo "== tsc --noEmit =="
  npx tsc --noEmit

  echo "== unit tests =="
  # Quoted so bash 3.2 does not eat **; Node 22's test runner expands the glob.
  test_log="$(mktemp)"
  trap 'rm -f "$test_log"' EXIT
  set +e
  npx tsx --test --test-reporter spec 'tests/**/*.test.ts' | tee "$test_log"
  test_status=${PIPESTATUS[0]}
  set -e
  [[ $test_status -eq 0 ]] || fail "unit tests failed"
  grep -Eq 'tests[[:space:]]+[1-9][0-9]*' "$test_log" \
    || fail "test runner reported 0 tests"
fi

echo "OK: buildable and testable"
