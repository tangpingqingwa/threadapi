import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import type {
  ConversationResult,
  FetchPostResult,
  SearchRequest,
  SearchResult,
  TimelineResult,
  XAdapter,
} from "../src/adapters/types.js";
import { createLiveXAdapter } from "../src/adapters/x/index.js";
import { createFixtureAdapter } from "../src/adapters/x/fixture.js";
import { buildApp } from "../src/app.js";
import { getCredits } from "../src/billing/credits.js";
import { createKey } from "../src/billing/keys.js";
import { openDatabase } from "../src/db.js";
import type { ErrorCode, SearchPage } from "../src/types.js";

const KEY = "xk_test_search_fixture";
const QUERY = "widgetlaunch";
const FIRST_HIT = "1950000000000000001";
const QUOTE_HIT = "1950000000000000002";
const THIRD_HIT = "1950000000000000003";
const PROTECTED_TEXT = "Should never be returned.";

type OkPage = {
  data: SearchPage;
  meta: {
    cached: boolean;
    creditsCharged: number;
    requestId: string;
    upstreamMs: number;
  };
};

type ErrBody = {
  error: { code: ErrorCode; message: string; retryable: boolean };
  meta: { creditsCharged: number; requestId: string };
};

async function appWithKey(credits = 100, adapter?: XAdapter) {
  const db = openDatabase(":memory:");
  createKey(db, { secret: KEY, credits });
  const app = await buildApp({
    db,
    adapter: adapter ?? createFixtureAdapter(),
  });
  after(async () => {
    await app.close();
    db.close();
  });
  return { app, db };
}

function auth() {
  return { authorization: `Bearer ${KEY}` };
}

function searchUrl(query: Record<string, string>): string {
  return `/v1/search?${new URLSearchParams(query).toString()}`;
}

test("GET /v1/search returns recent public hits and charges 1", async () => {
  const { app, db } = await appWithKey(10);
  const keyRow = db.prepare<[], { id: string }>("SELECT id FROM keys").get();
  assert.ok(keyRow);

  const response = await app.inject({
    method: "GET",
    url: searchUrl({ q: QUERY, limit: "10" }),
    headers: auth(),
  });
  assert.equal(response.statusCode, 200);
  const body = response.json() as OkPage;
  assert.equal(body.data.query, QUERY);
  assert.ok(body.data.posts.length >= 3);
  const ids = body.data.posts.map((post) => post.id);
  assert.ok(ids.includes(FIRST_HIT));
  assert.ok(ids.includes(QUOTE_HIT));
  assert.ok(ids.includes(THIRD_HIT));
  const times = body.data.posts.map((post) => Date.parse(post.createdAt));
  assert.deepEqual(
    times,
    [...times].sort((a, b) => b - a),
  );
  assert.equal(
    body.data.posts.some((post) => post.text.includes(PROTECTED_TEXT)),
    false,
  );
  assert.equal(body.meta.cached, false);
  assert.equal(body.meta.creditsCharged, 1);
  assert.match(body.meta.requestId, /^req_/);
  assert.equal(getCredits(db, keyRow.id), 9);
});

test("search pages with cursor and keeps quotes one level deep", async () => {
  const { app, db } = await appWithKey(8);
  const keyRow = db.prepare<[], { id: string }>("SELECT id FROM keys").get();
  assert.ok(keyRow);

  const first = await app.inject({
    method: "GET",
    url: searchUrl({ q: QUERY, limit: "2" }),
    headers: auth(),
  });
  assert.equal(first.statusCode, 200);
  const firstBody = first.json() as OkPage;
  assert.equal(firstBody.data.posts.length, 2);
  assert.equal(typeof firstBody.data.nextCursor, "string");
  assert.ok(firstBody.data.nextCursor);

  const second = await app.inject({
    method: "GET",
    url: searchUrl({
      q: QUERY,
      cursor: firstBody.data.nextCursor ?? "",
      limit: "2",
    }),
    headers: auth(),
  });
  assert.equal(second.statusCode, 200);
  const secondBody = second.json() as OkPage;
  assert.ok(secondBody.data.posts.length >= 1);
  const firstIds = new Set(firstBody.data.posts.map((post) => post.id));
  assert.equal(
    secondBody.data.posts.some((post) => firstIds.has(post.id)),
    false,
  );

  const quoted = firstBody.data.posts.find((post) => post.id === QUOTE_HIT)
    ?? secondBody.data.posts.find((post) => post.id === QUOTE_HIT);
  assert.ok(quoted);
  assert.ok(quoted.quote);
  assert.equal(quoted.quote.id, "1910000000000000099");
  assert.equal(quoted.quote.quote, null);
  assert.equal(getCredits(db, keyRow.id), 6);
});

test("empty search page is 200 with 0 credits", async () => {
  const { app, db } = await appWithKey(5);
  const keyRow = db.prepare<[], { id: string }>("SELECT id FROM keys").get();
  assert.ok(keyRow);

  const response = await app.inject({
    method: "GET",
    url: searchUrl({ q: "zzzz-no-such-token" }),
    headers: auth(),
  });
  assert.equal(response.statusCode, 200);
  const body = response.json() as OkPage;
  assert.deepEqual(body.data.posts, []);
  assert.equal(body.data.nextCursor, null);
  assert.equal(body.meta.creditsCharged, 0);
  assert.equal(getCredits(db, keyRow.id), 5);
});

