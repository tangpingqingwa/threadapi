import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import type {
  ConversationResult,
  FetchPostResult,
  TimelineRequest,
  TimelineResult,
  XAdapter,
} from "../src/adapters/types.js";
import { createFixtureAdapter } from "../src/adapters/x/fixture.js";
import { buildApp } from "../src/app.js";
import { getCredits } from "../src/billing/credits.js";
import { createKey } from "../src/billing/keys.js";
import { normalizeHandle } from "../src/core/timeline.js";
import { openDatabase } from "../src/db.js";
import type { ErrorCode, UserPostsPage } from "../src/types.js";

const KEY = "xk_test_timeline_fixture";
const PUBLIC_HANDLE = "thread_fixture";
const PROTECTED_HANDLE = "locked_account";
const MISSING_HANDLE = "no_such_user";
const QUOTE_POST = "1900000000000000003";

type OkPage = {
  data: UserPostsPage;
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

function timelineUrl(handle: string, query: Record<string, string> = {}): string {
  const params = new URLSearchParams(query);
  const suffix = params.size > 0 ? `?${params.toString()}` : "";
  return `/v1/users/${encodeURIComponent(handle)}/posts${suffix}`;
}

test("normalizeHandle strips @ and rejects empty or illegal handles", () => {
  assert.equal(normalizeHandle("@Thread_Fixture"), "thread_fixture");
  assert.equal(normalizeHandle("locked_account"), "locked_account");
  assert.equal(normalizeHandle("   "), null);
  assert.equal(normalizeHandle("bad-handle"), null);
  assert.equal(normalizeHandle("waytoolonghandle1"), null);
});

test("GET /v1/users/:handle/posts returns a public timeline page and charges 1", async () => {
  const { app, db } = await appWithKey(10);
  const keyRow = db.prepare<[], { id: string }>("SELECT id FROM keys").get();
  assert.ok(keyRow);

  const response = await app.inject({
    method: "GET",
    url: timelineUrl(PUBLIC_HANDLE, { limit: "5" }),
    headers: auth(),
  });
  assert.equal(response.statusCode, 200);
  const body = response.json() as OkPage;
  assert.equal(body.data.user.handle, PUBLIC_HANDLE);
  assert.ok(body.data.posts.length >= 1);
  assert.ok(body.data.posts.length <= 5);
  assert.equal(
    body.data.posts.every((post) => post.author.handle === PUBLIC_HANDLE),
    true,
  );
  const times = body.data.posts.map((post) => Date.parse(post.createdAt));
  assert.deepEqual(
    times,
    [...times].sort((a, b) => b - a),
  );
  assert.equal(body.meta.cached, false);
  assert.equal(body.meta.creditsCharged, 1);
  assert.match(body.meta.requestId, /^req_/);
  assert.equal(getCredits(db, keyRow.id), 9);
});

test("timeline pages with cursor and keeps quotes one level deep", async () => {
  const { app, db } = await appWithKey(8);
  const keyRow = db.prepare<[], { id: string }>("SELECT id FROM keys").get();
  assert.ok(keyRow);

  const first = await app.inject({
    method: "GET",
    url: timelineUrl(`@${PUBLIC_HANDLE}`, { limit: "3" }),
    headers: auth(),
  });
  assert.equal(first.statusCode, 200);
  const firstBody = first.json() as OkPage;
  assert.equal(firstBody.data.posts.length, 3);
  assert.equal(typeof firstBody.data.nextCursor, "string");
  assert.ok(firstBody.data.nextCursor);

  const second = await app.inject({
    method: "GET",
    url: timelineUrl(PUBLIC_HANDLE, {
      cursor: firstBody.data.nextCursor ?? "",
      limit: "3",
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

  const wide = await app.inject({
    method: "GET",
    url: timelineUrl(PUBLIC_HANDLE, { limit: "50" }),
    headers: auth(),
  });
  assert.equal(wide.statusCode, 200);
  const quoted = (wide.json() as OkPage).data.posts.find((post) => post.id === QUOTE_POST);
  assert.ok(quoted);
  assert.ok(quoted.quote);
  assert.equal(quoted.quote.id, "1910000000000000099");
  assert.equal(quoted.quote.quote, null);
  assert.equal(getCredits(db, keyRow.id), 5);
});

test("SPEC 4: protected user timeline is 403 and 0 credits", async () => {
  let fetched = false;
  const adapter: XAdapter = {
    async fetchPost(): Promise<FetchPostResult> {
      throw new Error("timeline must not call fetchPost");
    },
    async fetchConversation(): Promise<ConversationResult> {
      throw new Error("timeline must not call fetchConversation");
    },
    async fetchTimeline(request: TimelineRequest): Promise<TimelineResult> {
      fetched = true;
      return createFixtureAdapter().fetchTimeline(request);
    },
  };
  const { app, db } = await appWithKey(5, adapter);
  const keyRow = db.prepare<[], { id: string }>("SELECT id FROM keys").get();
  assert.ok(keyRow);

  const response = await app.inject({
    method: "GET",
    url: timelineUrl(PROTECTED_HANDLE),
    headers: auth(),
  });
  assert.equal(response.statusCode, 403);
  const body = response.json() as ErrBody;
  assert.equal(body.error.code, "protected_user");
  assert.equal(body.error.retryable, false);
  assert.equal(body.meta.creditsCharged, 0);
  assert.equal(fetched, true);
  assert.equal(getCredits(db, keyRow.id), 5);
});

test("unknown handle is 404 user_not_found and 0 credits", async () => {
  const { app, db } = await appWithKey(5);
  const keyRow = db.prepare<[], { id: string }>("SELECT id FROM keys").get();
  assert.ok(keyRow);

  const response = await app.inject({
    method: "GET",
    url: timelineUrl(MISSING_HANDLE),
    headers: auth(),
  });
  assert.equal(response.statusCode, 404);
  const body = response.json() as ErrBody;
  assert.equal(body.error.code, "user_not_found");
  assert.equal(body.meta.creditsCharged, 0);
  assert.equal(getCredits(db, keyRow.id), 5);
});

test("repeat timeline page is a cache hit and still charges 1", async () => {
  const { app, db } = await appWithKey(4);
  const keyRow = db.prepare<[], { id: string }>("SELECT id FROM keys").get();
  assert.ok(keyRow);

  const first = await app.inject({
    method: "GET",
    url: timelineUrl(PUBLIC_HANDLE, { limit: "4" }),
    headers: auth(),
  });
  assert.equal(first.statusCode, 200);
  assert.equal((first.json() as OkPage).meta.cached, false);

  const second = await app.inject({
    method: "GET",
    url: timelineUrl(PUBLIC_HANDLE, { limit: "4" }),
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

test("invalid handle, limit, cursor, and missing bearer charge 0", async () => {
  const { app, db } = await appWithKey(5);
  const keyRow = db.prepare<[], { id: string }>("SELECT id FROM keys").get();
  assert.ok(keyRow);

  const badHandle = await app.inject({
    method: "GET",
    url: timelineUrl("bad-handle"),
    headers: auth(),
  });
  assert.equal(badHandle.statusCode, 400);
  assert.equal((badHandle.json() as ErrBody).error.code, "invalid_request");
  assert.equal((badHandle.json() as ErrBody).meta.creditsCharged, 0);

  const badLimit = await app.inject({
    method: "GET",
    url: timelineUrl(PUBLIC_HANDLE, { limit: "51" }),
    headers: auth(),
  });
  assert.equal(badLimit.statusCode, 400);
  assert.equal((badLimit.json() as ErrBody).error.code, "invalid_request");

  const badCursor = await app.inject({
    method: "GET",
    url: timelineUrl(PUBLIC_HANDLE, { cursor: "!!" }),
    headers: auth(),
  });
  assert.equal(badCursor.statusCode, 400);
  assert.equal((badCursor.json() as ErrBody).error.code, "invalid_request");

  const unauth = await app.inject({
    method: "GET",
    url: timelineUrl(PUBLIC_HANDLE),
  });
  assert.equal(unauth.statusCode, 401);
  assert.equal((unauth.json() as ErrBody).error.code, "unauthorized");
  assert.equal((unauth.json() as ErrBody).meta.creditsCharged, 0);
  assert.equal(getCredits(db, keyRow.id), 5);
});

test("HTTP user route calls core/timeline only; zero credits is 402 before adapter", async () => {
  const routesDir = join(dirname(fileURLToPath(import.meta.url)), "../src/http/routes");
  const source = readFileSync(join(routesDir, "users.ts"), "utf8");
  assert.equal(source.includes("adapters/x"), false);
  assert.match(source, /from "\.\.\/\.\.\/core\/timeline\.js"/);

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
  };
  const { app, db } = await appWithKey(0, adapter);
  const keyRow = db.prepare<[], { id: string }>("SELECT id FROM keys").get();
  assert.ok(keyRow);

  const response = await app.inject({
    method: "GET",
    url: timelineUrl(PUBLIC_HANDLE),
    headers: auth(),
  });
  assert.equal(response.statusCode, 402);
  assert.equal((response.json() as ErrBody).error.code, "payment_required");
  assert.equal((response.json() as ErrBody).meta.creditsCharged, 0);
  assert.equal(fetched, false);
  assert.equal(getCredits(db, keyRow.id), 0);
});
