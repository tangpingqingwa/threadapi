import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createAppAdapter } from "../src/adapters/index.js";
import { createFixtureAdapter } from "../src/adapters/x/fixture.js";
import {
  createLiveXAdapter,
  LIVE_X_SYNDICATION_ORIGIN,
  type LiveXFetch,
  type LiveXHttpResponse,
} from "../src/adapters/x/index.js";
import { parseFetchPost, parseSearch } from "../src/adapters/x/parse.js";
import { buildApp } from "../src/app.js";
import { getCredits } from "../src/billing/credits.js";
import { createKey } from "../src/billing/keys.js";
import { resolveAdapterKind } from "../src/config.js";
import { openDatabase } from "../src/db.js";
import type { ErrorCode } from "../src/types.js";

const KEY = "xk_test_live_adapter";
const EIGHT_ROOT = "1900000000000000001";
const QUOTE_POST = "1900000000000000003";
const HOLE_ROOT = "1920000000000000001";
const HOLE_MISSING = "1920000000000000002";
const IMAGE_ONLY = "1930000000000000001";
const PROTECTED = "1940000000000000001";
const DELETED = "1990000000000000000";
const SIDE = "1900000000000000090";

const LIVE_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures/live");

type ErrBody = {
  error: { code: ErrorCode; message: string; retryable: boolean };
  meta: { creditsCharged: number; requestId: string };
};

const TWEET_FILES: Record<string, string> = {
  [EIGHT_ROOT]: "tweet-eight-root.json",
  "1900000000000000002": "tweet-eight-2.json",
  [QUOTE_POST]: "tweet-eight-3.json",
  "1900000000000000004": "tweet-eight-4.json",
  "1900000000000000005": "tweet-eight-5.json",
  "1900000000000000006": "tweet-eight-6.json",
  "1900000000000000007": "tweet-eight-7.json",
  "1900000000000000008": "tweet-eight-8.json",
  [SIDE]: "tweet-side.json",
  [HOLE_ROOT]: "tweet-hole-root.json",
  "1920000000000000003": "tweet-hole-after.json",
  [IMAGE_ONLY]: "tweet-image.json",
  [PROTECTED]: "tweet-protected.json",
};

function readLive(name: string): string {
  return readFileSync(join(LIVE_DIR, name), "utf8");
}

function jsonResponse(name: string, status = 200): LiveXHttpResponse {
  return { status, body: readLive(name), contentType: "application/json" };
}

function recordedFetch(): { fetch: LiveXFetch; urls: string[] } {
  const urls: string[] = [];
  const fetchImpl: LiveXFetch = async (url) => {
    urls.push(url);
    const parsed = new URL(url);
    assert.equal(parsed.origin, LIVE_X_SYNDICATION_ORIGIN);
    if (parsed.pathname === "/tweet-result") {
      const id = parsed.searchParams.get("id") ?? "";
      if (id === DELETED || id === HOLE_MISSING) {
        return jsonResponse("tweet-deleted.json", 404);
      }
      const file = TWEET_FILES[id];
      if (file === undefined) {
        return jsonResponse("tweet-deleted.json", 404);
      }
      return jsonResponse(file);
    }
    if (parsed.pathname === "/timeline/profile") {
      const handle = parsed.searchParams.get("screen_name");
      if (handle === "locked_account") {
        return { status: 403, body: readLive("timeline-protected.json"), contentType: "application/json" };
      }
      if (handle === "no_such_user") {
        return { status: 404, body: JSON.stringify({ code: "user_not_found" }), contentType: "application/json" };
      }
      if (handle === "thread_fixture") {
        return jsonResponse("timeline-public.json");
      }
      return { status: 404, body: JSON.stringify({ code: "user_not_found" }), contentType: "application/json" };
    }
    return { status: 503, body: readLive("challenge.html"), contentType: "text/html" };
  };
  return { fetch: fetchImpl, urls };
}

function auth() {
  return { authorization: `Bearer ${KEY}` };
}

