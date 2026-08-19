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
for f in README.md SPEC.md BUILD.md CONTRIBUTING.md scripts/test.sh llms.txt; do
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
if [[ -f tests/timeline.test.ts ]]; then
  grep -q 'SPEC 4' tests/timeline.test.ts || fail "tests/timeline.test.ts missing SPEC 4"
  grep -q 'protected_user' tests/timeline.test.ts || fail "tests/timeline.test.ts missing protected_user"
  grep -q '/v1/users/' tests/timeline.test.ts || fail "tests/timeline.test.ts missing user timeline route"
  if grep -qE 'api\.twitter\.com|api\.x\.com' tests/timeline.test.ts; then
    fail "tests/timeline.test.ts mentions live X/Twitter hosts"
  fi
fi
if [[ -f src/http/routes/users.ts ]]; then
  grep -q 'core/timeline' src/http/routes/users.ts || fail "users route must call core/timeline"
  if grep -qE 'adapters/x|api\.twitter\.com|api\.x\.com' src/http/routes/users.ts; then
    fail "users route must not import the X adapter or live hosts"
  fi
fi
if [[ -f tests/search.test.ts ]]; then
  grep -q '/v1/search' tests/search.test.ts || fail "tests/search.test.ts missing /v1/search"
  grep -q 'creditsCharged' tests/search.test.ts || fail "tests/search.test.ts missing credit assertions"
  grep -q 'upstream_blocked' tests/search.test.ts || fail "tests/search.test.ts missing upstream_blocked"
  if grep -qE 'api\.twitter\.com|api\.x\.com' tests/search.test.ts; then
    fail "tests/search.test.ts mentions live X/Twitter hosts"
  fi
fi
if [[ -f src/http/routes/search.ts ]]; then
  grep -q 'core/search' src/http/routes/search.ts || fail "search route must call core/search"
  if grep -qE 'adapters/x|api\.twitter\.com|api\.x\.com' src/http/routes/search.ts; then
    fail "search route must not import the X adapter or live hosts"
  fi
fi
if [[ -f src/core/search.ts ]]; then
  grep -q 'SEARCH_CREDIT_COST' src/core/search.ts || fail "core/search missing SEARCH_CREDIT_COST"
fi
if [[ -f src/adapters/x/index.ts ]]; then
  grep -q 'upstream_blocked' src/adapters/x/index.ts || fail "live X adapter must fail upstream_blocked"
  if grep -qE 'fetch\s*\(|api\.twitter\.com|api\.x\.com' src/adapters/x/index.ts; then
    fail "live X adapter must not parse or fetch live hosts"
  fi
fi

echo "== llms.txt + MCP tools =="
[[ -f src/mcp/server.ts ]] || fail "missing src/mcp/server.ts"
[[ -f src/mcp/tools.ts ]] || fail "missing src/mcp/tools.ts"
[[ -f tests/mcp.test.ts ]] || fail "missing tests/mcp.test.ts"
for tool in unroll_thread get_post list_user_posts search_x; do
  grep -q "$tool" src/mcp/tools.ts || fail "src/mcp/tools.ts missing $tool"
  grep -q "$tool" tests/mcp.test.ts || fail "tests/mcp.test.ts missing $tool"
  grep -q "$tool" llms.txt || fail "llms.txt missing $tool"
done
grep -q 'When not to call' llms.txt || fail "llms.txt missing when-not-to-call"
grep -q 'core/search' src/mcp/tools.ts || fail "MCP tools must call core/search"
grep -q 'core/thread' src/mcp/tools.ts || fail "MCP tools must call core/thread"
grep -q 'core/timeline' src/mcp/tools.ts || fail "MCP tools must call core/timeline"
if grep -R --include='*.ts' -E 'fetch\s*\(|api\.twitter\.com|api\.x\.com' src/mcp >/dev/null 2>&1; then
  fail "src/mcp must not call live X"
fi

echo "== HTTP/MCP do not import adapters/x =="
for dir in src/http src/mcp; do
  if [[ -d "$dir" ]] && grep -R --include='*.ts' -l 'adapters/x' "$dir" >/dev/null 2>&1; then
    fail "$dir imported adapters/x"
  fi
done

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
