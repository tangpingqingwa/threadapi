#!/usr/bin/env bash
# Manual live X smoke. Not invoked by scripts/test.sh or CI.
# Starts a local process with THREADAPI_LIVE=1 and walks unroll +
# deleted/protected + HTML/noise against real syndication.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

ok() {
  echo "OK: $*"
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  cat <<'EOF'
Usage: bash scripts/live-smoke.sh

Starts src/server.ts with THREADAPI_LIVE=1 (THREADAPI_FIXTURE_ONLY unset)
and hits real X syndication:

  - unroll a public status URL (default: jack/status/20)
  - deleted tombstone → post_not_found (0 credits)
  - protected / limited-visibility tombstone → protected_user (0 credits)
  - HTML / unknown shapes → upstream_blocked (search; 0 credits)

Never invents tweet text. Not part of CI.

Overrides:
  PORT, THREADAPI_DATABASE, THREADAPI_BOOTSTRAP_KEY
  THREADAPI_SMOKE_UNROLL_URL
  THREADAPI_SMOKE_DELETED_ID
  THREADAPI_SMOKE_PROTECTED_ID
EOF
  exit 0
fi

if [[ "${THREADAPI_FIXTURE_ONLY:-}" == "1" || "${THREADAPI_FIXTURE_ONLY:-}" == "true" || "${THREADAPI_FIXTURE_ONLY:-}" == "yes" || "${THREADAPI_FIXTURE_ONLY:-}" == "on" ]]; then
  fail "THREADAPI_FIXTURE_ONLY is set; unset it so this script can talk to live X"
fi

command -v curl >/dev/null || fail "curl is required"
command -v python3 >/dev/null || fail "python3 is required"
command -v node >/dev/null || fail "node is required"
[[ -d node_modules ]] || fail "run npm ci first"

PORT="${PORT:-18765}"
KEY="${THREADAPI_BOOTSTRAP_KEY:-xk_test_live_smoke}"
UNROLL_URL="${THREADAPI_SMOKE_UNROLL_URL:-https://x.com/jack/status/20}"
DELETED_ID="${THREADAPI_SMOKE_DELETED_ID:-28}"
PROTECTED_ID="${THREADAPI_SMOKE_PROTECTED_ID:-928}"
EXPECTED_TEXT="${THREADAPI_SMOKE_EXPECTED_TEXT:-just setting up my twttr}"

WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/threadapi-live-smoke.XXXXXX")"
SERVER_PID=""
cleanup() {
  if [[ -n "${SERVER_PID}" ]] && kill -0 "${SERVER_PID}" 2>/dev/null; then
    kill "${SERVER_PID}" 2>/dev/null || true
    wait "${SERVER_PID}" 2>/dev/null || true
  fi
  rm -rf "${WORKDIR}"
}
trap cleanup EXIT

DB="${THREADAPI_DATABASE:-${WORKDIR}/threadapi.sqlite}"
BASE="http://127.0.0.1:${PORT}"

export PORT
export THREADAPI_DATABASE="${DB}"
export THREADAPI_BOOTSTRAP_KEY="${KEY}"
export THREADAPI_LIVE=1
unset THREADAPI_FIXTURE_ONLY || true
unset THREADAPI_ADAPTER || true
export NODE_ENV="${NODE_ENV:-development}"

echo "== live smoke =="
echo "base=${BASE}"
echo "db=${DB}"
echo "unroll=${UNROLL_URL}"
echo "deleted_id=${DELETED_ID}"
echo "protected_id=${PROTECTED_ID}"

node --import tsx src/server.ts >"${WORKDIR}/server.log" 2>&1 &
SERVER_PID=$!

ready=0
for _ in $(seq 1 80); do
  if curl -fsS "${BASE}/healthz" >/dev/null 2>&1; then
    ready=1
    break
  fi
  if ! kill -0 "${SERVER_PID}" 2>/dev/null; then
    cat "${WORKDIR}/server.log" >&2 || true
    fail "server exited before /healthz"
  fi
  sleep 0.1
done
[[ "${ready}" == "1" ]] || {
  cat "${WORKDIR}/server.log" >&2 || true
  fail "timed out waiting for /healthz"
}

health="$(curl -fsS "${BASE}/healthz")"
python3 -c 'import json,sys; d=json.loads(sys.argv[1]); assert d=={"ok": True}, d' "${health}" \
  || fail "/healthz was not {ok:true}"
ok "/healthz"

auth_hdr=("Authorization: Bearer ${KEY}" "accept: application/json")

curl_json() {
  local out="$1"
  shift
  local code
  code="$(curl -sS -o "${out}" -w '%{http_code}' "$@")"
  echo "${code}"
}

assert_json() {
  python3 - "$@" <<'PY'
import json, sys
from pathlib import Path

path = Path(sys.argv[1])
expect_status = int(sys.argv[2])
mode = sys.argv[3]
got_status = int(sys.argv[4])
extra = sys.argv[5:]
raw = path.read_text(encoding="utf-8")
if got_status != expect_status:
    raise SystemExit(f"HTTP {got_status} != {expect_status}: {raw[:400]}")
try:
    body = json.loads(raw)
except json.JSONDecodeError as exc:
    raise SystemExit(f"not JSON: {exc}: {raw[:400]}") from exc

def err():
    if "error" not in body or "meta" not in body:
        raise SystemExit(f"missing error envelope: {body!r}")
    return body["error"], body["meta"]

if mode == "unroll":
    expected_text = extra[0]
    data = body.get("data")
    meta = body.get("meta")
    if not isinstance(data, dict) or not isinstance(meta, dict):
        raise SystemExit(f"missing data/meta: {body!r}")
    posts = data.get("posts")
    if not isinstance(posts, list) or len(posts) < 1:
        raise SystemExit(f"posts empty: {body!r}")
    root_id = str(data.get("rootId") or "")
    first = posts[0]
    if not isinstance(first, dict):
        raise SystemExit("root post missing")
    if str(first.get("id") or "") != root_id:
        raise SystemExit(f"root is not first: rootId={root_id} first={first.get('id')}")
    text = first.get("text")
    if not isinstance(text, str):
        raise SystemExit("root text missing")
    if expected_text and expected_text not in text:
        raise SystemExit(f"root text was not the live tweet (got {text!r})")
    for post in posts:
        t = post.get("text") if isinstance(post, dict) else None
        if isinstance(t, str) and any(s in t.lower() for s in ("invented", "placeholder", "missing floor")):
            raise SystemExit(f"invented text: {t!r}")
    missing = data.get("missingIds") or []
    for mid in missing:
        if any(isinstance(p, dict) and p.get("id") == mid for p in posts):
            raise SystemExit(f"missing id {mid} also present in posts")
    charged = meta.get("creditsCharged")
    if charged not in (0, 1):
        raise SystemExit(f"unexpected creditsCharged={charged}")
    print(f"posts={len(posts)} root={root_id} handle={data.get('author', {}).get('handle')} charged={charged}")
elif mode == "error":
    code = extra[0]
    error, meta = err()
    if error.get("code") != code:
        raise SystemExit(f"error.code {error.get('code')!r} != {code!r}: {body!r}")
    if meta.get("creditsCharged") != 0:
        raise SystemExit(f"errors must charge 0, got {meta.get('creditsCharged')}: {body!r}")
    print(f"code={code} charged=0")
else:
    raise SystemExit(f"unknown mode {mode}")
PY
}

echo "== unroll public thread =="
unroll_body="${WORKDIR}/unroll.json"
unroll_status="$(curl_json "${unroll_body}" -H "${auth_hdr[0]}" -H "${auth_hdr[1]}" \
  "${BASE}/v1/threads/by-url?url=$(python3 -c 'import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1], safe=""))' "${UNROLL_URL}")")"
assert_json "${unroll_body}" 200 unroll "${unroll_status}" "${EXPECTED_TEXT}" \
  || fail "public unroll did not return live tweet text"
ok "unroll ${UNROLL_URL}"

echo "== deleted → post_not_found =="
deleted_body="${WORKDIR}/deleted.json"
deleted_status="$(curl_json "${deleted_body}" -H "${auth_hdr[0]}" -H "${auth_hdr[1]}" \
  "${BASE}/v1/posts/${DELETED_ID}")"
assert_json "${deleted_body}" 404 error "${deleted_status}" post_not_found \
  || fail "deleted post did not map to post_not_found"
ok "GET /v1/posts/${DELETED_ID} → post_not_found"

deleted_url_body="${WORKDIR}/deleted-url.json"
deleted_url_status="$(curl_json "${deleted_url_body}" -H "${auth_hdr[0]}" -H "${auth_hdr[1]}" \
  "${BASE}/v1/threads/by-url?url=$(python3 -c 'import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1], safe=""))' "https://x.com/i/status/${DELETED_ID}")")"
assert_json "${deleted_url_body}" 404 error "${deleted_url_status}" post_not_found \
  || fail "deleted url did not map to post_not_found"
ok "GET /v1/threads/by-url deleted → post_not_found"

echo "== protected / limited visibility → protected_user =="
protected_body="${WORKDIR}/protected.json"
protected_status="$(curl_json "${protected_body}" -H "${auth_hdr[0]}" -H "${auth_hdr[1]}" \
  "${BASE}/v1/posts/${PROTECTED_ID}")"
assert_json "${protected_body}" 403 error "${protected_status}" protected_user \
  || fail "protected tombstone did not map to protected_user"
ok "GET /v1/posts/${PROTECTED_ID} → protected_user"

echo "== HTML / noise → upstream_blocked =="
# Live search has no versioned shape; adapter must not scrape or invent hits.
search_body="${WORKDIR}/search.json"
search_status="$(curl_json "${search_body}" -H "${auth_hdr[0]}" -H "${auth_hdr[1]}" \
  "${BASE}/v1/search?q=threadapi")"
assert_json "${search_body}" 503 error "${search_status}" upstream_blocked \
  || fail "live search must be upstream_blocked"
ok "GET /v1/search → upstream_blocked"

# Empty / HTML timeline body is noise, not a guessed feed.
timeline_body="${WORKDIR}/timeline.json"
timeline_status="$(curl_json "${timeline_body}" -H "${auth_hdr[0]}" -H "${auth_hdr[1]}" \
  "${BASE}/v1/users/jack/posts?limit=5")"
assert_json "${timeline_body}" 503 error "${timeline_status}" upstream_blocked \
  || fail "live timeline noise must be upstream_blocked"
ok "GET /v1/users/jack/posts → upstream_blocked"

echo "== HTML unroller =="
html_ok="$(curl -sS -o "${WORKDIR}/status-ok.html" -w '%{http_code}' "${BASE}/status/20")"
[[ "${html_ok}" == "200" ]] || fail "GET /status/20 HTTP ${html_ok}"
grep -F "${EXPECTED_TEXT}" "${WORKDIR}/status-ok.html" >/dev/null \
  || fail "HTML unroller did not show the live tweet text"
if grep -Ei 'invented floor|placeholder tweet' "${WORKDIR}/status-ok.html" >/dev/null; then
  fail "HTML unroller invented tweet text"
fi
ok "GET /status/20 shows live text"

html_del="$(curl -sS -o "${WORKDIR}/status-del.html" -w '%{http_code}' "${BASE}/status/${DELETED_ID}")"
[[ "${html_del}" == "404" ]] || fail "GET /status/${DELETED_ID} HTTP ${html_del} (want 404)"
grep -F "We could not unroll this thread." "${WORKDIR}/status-del.html" >/dev/null \
  || fail "deleted HTML page must say unroll failed"
ok "GET /status/${DELETED_ID} says unroll failed"

html_prot="$(curl -sS -o "${WORKDIR}/status-prot.html" -w '%{http_code}' "${BASE}/status/${PROTECTED_ID}")"
[[ "${html_prot}" == "403" ]] || fail "GET /status/${PROTECTED_ID} HTTP ${html_prot} (want 403)"
grep -F "We could not unroll this thread." "${WORKDIR}/status-prot.html" >/dev/null \
  || fail "protected HTML page must say unroll failed"
ok "GET /status/${PROTECTED_ID} says unroll failed"

echo "OK: live smoke walked unroll + deleted/protected + upstream_blocked"