async function appWithLive(credits = 10) {
  const db = openDatabase(":memory:");
  createKey(db, { secret: KEY, credits });
  const recorded = recordedFetch();
  const app = await buildApp({
    db,
    adapter: createLiveXAdapter({ fetch: recorded.fetch }),
  });
  after(async () => {
    await app.close();
    db.close();
  });
  return { app, db, urls: recorded.urls };
}

test("resolveAdapterKind defaults to fixture and honors env gates", () => {
  assert.equal(resolveAdapterKind({}), "fixture");
  assert.equal(resolveAdapterKind({ THREADAPI_LIVE: "1" }), "live");
  assert.equal(resolveAdapterKind({ THREADAPI_ADAPTER: "live" }), "live");
  assert.equal(resolveAdapterKind({ THREADAPI_LIVE: "1", THREADAPI_FIXTURE_ONLY: "1" }), "fixture");
  assert.equal(resolveAdapterKind({ THREADAPI_ADAPTER: "live", THREADAPI_FIXTURE_ONLY: "true" }), "fixture");
  assert.equal(
    resolveAdapterKind({ THREADAPI_ADAPTER: "fixture", THREADAPI_LIVE: "1", THREADAPI_FIXTURE_ONLY: "1" }),
    "fixture",
  );
  assert.throws(
    () => resolveAdapterKind({ THREADAPI_ADAPTER: "scrape" }),
    /THREADAPI_ADAPTER must be fixture or live/,
  );
});

test("createAppAdapter stays on fixtures unless live is explicitly enabled", async () => {
  const fixture = createAppAdapter({});
  const known = await fixture.fetchPost(EIGHT_ROOT);
  assert.equal(known.ok, true);
  if (known.ok) {
    assert.equal(known.post.text, "1/8 Root of the eight-post fixture thread.");
  }

  const live = createAppAdapter({ THREADAPI_LIVE: "1" });
  const blocked = await live.search({ q: "widgetlaunch", limit: 10 });
  assert.deepEqual(blocked, { ok: false, code: "upstream_blocked" });

  const forced = createAppAdapter({ THREADAPI_LIVE: "1", THREADAPI_FIXTURE_ONLY: "1" });
  const stillFixture = await forced.fetchPost(IMAGE_ONLY);
  assert.equal(stillFixture.ok, true);
});

test("live syndication JSON unrolls an 8-post author thread without inventing text", async () => {
  const adapter = createLiveXAdapter({ fetch: recordedFetch().fetch });
  const conversation = await adapter.fetchConversation(EIGHT_ROOT);
  assert.equal(conversation.ok, true);
  if (!conversation.ok) {
    return;
  }
  assert.ok(conversation.posts.length >= 8);
  assert.equal(conversation.posts[0]?.id, EIGHT_ROOT);
  assert.equal(
    conversation.posts.every((post) => post.author.handle === "thread_fixture"),
    true,
  );
  assert.equal(
    conversation.posts.some((post) => post.id === SIDE),
    false,
  );
  const quoted = conversation.posts.find((post) => post.id === QUOTE_POST);
  assert.ok(quoted?.quote);
  assert.equal(quoted.quote.id, "1910000000000000099");
  assert.equal(quoted.quote.quote, null);
});

test("deleted middle floor is missingIds and is not invented", async () => {
  const adapter = createLiveXAdapter({ fetch: recordedFetch().fetch });
  const conversation = await adapter.fetchConversation(HOLE_ROOT);
  assert.equal(conversation.ok, true);
  if (!conversation.ok) {
    return;
  }
  assert.ok(conversation.missingIds.includes(HOLE_MISSING));
  assert.equal(
    conversation.posts.some((post) => post.id === HOLE_MISSING),
    false,
  );
  assert.equal(
    conversation.posts.some((post) => /invent|placeholder|missing floor/i.test(post.text)),
    false,
  );
});

