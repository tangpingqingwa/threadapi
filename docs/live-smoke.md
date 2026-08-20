# Live X smoke

Optional. **Not** part of `scripts/test.sh` or the required `ci` job.

`100%` for this unit means a local process with `THREADAPI_LIVE=1` walked unroll + deleted/protected + HTML/noise against **real** X syndication. Offline unit tests stay on fixtures.

## How to run

```bash
npm ci
unset THREADAPI_FIXTURE_ONLY
bash scripts/live-smoke.sh
```

The script starts `src/server.ts` on `PORT` (default `18765`) with:

| Env | Value |
|---|---|
| `THREADAPI_LIVE` | `1` |
| `THREADAPI_FIXTURE_ONLY` | unset |
| `THREADAPI_ADAPTER` | unset |
| `THREADAPI_DATABASE` | temp sqlite |
| `THREADAPI_BOOTSTRAP_KEY` | `xk_test_live_smoke` (override allowed) |

It is **not** invoked from CI. Do not add it to `.github/workflows/ci.yml`.

## What it hits

Against `cdn.syndication.twimg.com` (not `api.x.com` / `api.twitter.com`):

1. **Public unroll** — `GET /v1/threads/by-url?url=https://x.com/jack/status/20`  
   Expect HTTP 200, `data.posts[0].id` is the root, text is the live tweet (`just setting up my twttr`). Never invent text.
2. **Deleted** — `GET /v1/posts/28` and the same id via by-url. Syndication returns a `TweetTombstone` (“deleted by the Post author”). Expect `post_not_found`, HTTP 404, 0 credits.
3. **Protected / limited visibility** — `GET /v1/posts/928`. Syndication returns a tombstone (“limits who can view their Posts”). Expect `protected_user`, HTTP 403, 0 credits.
4. **HTML / noise → `upstream_blocked`** — live search has no versioned shape (`GET /v1/search`). Live timeline returns an empty body (`GET /v1/users/jack/posts`). Both must be `upstream_blocked`, HTTP 503, 0 credits. Do not scrape HTML or invent hits.
5. **HTML unroller** — `GET /status/20` shows the live text. Deleted / protected status pages say “We could not unroll this thread.” Empty body is better than a guessed paragraph.

Overrides: `THREADAPI_SMOKE_UNROLL_URL`, `THREADAPI_SMOKE_DELETED_ID`, `THREADAPI_SMOKE_PROTECTED_ID`, `THREADAPI_SMOKE_EXPECTED_TEXT`.

## Adapter notes

Without the public widget `token` query param, syndication answers `200 {}`. That empty object is unknown JSON → `upstream_blocked`. The live adapter therefore sends the same public token formula platform embeds use (`((id / 1e15) * π).toString(36)` with zeros/dots stripped). It is not a secret and is not an official API key.

Limited-visibility tombstones are `protected_user`. Deleted tombstones are `post_not_found`. HTML challenge pages stay `upstream_blocked`.

## Session run

Recorded this session (2026-08-20) with `bash scripts/live-smoke.sh` after `THREADAPI_LIVE=1` on a local process:

| Flow | Result |
|---|---|
| `/healthz` | 200 `{ok:true}` |
| Unroll `https://x.com/jack/status/20` | 200, root `20`, text `just setting up my twttr` |
| `GET /v1/posts/28` | 404 `post_not_found`, 0 credits |
| by-url deleted `28` | 404 `post_not_found`, 0 credits |
| `GET /v1/posts/928` | 403 `protected_user`, 0 credits |
| `GET /v1/search?q=threadapi` | 503 `upstream_blocked`, 0 credits |
| `GET /v1/users/jack/posts` | 503 `upstream_blocked`, 0 credits |
| `GET /status/20` | 200, live text present |
| `GET /status/28` | 404, unroll-failed banner |
| `GET /status/928` | 403, unroll-failed banner |

No tweet text was invented. `bash scripts/test.sh` stayed offline (`THREADAPI_FIXTURE_ONLY=1`).
