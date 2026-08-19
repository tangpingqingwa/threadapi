# ThreadAPI — Product Development Spec

**Version:** 1.0  
**Status:** Ready to build  
**Repo:** https://github.com/tangpingqingwa/threadapi

X / Twitter read API for people who will not pay official Basic (hundreds of USD). Unroll, timeline, search.

---

## 1. Product statement

Self-serve REST + MCP: expand a public X thread to ordered posts; read a public user timeline; keyword-search recent public posts.

One-line pitch: **Thread URL in. Ordered JSON out. $5/mo, not $200.**

Official API exists. The product is the price and the agent packaging.

---

## 2. Goals and non-goals

### Goals

- `GET /v1/threads/by-url` returns the root + reply chain from the same author (classic unroll) **and** quoted posts as nested objects, not lost.
- Missing floors marked `missing`, never hallucinated.
- Completed threads cache hard (immutable enough).
- Free unroller page for SEO (`twitter thread unroller` class queries).
- MCP on day one: `unroll_thread`, `search_x`.

### Non-goals

- Tweet / like / follow / DM / bookmarks.
- For You / Home timeline.
- Firehose.
- Growth-hacking SaaS.
- Logged-in user data.

---

## 3. Auth and envelope

Bearer `xk_live_...`. Same `{ data, meta }` / `{ error, meta }` as ClipAPI.

Extra error codes:

| code | HTTP | meaning |
|---|---|---|
| `user_not_found` | 404 | handle suspended or missing |
| `post_not_found` | 404 | deleted |
| `protected_user` | 403 | protected account |
| `upstream_blocked` | 503 | X anti-bot |

---

## 4. Endpoints

### 4.1 `GET /v1/threads/by-url`

**Credits:** 1 on success.

Query: `url` (x.com or twitter.com status URL).

`data`:

```ts
{
  rootId: string
  author: XUser
  posts: XPost[]          // root first, then self-replies in time order
  missingIds: string[]    // known gaps
}
```

```ts
type XUser = {
  id: string
  handle: string
  name: string
  verified: boolean | null
}

type XPost = {
  id: string
  author: XUser
  text: string
  createdAt: string
  lang: string | null
  replyToId: string | null
  quote: XPost | null     // shallow: no recursive quote-of-quote in v1
  media: Array<{ type: "photo" | "video" | "gif", url: string, previewUrl?: string }>
  engagement: { replies: number | null, reposts: number | null, likes: number | null }
  permalink: string
}
```

Media = remote URLs only. We do not proxy video.

Definition of “thread”: contiguous self-reply chain from the root author. Side-replies from others are **out of v1** (document this; DailyBrief does not need them).

### 4.2 `GET /v1/posts/{id}`

Credits: 1. Single post + optional `quote`.

### 4.3 `GET /v1/users/{handle}/posts`

Credits: 1 / page. Public timeline. Query: `cursor`, `limit` (1–50).

Protected → `protected_user`.

### 4.4 `GET /v1/search`

Credits: 1 / page with hits. Query: `q`, `cursor`, `limit`. Recent public posts only. Do not claim full archive.

### 4.5 Control plane

`/v1/me`, `/v1/usage`, `/healthz`.

---

## 5. Free unroller

`/` and `/status/:id` HTML. Ads. CTA to API. Independent / not affiliated with X or Twitter.

If unroll fails, say so. Empty thread body is better than a guessed paragraph.

---

## 6. Caching and cost

| Resource | TTL |
|---|---|
| Completed thread (root + ≥1 reply, 1h old) | 7 days |
| Live / <1h old thread | 2 min |
| Single post | 1 hour (tombstone 24h on 404) |
| Timeline | 2 min |
| Search | 2 min |

Search proxy cost is real. If search COGS > 40% of search revenue, raise search to 2 credits / page. Do not loss-lead.

One VPS + small proxy pool. Isolate X adapter. Loud errors.

---

## 7. Billing

Same $0 / $5 / $54 ladder as ClipAPI. Separate Stripe product.

---

## 8. MCP

| tool | endpoint |
|---|---|
| `unroll_thread` | `/v1/threads/by-url` |
| `get_post` | `/v1/posts/{id}` |
| `list_user_posts` | `/v1/users/{handle}/posts` |
| `search_x` | `/v1/search` |

Skill: not for posting; not for private accounts; not a firehose.

SEO page: `Does X still have a cheap API in 2026?` with official price table vs this.

---

## 9. Acceptance

| # | Case | Expected |
|---|---|---|
| 1 | 8-post author thread | posts.length ≥ 8, root first |
| 2 | Quote tweet in chain | `quote` object present |
| 3 | Deleted middle post | id in `missingIds`, no invented text |
| 4 | Protected user timeline | 403, 0 credit |
| 5 | Deleted url | 404, 0 credit |
| 6 | Image-only post | media URLs, text may be empty |
| 7 | Unroller HTML shows full text | |
| 8 | Repeat completed thread | cache hit |

---

## 10. Milestones

**M1:** by-url + missingIds + unroller.  
**M2:** posts + user timeline; keys; Stripe.  
**M3:** search (optional price = 2 credits if COGS high).  
**M4:** MCP + comparison post.

Launch = M2.

---

## 11. Legal / ops

Hostile platform. Prefer 503 `upstream_blocked` over a partial hallucinated thread. No session cookies from real users. Customer ToS: read-only, no impersonation, no mass unrolling for spam.

When X HTML/JSON changes, fixture tests fail the build. There is no “best-effort parse” in production without a versioned adapter flag.

## 12. Git collaboration (normative)

Development is GitHub trunk-based. **`main` is always cloneable, buildable, and testable.**

| Rule | Requirement |
|---|---|
| Integration branch | `main` only. No long-lived `develop`. |
| How code lands | Pull request into `main`. No direct push. |
| Required check | GitHub Actions workflow `ci` (job id `ci`) must be green. |
| Local / CI test | `bash scripts/test.sh` — offline, no production secrets. |
| Branch names | `feat/` `fix/` `docs/` `chore/` `test/` + short slug. |
| Merge | Squash. Delete the head branch. |
| Broken `main` | Treat as an incident. Fix on `fix/…` via PR. |

Full process: [CONTRIBUTING.md](./CONTRIBUTING.md).

Implementation plan (stack, modules, PR DAG): [BUILD.md](./BUILD.md).

Until there is an application binary, `scripts/test.sh` still has to pass: contract files exist, SPEC/CONTRIBUTING agree, no tracked secrets. Adding a server or CLI means **extending** that script with unit/contract tests. Live upstream calls are optional and must not be required for `main` to stay green.
