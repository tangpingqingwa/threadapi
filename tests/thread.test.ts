import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createFixtureAdapter } from "../src/adapters/x/fixture.js";
import type {
  ConversationResult,
  FetchPostResult,
  TimelineResult,
  XAdapter,
} from "../src/adapters/types.js";
import { buildApp } from "../src/app.js";
import { getCredits } from "../src/billing/credits.js";
import { createKey } from "../src/billing/keys.js";
import { assembleThread, parseStatusUrl } from "../src/core/thread.js";
import { openDatabase } from "../src/db.js";
import type { ErrorCode, Thread, XPost } from "../src/types.js";

const KEY = "xk_test_thread_fixture";
const EIGHT_ROOT = "1900000000000000001";
const QUOTE_POST = "1900000000000000003";
const HOLE_ROOT = "1920000000000000001";
const HOLE_MISSING = "1920000000000000002";
const IMAGE_ONLY = "1930000000000000001";
const PROTECTED = "1940000000000000001";
const DELETED = "1990000000000000000";

type OkThread = {
  data: Thread;
  meta: {
    cached: boolean;
    creditsCharged: number;
    requestId: string;
    upstreamMs: number;
  };
};

type OkPost = {
  data: XPost;
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

function byUrl(url: string): string {
  return `/v1/threads/by-url?url=${encodeURIComponent(url)}`;
}

test("parseStatusUrl accepts x.com and twitter.com status URLs", () => {
  const urls = [
    `https://x.com/thread_fixture/status/${EIGHT_ROOT}`,
    `https://www.x.com/thread_fixture/status/${EIGHT_ROOT}`,
    `https://twitter.com/thread_fixture/status/${EIGHT_ROOT}`,
    `https://www.twitter.com/thread_fixture/status/${EIGHT_ROOT}/`,
    `https://mobile.twitter.com/thread_fixture/status/${EIGHT_ROOT}?s=20`,
  ];
  for (const url of urls) {
    const parsed = parseStatusUrl(url);
    assert.equal(parsed.ok, true, url);
    if (parsed.ok) {
      assert.equal(parsed.statusId, EIGHT_ROOT);
    }
  }
});

test("parseStatusUrl rejects missing, bad, and non-status URLs", () => {
  const missing = parseStatusUrl(undefined);
  assert.equal(missing.ok, false);
  if (!missing.ok) {
    assert.equal(missing.code, "invalid_request");
  }

  const bad = parseStatusUrl("not-a-url");
  assert.equal(bad.ok, false);
  if (!bad.ok) {
    assert.equal(bad.code, "invalid_request");
  }

  const youtube = parseStatusUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  assert.equal(youtube.ok, false);
  if (!youtube.ok) {
    assert.equal(youtube.code, "invalid_request");
  }

  const profile = parseStatusUrl("https://x.com/thread_fixture");
  assert.equal(profile.ok, false);
  if (!profile.ok) {
    assert.equal(profile.code, "invalid_request");
  }
});

test("assembleThread forces root first and drops other-author replies", () => {
  const author = {
    id: "u_author",
    handle: "thread_fixture",
    name: "Thread Fixture",
    verified: false,
  };
  const other = {
    id: "u_side",
    handle: "side_replier",
    name: "Side Replier",
    verified: null,
  };
  const emptyEngagement = { replies: 0, reposts: 0, likes: 0 };
  const root: XPost = {
    id: "1",
    author,
    text: "root",
    createdAt: "2024-01-01T12:10:00.000Z",
    lang: "en",
    replyToId: null,
    quote: null,
    media: [],
    engagement: emptyEngagement,
    permalink: "https://x.com/thread_fixture/status/1",
  };
  const later: XPost = {
    ...root,
    id: "3",
    text: "later",
    createdAt: "2024-01-01T12:01:00.000Z",
    replyToId: "1",
    permalink: "https://x.com/thread_fixture/status/3",
  };
  const earlier: XPost = {
    ...root,
    id: "2",
    text: "earlier",
    createdAt: "2024-01-01T12:00:00.000Z",
    replyToId: "1",
    permalink: "https://x.com/thread_fixture/status/2",
  };
  const side: XPost = {
    ...root,
    id: "9",
    author: other,
    text: "side",
    createdAt: "2024-01-01T12:00:30.000Z",
    replyToId: "1",
    permalink: "https://x.com/side_replier/status/9",
  };
  const thread = assembleThread("1", [later, root, side, earlier], ["4", "4"]);
  assert.equal(thread.posts[0]?.id, "1");
  assert.deepEqual(
    thread.posts.map((post) => post.id),
    ["1", "2", "3"],
  );
  assert.deepEqual(thread.missingIds, ["4"]);
});

test("SPEC 1: 8-post author thread is root-first and charges 1", async () => {
  const { app, db } = await appWithKey(10);
  const keyRow = db.prepare<[], { id: string }>("SELECT id FROM keys").get();
  assert.ok(keyRow);

  const response = await app.inject({
    method: "GET",
    url: byUrl(`https://x.com/thread_fixture/status/${EIGHT_ROOT}`),
    headers: auth(),
  });
  assert.equal(response.statusCode, 200);
  const body = response.json() as OkThread;
  assert.ok(body.data.posts.length >= 8);
  assert.equal(body.data.rootId, EIGHT_ROOT);
  assert.equal(body.data.posts[0]?.id, EIGHT_ROOT);
  assert.equal(body.data.author.handle, "thread_fixture");
  assert.equal(
    body.data.posts.every((post) => post.author.id === body.data.author.id),
    true,
  );
  assert.equal(
    body.data.posts.some((post) => post.author.handle === "side_replier"),
    false,
  );
  assert.deepEqual(body.data.missingIds, []);
  assert.equal(body.meta.cached, false);
  assert.equal(body.meta.creditsCharged, 1);
  assert.match(body.meta.requestId, /^req_/);
  assert.equal(getCredits(db, keyRow.id), 9);
});

test("SPEC 2: quote tweet in the chain is a nested object, one level deep", async () => {
  const { app } = await appWithKey();
  const response = await app.inject({
    method: "GET",
    url: byUrl(`https://twitter.com/thread_fixture/status/${EIGHT_ROOT}`),
    headers: auth(),
  });
  assert.equal(response.statusCode, 200);
  const body = response.json() as OkThread;
  const quoted = body.data.posts.find((post) => post.id === QUOTE_POST);
  assert.ok(quoted);
  assert.ok(quoted.quote);
  assert.equal(quoted.quote.id, "1910000000000000099");
  assert.equal(quoted.quote.author.handle, "quoted_fixture");
  assert.equal(quoted.quote.text, "Quoted source post.");
  assert.equal(quoted.quote.quote, null);
});

test("SPEC 3: deleted middle post is in missingIds and is not invented", async () => {
  const { app } = await appWithKey();
  const response = await app.inject({
    method: "GET",
    url: byUrl(`https://x.com/thread_fixture/status/${HOLE_ROOT}`),
    headers: auth(),
  });
  assert.equal(response.statusCode, 200);
  const body = response.json() as OkThread;
  assert.ok(body.data.missingIds.includes(HOLE_MISSING));
  assert.equal(
    body.data.posts.some((post) => post.id === HOLE_MISSING),
    false,
  );
  assert.equal(
    body.data.posts.some((post) => /invent|placeholder|missing floor/i.test(post.text)),
    false,
  );
  assert.deepEqual(
    body.data.posts.map((post) => post.id),
    [HOLE_ROOT, "1920000000000000003"],
  );
  assert.equal(body.meta.creditsCharged, 1);
});

test("SPEC 4: protected user is 403 and 0 credits", async () => {
  const { app, db } = await appWithKey(5);
  const keyRow = db.prepare<[], { id: string }>("SELECT id FROM keys").get();
  assert.ok(keyRow);

  const thread = await app.inject({
    method: "GET",
    url: byUrl(`https://x.com/locked_account/status/${PROTECTED}`),
    headers: auth(),
  });
  assert.equal(thread.statusCode, 403);
  const threadBody = thread.json() as ErrBody;
  assert.equal(threadBody.error.code, "protected_user");
  assert.equal(threadBody.meta.creditsCharged, 0);

  const post = await app.inject({
    method: "GET",
    url: `/v1/posts/${PROTECTED}`,
    headers: auth(),
  });
  assert.equal(post.statusCode, 403);
  const postBody = post.json() as ErrBody;
  assert.equal(postBody.error.code, "protected_user");
  assert.equal(postBody.meta.creditsCharged, 0);
  assert.equal(getCredits(db, keyRow.id), 5);
});

test("SPEC 5: deleted url is 404 post_not_found and 0 credits", async () => {
  const { app, db } = await appWithKey(5);
  const keyRow = db.prepare<[], { id: string }>("SELECT id FROM keys").get();
  assert.ok(keyRow);

  const response = await app.inject({
    method: "GET",
    url: byUrl(`https://x.com/gone/status/${DELETED}`),
    headers: auth(),
  });
  assert.equal(response.statusCode, 404);
  const body = response.json() as ErrBody;
  assert.equal(body.error.code, "post_not_found");
  assert.equal(body.meta.creditsCharged, 0);
  assert.equal(getCredits(db, keyRow.id), 5);

  const post = await app.inject({
    method: "GET",
    url: `/v1/posts/${DELETED}`,
    headers: auth(),
  });
  assert.equal(post.statusCode, 404);
  assert.equal((post.json() as ErrBody).error.code, "post_not_found");
  assert.equal((post.json() as ErrBody).meta.creditsCharged, 0);
  assert.equal(getCredits(db, keyRow.id), 5);
});

test("SPEC 6: image-only post keeps media URLs and may have empty text", async () => {
  const { app } = await appWithKey();
  const response = await app.inject({
    method: "GET",
    url: `/v1/posts/${IMAGE_ONLY}`,
    headers: auth(),
  });
  assert.equal(response.statusCode, 200);
  const body = response.json() as OkPost;
  assert.equal(body.data.id, IMAGE_ONLY);
  assert.equal(body.data.text, "");
  assert.ok(body.data.media.length >= 1);
  assert.equal(body.data.media[0]?.type, "photo");
  assert.match(body.data.media[0]?.url ?? "", /^https?:\/\//);
  assert.equal(body.meta.creditsCharged, 1);
});

test("GET /v1/posts/:id returns a single post plus optional quote", async () => {
  const { app, db } = await appWithKey(4);
  const keyRow = db.prepare<[], { id: string }>("SELECT id FROM keys").get();
  assert.ok(keyRow);

  const response = await app.inject({
    method: "GET",
    url: `/v1/posts/${QUOTE_POST}`,
    headers: auth(),
  });
  assert.equal(response.statusCode, 200);
  const body = response.json() as OkPost;
  assert.equal(body.data.id, QUOTE_POST);
  assert.ok(body.data.quote);
  assert.equal(body.data.quote.id, "1910000000000000099");
  assert.equal(body.data.quote.quote, null);
  assert.equal(body.meta.creditsCharged, 1);
  assert.equal(getCredits(db, keyRow.id), 3);
});

test("repeat completed thread is a cache hit and still charges 1", async () => {
  const { app, db } = await appWithKey(10);
  const keyRow = db.prepare<[], { id: string }>("SELECT id FROM keys").get();
  assert.ok(keyRow);

  const first = await app.inject({
    method: "GET",
    url: byUrl(`https://x.com/thread_fixture/status/${EIGHT_ROOT}`),
    headers: auth(),
  });
  assert.equal(first.statusCode, 200);
  assert.equal((first.json() as OkThread).meta.cached, false);

  const second = await app.inject({
    method: "GET",
    url: byUrl(`https://twitter.com/thread_fixture/status/${EIGHT_ROOT}`),
    headers: auth(),
  });
  assert.equal(second.statusCode, 200);
  const secondBody = second.json() as OkThread;
  assert.equal(secondBody.meta.cached, true);
  assert.equal(secondBody.meta.creditsCharged, 1);
  assert.equal(secondBody.meta.upstreamMs, 0);
  assert.equal(secondBody.data.posts.length, (first.json() as OkThread).data.posts.length);
  assert.equal(getCredits(db, keyRow.id), 8);
});

test("invalid url and missing bearer charge 0", async () => {
  const { app, db } = await appWithKey(5);
  const keyRow = db.prepare<[], { id: string }>("SELECT id FROM keys").get();
  assert.ok(keyRow);

  const bad = await app.inject({
    method: "GET",
    url: "/v1/threads/by-url?url=not-a-url",
    headers: auth(),
  });
  assert.equal(bad.statusCode, 400);
  assert.equal((bad.json() as ErrBody).error.code, "invalid_request");
  assert.equal((bad.json() as ErrBody).meta.creditsCharged, 0);

  const unauth = await app.inject({
    method: "GET",
    url: byUrl(`https://x.com/thread_fixture/status/${EIGHT_ROOT}`),
  });
  assert.equal(unauth.statusCode, 401);
  assert.equal((unauth.json() as ErrBody).error.code, "unauthorized");
  assert.equal((unauth.json() as ErrBody).meta.creditsCharged, 0);
  assert.equal(getCredits(db, keyRow.id), 5);
});

test("HTTP routes do not import the X adapter; unknown id stays 404 0 credit", async () => {
  const routesDir = join(dirname(fileURLToPath(import.meta.url)), "../src/http/routes");
  for (const file of ["threads.ts", "posts.ts"]) {
    const source = readFileSync(join(routesDir, file), "utf8");
    assert.equal(source.includes("adapters/x"), false, file);
    assert.match(source, /from "\.\.\/\.\.\/core\/thread\.js"/);
  }

  const { app, db } = await appWithKey(3);
  const keyRow = db.prepare<[], { id: string }>("SELECT id FROM keys").get();
  assert.ok(keyRow);
  const response = await app.inject({
    method: "GET",
    url: "/v1/posts/1888888888888888888",
    headers: auth(),
  });
  assert.equal(response.statusCode, 404);
  assert.equal((response.json() as ErrBody).error.code, "post_not_found");
  assert.equal((response.json() as ErrBody).meta.creditsCharged, 0);
  assert.equal(getCredits(db, keyRow.id), 3);
});

test("zero credits is 402 before adapter work", async () => {
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
    url: byUrl(`https://x.com/thread_fixture/status/${EIGHT_ROOT}`),
    headers: auth(),
  });
  assert.equal(response.statusCode, 402);
  assert.equal((response.json() as ErrBody).error.code, "payment_required");
  assert.equal((response.json() as ErrBody).meta.creditsCharged, 0);
  assert.equal(fetched, false);
  assert.equal(getCredits(db, keyRow.id), 0);
});