test("repeat search page is a cache hit and still charges 1 when there are hits", async () => {
  const { app, db } = await appWithKey(4);
  const keyRow = db.prepare<[], { id: string }>("SELECT id FROM keys").get();
  assert.ok(keyRow);

  const first = await app.inject({
    method: "GET",
    url: searchUrl({ q: QUERY, limit: "4" }),
    headers: auth(),
  });
  assert.equal(first.statusCode, 200);
  assert.equal((first.json() as OkPage).meta.cached, false);

  const second = await app.inject({
    method: "GET",
    url: searchUrl({ q: QUERY, limit: "4" }),
    headers: auth(),
  });
  assert.equal(second.statusCode, 200);
  const secondBody = second.json() as OkPage;
  assert.equal(secondBody.meta.cached, true);
  assert.equal(secondBody.meta.creditsCharged, 1);
  assert.equal(secondBody.meta.upstreamMs, 0);
  assert.equal(secondBody.data.posts.length, (first.json() as OkPage).data.posts.length);
  assert.equal(getCredits(db, keyRow.id), 2);
});

test("missing q, invalid limit, cursor, and missing bearer charge 0", async () => {
  const { app, db } = await appWithKey(5);
  const keyRow = db.prepare<[], { id: string }>("SELECT id FROM keys").get();
  assert.ok(keyRow);

  const missing = await app.inject({
    method: "GET",
    url: "/v1/search",
    headers: auth(),
  });
  assert.equal(missing.statusCode, 400);
  assert.equal((missing.json() as ErrBody).error.code, "invalid_request");
  assert.equal((missing.json() as ErrBody).meta.creditsCharged, 0);

  const blank = await app.inject({
    method: "GET",
    url: searchUrl({ q: "   " }),
    headers: auth(),
  });
  assert.equal(blank.statusCode, 400);
  assert.equal((blank.json() as ErrBody).error.code, "invalid_request");

  const badLimit = await app.inject({
    method: "GET",
    url: searchUrl({ q: QUERY, limit: "51" }),
    headers: auth(),
  });
  assert.equal(badLimit.statusCode, 400);
  assert.equal((badLimit.json() as ErrBody).error.code, "invalid_request");

  const badCursor = await app.inject({
    method: "GET",
    url: searchUrl({ q: QUERY, cursor: "!!" }),
    headers: auth(),
  });
  assert.equal(badCursor.statusCode, 400);
  assert.equal((badCursor.json() as ErrBody).error.code, "invalid_request");

  const unauth = await app.inject({
    method: "GET",
    url: searchUrl({ q: QUERY }),
  });
  assert.equal(unauth.statusCode, 401);
  assert.equal((unauth.json() as ErrBody).error.code, "unauthorized");
  assert.equal((unauth.json() as ErrBody).meta.creditsCharged, 0);
  assert.equal(getCredits(db, keyRow.id), 5);
});

test("HTTP search route calls core/search only; zero credits is 402 before adapter", async () => {
  const routesDir = join(dirname(fileURLToPath(import.meta.url)), "../src/http/routes");
  const source = readFileSync(join(routesDir, "search.ts"), "utf8");
  assert.equal(source.includes("adapters/x"), false);
  assert.match(source, /from "\.\.\/\.\.\/core\/search\.js"/);

  let fetched = false;
  const adapter: XAdapter = {
    async fetchPost(): Promise<FetchPostResult> {
      fetched = true;
      return { ok: false, code: "upstream_blocked" };
    },
    async fetchConversation(): Promise<ConversationResult> {
      fetched = true;
      return { ok: false, code: "upstream_blocked" };
    },
    async fetchTimeline(): Promise<TimelineResult> {
      fetched = true;
      return { ok: false, code: "upstream_blocked" };
    },
    async search(): Promise<SearchResult> {
      fetched = true;
      return { ok: false, code: "upstream_blocked" };
    },
  };
  const { app, db } = await appWithKey(0, adapter);
  const keyRow = db.prepare<[], { id: string }>("SELECT id FROM keys").get();
  assert.ok(keyRow);

  const response = await app.inject({
    method: "GET",
    url: searchUrl({ q: QUERY }),
    headers: auth(),
  });
  assert.equal(response.statusCode, 402);
  assert.equal((response.json() as ErrBody).error.code, "payment_required");
  assert.equal((response.json() as ErrBody).meta.creditsCharged, 0);
  assert.equal(fetched, false);
  assert.equal(getCredits(db, keyRow.id), 0);
});

test("live X adapter search is upstream_blocked, not a parsed page", async () => {
  const { app, db } = await appWithKey(5, createLiveXAdapter());
  const keyRow = db.prepare<[], { id: string }>("SELECT id FROM keys").get();
  assert.ok(keyRow);

  const response = await app.inject({
    method: "GET",
    url: searchUrl({ q: QUERY }),
    headers: auth(),
  });
  assert.equal(response.statusCode, 503);
  const body = response.json() as ErrBody;
  assert.equal(body.error.code, "upstream_blocked");
  assert.equal(body.error.retryable, true);
  assert.equal(body.meta.creditsCharged, 0);
  assert.equal(getCredits(db, keyRow.id), 5);
});

test("search adapter is invoked with the normalized query", async () => {
  let seen: SearchRequest | undefined;
  const adapter: XAdapter = {
    async fetchPost(): Promise<FetchPostResult> {
      throw new Error("search must not call fetchPost");
    },
    async fetchConversation(): Promise<ConversationResult> {
      throw new Error("search must not call fetchConversation");
    },
    async fetchTimeline(): Promise<TimelineResult> {
      throw new Error("search must not call fetchTimeline");
    },
    async search(request: SearchRequest): Promise<SearchResult> {
      seen = request;
      return createFixtureAdapter().search(request);
    },
  };
  const { app } = await appWithKey(3, adapter);
  const response = await app.inject({
    method: "GET",
    url: searchUrl({ q: `  ${QUERY}  `, limit: "3" }),
    headers: auth(),
  });
  assert.equal(response.statusCode, 200);
  assert.ok(seen);
  assert.equal(seen.q, QUERY);
  assert.equal(seen.limit, 3);
});
