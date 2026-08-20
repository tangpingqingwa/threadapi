# ThreadAPI — Detailed Specification and Build Plan

**Contract:** [SPEC.md](./SPEC.md)  
**Git:** [CONTRIBUTING.md](./CONTRIBUTING.md)

ClipAPI envelope. Keys `xk_live_` / `xk_test_`. Prefer loud `missingIds` over a guessed tweet.

---

## 1. Stack

Node 22, TS, Fastify, SQLite, fixture-first adapter. HTML unroller in-process.

---

## 2. Thread definition (normative)

A thread is the **root post plus the contiguous self-reply chain from the same author**, ordered by time.

- Side replies from other users: **omit** in v1.
- Quote tweets: attach `quote` one level deep; no quote-of-quote.
- If a self-reply id is referenced but fetch returns 404: push id to `missingIds`, do not drop the rest, do not invent text.
- Media: remote URLs only.

---

## 3. Algorithm `unroll(url)`

1. Parse status id from `x.com|twitter.com/*/status/{id}`.
2. Fetch root. 404 → `post_not_found`. Protected author → `protected_user`.
3. Walk `conversation` / self-reply pointers (adapter-specific) collecting same-author replies.
4. Sort by `createdAt` ascending; root first even if clock skew (force root index 0).
5. Credits: 1 on success. Cache: if root age > 1h and no missingIds, TTL 7d; else 2 min.

---

## 4. Tests

| Case | Expect |
|---|---|
| 8-post author fixture | length ≥ 8, root first |
| quote in chain | `quote` object |
| hole in middle | id in `missingIds`, no fake text |
| protected | 403, 0 credits |
| deleted url | 404, 0 credits |
| image-only | media URLs, text may be `""` |

---

## 5. PR plan

### PR 1: Skeleton + keys + envelope
- **Files:** same ClipAPI pattern (`xk_`)
- **Dependencies:** None

### PR 2: unroll + posts + missingIds
- **Description:** core/thread, fixture adapter, `/v1/threads/by-url`, `/v1/posts/:id`
- **Files:** src/core/thread.ts, adapters/x/fixture.ts, routes, tests/thread.test.ts, fixtures
- **Dependencies:** PR 1
- **Acceptance:** SPEC 1–6

### PR 3: HTML unroller
- **Files:** views, ads/legal footer, tests/html.test.ts
- **Dependencies:** PR 2

### PR 4: user timeline
- **Files:** core/timeline.ts, `/v1/users/:handle/posts`
- **Dependencies:** PR 2
- **Acceptance:** protected → 403

### PR 5: search + MCP
- **Description:** search may cost 2 credits if we later see COGS; v1 start at 1. Tools: unroll_thread, get_post, list_user_posts, search_x
- **Dependencies:** PR 4

### PR 6: live X adapter (env-gated)
- **Description:** `THREADAPI_LIVE=1` / `THREADAPI_ADAPTER=live` selects the syndication adapter. Default and CI stay on fixtures (`THREADAPI_FIXTURE_ONLY=1`). Versioned JSON only; HTML / captcha / unknown shapes are `upstream_blocked`. 404 holes stay in `missingIds`. No invented tweet text. Live search has no versioned shape yet → `upstream_blocked`.
- **Files:** src/adapters/x/index.ts, src/adapters/x/parse.ts, src/config.ts, tests/live-adapter.test.ts, tests/fixtures/live/*
- **Dependencies:** PR 5
- **Acceptance:** offline parse fixtures; CI never opens a socket to X.