test("protected, deleted, and image-only map to SPEC failures or empty text", async () => {
  const adapter = createLiveXAdapter({ fetch: recordedFetch().fetch });
  assert.deepEqual(await adapter.fetchPost(PROTECTED), { ok: false, code: "protected_user" });
  assert.deepEqual(await adapter.fetchPost(DELETED), { ok: false, code: "post_not_found" });
  const image = await adapter.fetchPost(IMAGE_ONLY);
  assert.equal(image.ok, true);
  if (image.ok) {
    assert.equal(image.post.text, "");
    assert.equal(image.post.media[0]?.url, "https://pbs.twimg.com/media/FIXTURE_PHOTO.jpg");
  }
  assert.deepEqual(await adapter.fetchTimeline({ handle: "locked_account", limit: 20 }), {
    ok: false,
    code: "protected_user",
  });
  assert.deepEqual(await adapter.fetchTimeline({ handle: "no_such_user", limit: 20 }), {
    ok: false,
    code: "user_not_found",
  });
});

test("HTML challenge and unknown JSON are upstream_blocked, never parsed as tweets", async () => {
  const html = readLive("challenge.html");
  assert.deepEqual(parseFetchPost(html, "text/html"), { ok: false, code: "upstream_blocked" });
  assert.deepEqual(parseFetchPost(readLive("noise.json"), "application/json"), {
    ok: false,
    code: "upstream_blocked",
  });
  assert.deepEqual(parseSearch("widgetlaunch", html, "text/html"), {
    ok: false,
    code: "upstream_blocked",
  });
  assert.equal(html.toLowerCase().includes("just a moment"), true);
  assert.equal(readLive("noise.json").includes("invented floor"), true);

  const blocked = createLiveXAdapter({
    fetch: async () => ({ status: 200, body: html, contentType: "text/html" }),
  });
  assert.deepEqual(await blocked.fetchPost(EIGHT_ROOT), { ok: false, code: "upstream_blocked" });
  assert.deepEqual(await blocked.fetchConversation(EIGHT_ROOT), { ok: false, code: "upstream_blocked" });
  assert.deepEqual(await blocked.fetchTimeline({ handle: "thread_fixture", limit: 5 }), {
    ok: false,
    code: "upstream_blocked",
  });
});

test("live HTTP routes charge 0 on protected, deleted, and blocked noise", async () => {
  const { app, db } = await appWithLive(5);
  const keyRow = db.prepare<[], { id: string }>("SELECT id FROM keys").get();
  assert.ok(keyRow);

  const locked = await app.inject({
    method: "GET",
    url: `/v1/threads/by-url?url=${encodeURIComponent(`https://x.com/locked_account/status/${PROTECTED}`)}`,
    headers: auth(),
  });
  assert.equal(locked.statusCode, 403);
  assert.equal((locked.json() as ErrBody).error.code, "protected_user");
  assert.equal((locked.json() as ErrBody).meta.creditsCharged, 0);

  const gone = await app.inject({
    method: "GET",
    url: `/v1/posts/${DELETED}`,
    headers: auth(),
  });
  assert.equal(gone.statusCode, 404);
  assert.equal((gone.json() as ErrBody).error.code, "post_not_found");
  assert.equal((gone.json() as ErrBody).meta.creditsCharged, 0);

  const search = await app.inject({
    method: "GET",
    url: "/v1/search?q=widgetlaunch",
    headers: auth(),
  });
  assert.equal(search.statusCode, 503);
  assert.equal((search.json() as ErrBody).error.code, "upstream_blocked");
  assert.equal((search.json() as ErrBody).meta.creditsCharged, 0);
  assert.equal(getCredits(db, keyRow.id), 5);
});

test("default createLiveXAdapter search does not open a socket", async () => {
  const result = await createLiveXAdapter().search({ q: "widgetlaunch", limit: 5 });
  assert.deepEqual(result, { ok: false, code: "upstream_blocked" });
});

test("buildApp without an override still uses the fixture catalog", async () => {
  const app = await buildApp();
  after(() => app.close());
  const fixture = createFixtureAdapter();
  const expected = await fixture.fetchPost(EIGHT_ROOT);
  const actual = await app.adapter.fetchPost(EIGHT_ROOT);
  assert.deepEqual(actual, expected);
});
