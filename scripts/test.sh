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
  if grep -qE 'api\.twitter\.com|api\.x\.com' src/adapters/x/index.ts src/adapters/x/parse.ts; then
    fail "live X adapter must not call official X API hosts"
  fi
fi
if [[ -f src/adapters/index.ts ]]; then
  grep -q 'THREADAPI_LIVE' src/adapters/index.ts || fail "createAppAdapter must be env-gated"
  grep -q 'THREADAPI_FIXTURE_ONLY' src/adapters/index.ts || fail "createAppAdapter must honor THREADAPI_FIXTURE_ONLY"
fi
if [[ -f tests/live-adapter.test.ts ]]; then
  grep -q 'THREADAPI_LIVE' tests/live-adapter.test.ts || fail "tests/live-adapter.test.ts missing THREADAPI_LIVE"
  grep -q 'THREADAPI_FIXTURE_ONLY' tests/live-adapter.test.ts || fail "tests/live-adapter.test.ts missing THREADAPI_FIXTURE_ONLY"
  grep -q 'upstream_blocked' tests/live-adapter.test.ts || fail "tests/live-adapter.test.ts missing upstream_blocked"
  grep -q 'missingIds' tests/live-adapter.test.ts || fail "tests/live-adapter.test.ts missing missingIds"
  grep -q 'protected_user' tests/live-adapter.test.ts || fail "tests/live-adapter.test.ts missing protected_user"
  grep -q 'post_not_found' tests/live-adapter.test.ts || fail "tests/live-adapter.test.ts missing post_not_found"
  if grep -qE 'api\.twitter\.com|api\.x\.com' tests/live-adapter.test.ts; then
    fail "tests/live-adapter.test.ts mentions official X API hosts"
  fi
fi
if [[ -d tests/fixtures/live ]]; then
  [[ -f tests/fixtures/live/challenge.html ]] || fail "missing tests/fixtures/live/challenge.html"
  [[ -f tests/fixtures/live/noise.json ]] || fail "missing tests/fixtures/live/noise.json"
fi

echo "== deploy artifacts (Dockerfile + runbook) =="
[[ -f Dockerfile ]] || fail "missing Dockerfile"
[[ -f .env.example ]] || fail "missing .env.example"
[[ -f deploy/runbook.md ]] || fail "missing deploy/runbook.md"
grep -q 'node:22' Dockerfile || fail "Dockerfile must use Node 22"
grep -qE '^USER[[:space:]]+node$' Dockerfile || fail "Dockerfile must run as non-root USER node"
grep -q 'PORT' Dockerfile || fail "Dockerfile must honor PORT"
grep -q 'src/server.ts' Dockerfile || fail "Dockerfile must start src/server.ts"
if grep -E 'THREADAPI_LIVE[[:space:]]*=[[:space:]]*(1|true|yes|on)' Dockerfile >/dev/null; then
  fail "Dockerfile must not enable live X"
fi
if grep -E 'THREADAPI_ADAPTER[[:space:]]*=[[:space:]]*live' Dockerfile >/dev/null; then
  fail "Dockerfile must not set THREADAPI_ADAPTER=live"
fi
grep -q 'THREADAPI_LIVE' .env.example || fail ".env.example missing THREADAPI_LIVE"
grep -q 'THREADAPI_FIXTURE_ONLY' .env.example || fail ".env.example missing THREADAPI_FIXTURE_ONLY"
grep -q 'THREADAPI_DATABASE' .env.example || fail ".env.example missing THREADAPI_DATABASE"
grep -q 'THREADAPI_BOOTSTRAP_KEY' .env.example || fail ".env.example missing THREADAPI_BOOTSTRAP_KEY"
if grep -E '^[[:space:]]*THREADAPI_LIVE=1[[:space:]]*$' .env.example >/dev/null; then
  fail ".env.example must not default live X on"
fi
if grep -E '^[[:space:]]*THREADAPI_ADAPTER=live[[:space:]]*$' .env.example >/dev/null; then
  fail ".env.example must not default THREADAPI_ADAPTER=live"
fi
if grep -E '^[[:space:]]*THREADAPI_BOOTSTRAP_KEY=xk_(live|test)_' .env.example >/dev/null; then
  fail ".env.example must not ship a real bootstrap key"
fi
grep -q '/healthz' deploy/runbook.md || fail "runbook missing /healthz"
grep -q 'THREADAPI_LIVE=1' deploy/runbook.md || fail "runbook missing how to enable live"
grep -q 'docker build' deploy/runbook.md || fail "runbook missing docker build"
grep -q 'docker run' deploy/runbook.md || fail "runbook missing docker run"
if grep -qE 'api\.twitter\.com|api\.x\.com' Dockerfile; then
  fail "Dockerfile must not mention official X API hosts"
fi
if grep -qE 'api\.twitter\.com|api\.x\.com' .github/workflows/ci.yml; then
  fail "CI must not mention official X API hosts"
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
  # Fixture adapter only — never hit live X, even if the developer exported THREADAPI_LIVE.
  export THREADAPI_FIXTURE_ONLY=1
  unset THREADAPI_LIVE || true
  unset THREADAPI_ADAPTER || true
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
