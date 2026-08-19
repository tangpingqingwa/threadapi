# ThreadAPI

X / Twitter thread unroll, single posts, public user timelines, and search. Self-serve.

Official X API still exists. The price is the product gap.

## Why this, and why overseas

English Twitter/X is still where launches, AI discourse, and breaking takes live. Official Basic starts in the hundreds of USD; Pro is worse. What most builders want is smaller: expand a thread to ordered text, read an account’s last public posts, pull a keyword window.

Thread-unroller sites have had SEO for a decade. They rarely offer a contract an agent can call.

Queries: `twitter thread api`, `twitter thread unroller api`, `x api alternative 2026`.

## Exact demand

- Who: media monitors, DailyBrief, agents that treat X as a source, indie social tools
- Acceptance: post URL in, full thread out (author, time, text, quotes, image URLs), 1 credit. Same usage on official API should be an order of magnitude more expensive

## Exact connector

| Endpoint | Job | Credits |
|---|---|---|
| `/v1/threads/by-url` | Expand the thread | 1 |
| `/v1/posts/{id}` | One post | 1 |
| `/v1/users/{handle}/posts` | Public timeline page | 1 / page |
| `/v1/search` | Recent keyword posts | 1 / page |

Ship MCP on day one: `unroll_thread`, `search_x`. Add `llms.txt`.

## Exact combination

- Free unroller page (AdSense + SEO)
- API $5 / mo / 1,000
- SEO: `Does X still have a cheap API in 2026?`
- Skills into agent directories week one
- DailyBrief: follow these accounts

## Cost control

- Completed threads cache hard
- Timelines and search: short TTL
- Media URLs only
- Proxy cost baked into search credits; do not loss-lead search
- Deleted posts / missing users: 0 credits

## Business model

Ads on the free page + credits. Feature set is unroll / read / search, not a social suite.

Success: English SEO can produce five-figure monthly visits on the free page; API $1k / mo.

## Will not do

- No tweet, like, follow, DM
- No For You
- No firehose
- No growth-hacking as a service

## First two weeks

1. Free page and `by-url` share one backend
2. Quotes, retweets, images, missing floors
3. OpenAPI + one MCP tool
4. Comparison draft: official price card vs this

## Dogfood

Launch posts, competitor accounts, and our own growth threads land in a local store via ThreadAPI. If we still hit Show more, it is not done.

## Risk

X is hostile to automation. Prefer a loud error over a hallucinated thread. Independent, not affiliated. No logged-in user data.
