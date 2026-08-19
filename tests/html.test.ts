import assert from "node:assert/strict";
import { after, test } from "node:test";
import type {
  ConversationResult,
  FetchPostResult,
  TimelineResult,
  XAdapter,
} from "../src/adapters/types.js";
import { createFixtureAdapter } from "../src/adapters/x/fixture.js";
import { buildApp } from "../src/app.js";
import { getCredits } from "../src/billing/credits.js";
import { createKey } from "../src/billing/keys.js";
import { openDatabase } from "../src/db.js";
import { LEGAL_FOOTER } from "../src/views/legal.js";

const KEY = "xk_test_html_unroller";
const EIGHT_ROOT = "1900000000000000001";
const QUOTE_POST = "1900000000000000003";
const HOLE_ROOT = "1920000000000000001";
const HOLE_MISSING = "1920000000000000002";
const IMAGE_ONLY = "1930000000000000001";
const PROTECTED = "1940000000000000001";
const DELETED = "1990000000000000000";

async function htmlApp(adapter?: XAdapter) {
  const db = openDatabase(":memory:");
  createKey(db, { secret: KEY, credits: 50 });
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

function isHtml(response: { headers: Record<string, unknown> }): void {
  const type = String(response.headers["content-type"] ?? "");
  assert.match(type, /text\/html/);
}

test("GET / is an HTML unroller form with ads, API CTA, and legal footer", async () => {
  const { app } = await htmlApp();
  const response = await app.inject({ method: "GET", url: "/" });
  assert.equal(response.statusCode, 200);
  isHtml(response);
  const body = response.body;
  assert.match(body, /<form /);
  assert.match(body, /name="url"/);
  assert.match(body, /twitter thread unroller/i);
  assert.match(body, /adsbygoogle/);
  assert.match(body, /data-ad-client=/);
  assert.match(body, /Need a Twitter thread unroller API\?/);
  assert.ok(body.includes(LEGAL_FOOTER));
  assert.match(body, /not affiliated/);
});

test("GET /?url= redirects to /status/:id for x.com and twitter.com", async () => {
  const { app } = await htmlApp();
  const urls = [
    `https://x.com/thread_fixture/status/${EIGHT_ROOT}`,
    `https://twitter.com/thread_fixture/status/${EIGHT_ROOT}?s=20`,
  ];
  for (const url of urls) {
    const response = await app.inject({
      method: "GET",
      url: `/?url=${encodeURIComponent(url)}`,
    });
    assert.equal(response.statusCode, 302, url);
    assert.equal(response.headers.location, `/status/${EIGHT_ROOT}`);
  }
});

test("SPEC 7: unroller HTML shows full text of an 8-post thread", async () => {
  const { app, db } = await htmlApp();
  const keyRow = db.prepare<[], { id: string }>("SELECT id FROM keys").get();
  assert.ok(keyRow);
  const before = getCredits(db, keyRow.id);

  const response = await app.inject({ method: "GET", url: `/status/${EIGHT_ROOT}` });
  assert.equal(response.statusCode, 200);
  isHtml(response);
  const body = response.body;
  assert.match(body, /1\/8 Root of the eight-post fixture thread\./);
  assert.match(body, /2\/8 Second floor\./);
  assert.match(body, /3\/8 Quote in the chain\./);
  assert.match(body, /4\/8 Fourth floor\./);
  assert.match(body, /5\/8 Fifth floor\./);
  assert.match(body, /6\/8 Sixth floor\./);
  assert.match(body, /7\/8 Seventh floor\./);
  assert.match(body, /8\/8 Last floor\./);
  assert.equal(body.includes("Side reply from someone else"), false);
  assert.match(body, /Quoted source post\./);
  assert.match(body, new RegExp(`data-post-id="${QUOTE_POST}"`));
  assert.ok(body.includes(LEGAL_FOOTER));
  assert.match(body, /adsbygoogle/);
  assert.equal(getCredits(db, keyRow.id), before);
});

test("failed unroll says so and leaves the thread body empty", async () => {
  const { app } = await htmlApp();

  const deleted = await app.inject({ method: "GET", url: `/status/${DELETED}` });
  assert.equal(deleted.statusCode, 404);
  isHtml(deleted);
  assert.match(deleted.body, /We could not unroll this thread/);
  assert.match(deleted.body, /deleted or does not exist/i);
  assert.equal(deleted.body.includes("Should never be returned."), false);
  assert.equal(deleted.body.includes('class="post"'), false);
  assert.ok(deleted.body.includes(LEGAL_FOOTER));

  const locked = await app.inject({ method: "GET", url: `/status/${PROTECTED}` });
  assert.equal(locked.statusCode, 403);
  assert.match(locked.body, /We could not unroll this thread/);
  assert.match(locked.body, /protected/i);
  assert.equal(locked.body.includes("Should never be returned."), false);

  const badUrl = await app.inject({
    method: "GET",
    url: `/?url=${encodeURIComponent("https://example.com/not-a-thread")}`,
  });
  assert.equal(badUrl.statusCode, 400);
  isHtml(badUrl);
  assert.match(badUrl.body, /x\.com or twitter\.com status URL/);
  assert.equal(badUrl.body.includes('class="post"'), false);
});

test("missing floor is marked missing and not invented", async () => {
  const { app } = await htmlApp();
  const response = await app.inject({ method: "GET", url: `/status/${HOLE_ROOT}` });
  assert.equal(response.statusCode, 200);
  assert.match(response.body, /Hole-thread root\./);
  assert.match(response.body, /Hole-thread floor after the gap\./);
  assert.match(response.body, new RegExp(`data-missing-id="${HOLE_MISSING}"`));
  assert.match(response.body, /do not invent/i);
  assert.equal(response.body.includes("invented"), false);
});

test("image-only post keeps the media URL and may have empty text", async () => {
  const { app } = await htmlApp();
  const response = await app.inject({ method: "GET", url: `/status/${IMAGE_ONLY}` });
  assert.equal(response.statusCode, 200);
  assert.match(response.body, /https:\/\/pbs\.twimg\.com\/media\/FIXTURE_PHOTO\.jpg/);
  assert.match(response.body, /class="empty-text"/);
});

test("HTML unroller does not charge API credits and stays offline", async () => {
  let conversationCalls = 0;
  const adapter: XAdapter = {
    async fetchPost(): Promise<FetchPostResult> {
      throw new Error("HTML unroller must not call fetchPost");
    },
    async fetchConversation(rootId: string): Promise<ConversationResult> {
      conversationCalls += 1;
      return createFixtureAdapter().fetchConversation(rootId);
    },
    async fetchTimeline(): Promise<TimelineResult> {
      throw new Error("HTML unroller must not call fetchTimeline");
    },
    async search() {
      throw new Error("HTML unroller must not call search");
    },
  };
  const { app, db } = await htmlApp(adapter);
  const keyRow = db.prepare<[], { id: string }>("SELECT id FROM keys").get();
  assert.ok(keyRow);
  const first = await app.inject({ method: "GET", url: `/status/${EIGHT_ROOT}` });
  const second = await app.inject({ method: "GET", url: `/status/${EIGHT_ROOT}` });
  assert.equal(first.statusCode, 200);
  assert.equal(second.statusCode, 200);
  assert.equal(conversationCalls, 1);
  assert.equal(getCredits(db, keyRow.id), 50);
});

test("user-supplied URL text is escaped on the error page", async () => {
  const { app } = await htmlApp();
  const xss = `"><script>alert(1)</script>`;
  const response = await app.inject({
    method: "GET",
    url: `/?url=${encodeURIComponent(xss)}`,
  });
  assert.equal(response.statusCode, 400);
  assert.equal(response.body.includes("<script>alert(1)</script>"), false);
  assert.match(response.body, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});
