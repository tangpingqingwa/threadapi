import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createLiveXAdapter } from "../src/adapters/x/index.js";
import { createFixtureAdapter } from "../src/adapters/x/fixture.js";
import { buildApp } from "../src/app.js";
import { getCredits } from "../src/billing/credits.js";
import { createKey } from "../src/billing/keys.js";
import { openDatabase } from "../src/db.js";
import { MCP_PATH, MCP_PROTOCOL_VERSION } from "../src/mcp/server.js";
import {
  GET_POST_TOOL,
  LIST_USER_POSTS_TOOL,
  MCP_TOOL_NAMES,
  SEARCH_X_TOOL,
  UNROLL_THREAD_TOOL,
} from "../src/mcp/tools.js";
import type { ErrorCode, SearchPage, Thread, UserPostsPage, XPost } from "../src/types.js";

const KEY = "xk_test_mcp_fixture";
const EIGHT_ROOT = "1900000000000000001";
const QUOTE_POST = "1900000000000000003";
const PUBLIC_HANDLE = "thread_fixture";
const PROTECTED_HANDLE = "locked_account";
const QUERY = "widgetlaunch";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

type OkBody<T> = {
  data: T;
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

type ToolResult = {
  content: Array<{ type: string; text: string }>;
  structuredContent: OkBody<unknown> | ErrBody;
  isError: boolean;
};

type JsonRpcOk = {
  jsonrpc: "2.0";
  id: string | number | null;
  result: unknown;
};

async function appWithKey(credits = 100) {
  const db = openDatabase(":memory:");
  const key = createKey(db, { secret: KEY, credits });
  const app = await buildApp({
    db,
    adapter: createFixtureAdapter(),
  });
  after(async () => {
    await app.close();
    db.close();
  });
  return { app, db, key };
}

function auth() {
  return { authorization: `Bearer ${KEY}` };
}

async function rpc(
  app: Awaited<ReturnType<typeof buildApp>>,
  method: string,
  params?: unknown,
  headers: Record<string, string> = auth(),
) {
  return app.inject({
    method: "POST",
    url: MCP_PATH,
    headers,
    payload: { jsonrpc: "2.0", id: 1, method, params },
  });
}

async function callTool(
  app: Awaited<ReturnType<typeof buildApp>>,
  name: string,
  args: Record<string, unknown> = {},
) {
  const response = await rpc(app, "tools/call", { name, arguments: args });
  assert.equal(response.statusCode, 200, response.body);
  const body = response.json() as JsonRpcOk;
  const result = body.result as ToolResult;
  assert.ok(result);
  assert.equal(typeof result.isError, "boolean");
  return result;
}

function walkTs(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, name.name);
    if (name.isDirectory()) {
      out.push(...walkTs(path));
    } else if (name.name.endsWith(".ts")) {
      out.push(path);
    }
  }
  return out;
}

test("GET /llms.txt is public and matches the checked-in file", async () => {
  const { app } = await appWithKey();
  const response = await app.inject({ method: "GET", url: "/llms.txt" });
  assert.equal(response.statusCode, 200);
  assert.match(response.headers["content-type"] ?? "", /text\/plain/);
  const onDisk = readFileSync(join(ROOT, "llms.txt"), "utf8");
  assert.equal(response.body, onDisk);
  assert.match(onDisk, /unroll_thread/);
  assert.match(onDisk, /get_post/);
  assert.match(onDisk, /list_user_posts/);
  assert.match(onDisk, /search_x/);
  assert.match(onDisk, /When not to call/i);
  assert.match(onDisk, /not for posting/i);
  assert.match(onDisk, /not a firehose/i);
  assert.match(onDisk, /private accounts/i);
});

test("GET /.well-known/mcp/server-card.json lists shipped tools", async () => {
  const { app } = await appWithKey();
  const response = await app.inject({
    method: "GET",
    url: "/.well-known/mcp/server-card.json",
  });
  assert.equal(response.statusCode, 200);
  const card = response.json() as { tools: string[]; transport: string };
  assert.equal(card.transport, "streamable-http");
  assert.deepEqual(card.tools, [...MCP_TOOL_NAMES]);
});

test("POST /mcp without bearer is 401 with 0 credits", async () => {
  const { app } = await appWithKey();
  const response = await rpc(app, "initialize", undefined, {});
  assert.equal(response.statusCode, 401);
  const body = response.json() as ErrBody;
  assert.equal(body.error.code, "unauthorized");
  assert.equal(body.meta.creditsCharged, 0);
});

test("initialize and tools/list describe the four SPEC tools", async () => {
  const { app } = await appWithKey();

  const init = await rpc(app, "initialize");
  assert.equal(init.statusCode, 200);
  const initBody = init.json() as JsonRpcOk;
  const initResult = initBody.result as {
    protocolVersion: string;
    capabilities: { tools: unknown };
    serverInfo: { name: string };
    instructions: string;
  };
  assert.equal(initResult.protocolVersion, MCP_PROTOCOL_VERSION);
  assert.equal(initResult.serverInfo.name, "threadapi");
  assert.ok(initResult.capabilities.tools);
  assert.match(initResult.instructions, /not for posting/i);
  assert.match(initResult.instructions, /not a firehose/i);
  assert.match(initResult.instructions, /private/i);

  const listed = await rpc(app, "tools/list");
  assert.equal(listed.statusCode, 200);
  const tools = (
    (listed.json() as JsonRpcOk).result as {
      tools: Array<{ name: string }>;
    }
  ).tools.map((tool) => tool.name);
  assert.deepEqual(tools, [
    UNROLL_THREAD_TOOL,
    GET_POST_TOOL,
    LIST_USER_POSTS_TOOL,
    SEARCH_X_TOOL,
  ]);
});

test("MCP unroll_thread returns the same payload as REST and charges 1", async () => {
  const { app, db, key } = await appWithKey(10);
  const url = `https://x.com/thread_fixture/status/${EIGHT_ROOT}`;

  const rest = await app.inject({
    method: "GET",
    url: `/v1/threads/by-url?url=${encodeURIComponent(url)}`,
    headers: auth(),
  });
  assert.equal(rest.statusCode, 200);
  const restBody = rest.json() as OkBody<Thread>;
  assert.ok(restBody.data.posts.length >= 8);
  assert.equal(restBody.meta.creditsCharged, 1);
  assert.equal(getCredits(db, key.id), 9);

  const mcp = await callTool(app, UNROLL_THREAD_TOOL, { url });
  assert.equal(mcp.isError, false);
  const mcpBody = mcp.structuredContent as OkBody<Thread>;
  assert.deepEqual(mcpBody.data, restBody.data);
  assert.equal(mcpBody.meta.creditsCharged, 1);
  assert.equal(mcpBody.meta.cached, true);
  assert.equal(mcpBody.meta.upstreamMs, 0);
  assert.match(mcpBody.meta.requestId, /^req_/);
  assert.equal(getCredits(db, key.id), 8);

  const parsedText = JSON.parse(mcp.content[0]?.text ?? "null") as OkBody<Thread>;
  assert.deepEqual(parsedText.data, restBody.data);
});

test("MCP get_post matches REST including one-level quote", async () => {
  const { app, db, key } = await appWithKey(4);

  const rest = await app.inject({
    method: "GET",
    url: `/v1/posts/${QUOTE_POST}`,
    headers: auth(),
  });
  assert.equal(rest.statusCode, 200);
  const restBody = rest.json() as OkBody<XPost>;

  const mcp = await callTool(app, GET_POST_TOOL, { id: QUOTE_POST });
  assert.equal(mcp.isError, false);
  const mcpBody = mcp.structuredContent as OkBody<XPost>;
  assert.deepEqual(mcpBody.data, restBody.data);
  assert.ok(mcpBody.data.quote);
  assert.equal(mcpBody.data.quote.quote, null);
  assert.equal(mcpBody.meta.creditsCharged, 1);
  assert.equal(getCredits(db, key.id), 2);
});

test("MCP list_user_posts matches REST; protected is 403 0 credits", async () => {
  const { app, db, key } = await appWithKey(6);

  const rest = await app.inject({
    method: "GET",
    url: `/v1/users/${PUBLIC_HANDLE}/posts?limit=5`,
    headers: auth(),
  });
  assert.equal(rest.statusCode, 200);
  const restBody = rest.json() as OkBody<UserPostsPage>;

  const mcp = await callTool(app, LIST_USER_POSTS_TOOL, {
    handle: `@${PUBLIC_HANDLE}`,
    limit: 5,
  });
  assert.equal(mcp.isError, false);
  const mcpBody = mcp.structuredContent as OkBody<UserPostsPage>;
  assert.deepEqual(mcpBody.data, restBody.data);
  assert.equal(mcpBody.meta.creditsCharged, 1);
  assert.equal(getCredits(db, key.id), 4);

  const locked = await callTool(app, LIST_USER_POSTS_TOOL, {
    handle: PROTECTED_HANDLE,
  });
  assert.equal(locked.isError, true);
  const lockedBody = locked.structuredContent as ErrBody;
  assert.equal(lockedBody.error.code, "protected_user");
  assert.equal(lockedBody.meta.creditsCharged, 0);
  assert.equal(getCredits(db, key.id), 4);
});

test("MCP search_x matches REST and charges 1 only when there are hits", async () => {
  const { app, db, key } = await appWithKey(6);

  const rest = await app.inject({
    method: "GET",
    url: `/v1/search?q=${encodeURIComponent(QUERY)}&limit=10`,
    headers: auth(),
  });
  assert.equal(rest.statusCode, 200);
  const restBody = rest.json() as OkBody<SearchPage>;
  assert.ok(restBody.data.posts.length >= 1);
  assert.equal(restBody.meta.creditsCharged, 1);

  const mcp = await callTool(app, SEARCH_X_TOOL, { q: QUERY, limit: 10 });
  assert.equal(mcp.isError, false);
  const mcpBody = mcp.structuredContent as OkBody<SearchPage>;
  assert.deepEqual(mcpBody.data, restBody.data);
  assert.equal(mcpBody.meta.creditsCharged, 1);
  assert.equal(mcpBody.meta.cached, true);
  assert.equal(getCredits(db, key.id), 4);

  const empty = await callTool(app, SEARCH_X_TOOL, { q: "zzzz-no-such-token" });
  assert.equal(empty.isError, false);
  const emptyBody = empty.structuredContent as OkBody<SearchPage>;
  assert.deepEqual(emptyBody.data.posts, []);
  assert.equal(emptyBody.meta.creditsCharged, 0);
  assert.equal(getCredits(db, key.id), 4);
});

test("MCP tool errors match REST and charge 0", async () => {
  const { app, db, key } = await appWithKey(3);

  const badUrl = await callTool(app, UNROLL_THREAD_TOOL, { url: "not-a-url" });
  assert.equal((badUrl.structuredContent as ErrBody).error.code, "invalid_request");
  assert.equal((badUrl.structuredContent as ErrBody).meta.creditsCharged, 0);

  const gone = await callTool(app, GET_POST_TOOL, { id: "1990000000000000000" });
  assert.equal((gone.structuredContent as ErrBody).error.code, "post_not_found");
  assert.equal((gone.structuredContent as ErrBody).meta.creditsCharged, 0);

  const missingQ = await callTool(app, SEARCH_X_TOOL, {});
  assert.equal((missingQ.structuredContent as ErrBody).error.code, "invalid_request");

  const unpaid = await appWithKey(0);
  const blocked = await callTool(unpaid.app, SEARCH_X_TOOL, { q: QUERY });
  assert.equal((blocked.structuredContent as ErrBody).error.code, "payment_required");
  assert.equal((blocked.structuredContent as ErrBody).meta.creditsCharged, 0);
  assert.equal(getCredits(db, key.id), 3);
});

test("unknown MCP tool is invalid_request with 0 credits", async () => {
  const { app, db, key } = await appWithKey(5);
  const result = await callTool(app, "post_tweet", { text: "nope" });
  assert.equal(result.isError, true);
  const body = result.structuredContent as ErrBody;
  assert.equal(body.error.code, "invalid_request");
  assert.equal(body.meta.creditsCharged, 0);
  assert.equal(getCredits(db, key.id), 5);
});

test("live adapter via MCP search_x is upstream_blocked", async () => {
  const db = openDatabase(":memory:");
  createKey(db, { secret: KEY, credits: 5 });
  const app = await buildApp({ db, adapter: createLiveXAdapter() });
  after(async () => {
    await app.close();
    db.close();
  });

  const result = await callTool(app, SEARCH_X_TOOL, { q: QUERY });
  assert.equal(result.isError, true);
  const body = result.structuredContent as ErrBody;
  assert.equal(body.error.code, "upstream_blocked");
  assert.equal(body.meta.creditsCharged, 0);
});

test("HTTP and MCP call core only and never import adapters/x", () => {
  const files = [
    ...walkTs(join(ROOT, "src/http")),
    ...walkTs(join(ROOT, "src/mcp")),
  ];
  assert.ok(files.length > 0);
  for (const file of files) {
    const src = readFileSync(file, "utf8");
    assert.doesNotMatch(src, /adapters\/x/, file);
    assert.doesNotMatch(src, /api\.twitter\.com|api\.x\.com/, file);
  }
  const tools = readFileSync(join(ROOT, "src/mcp/tools.ts"), "utf8");
  assert.match(tools, /unroll\(/);
  assert.match(tools, /getPost/);
  assert.match(tools, /listUserPosts/);
  assert.match(tools, /searchPosts/);
});

test("MCP sources do not fetch live X", () => {
  for (const file of walkTs(join(ROOT, "src/mcp"))) {
    const src = readFileSync(file, "utf8");
    assert.doesNotMatch(src, /\bfetch\s*\(/, file);
    assert.doesNotMatch(src, /api\.twitter\.com|api\.x\.com/, file);
  }
});
