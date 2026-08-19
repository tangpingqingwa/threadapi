import { randomUUID } from "node:crypto";
import type { XAdapter } from "../adapters/types.js";
import { chargeCredits, getCredits, SUCCESS_CREDIT_COST } from "../billing/credits.js";
import type { Key } from "../billing/keys.js";
import {
  getCacheEntry,
  postCacheKey,
  setBodyCache,
  setCacheTombstone,
  threadCacheKey,
  threadTtlMs,
  POST_TTL_MS,
} from "../cache/store.js";
import type { ThreadApiDb } from "../db.js";
import type { Err, ErrorCode, Ok, Thread, XPost } from "../types.js";

export const THREADS_BY_URL_ROUTE = "/v1/threads/by-url" as const;
export const POSTS_ROUTE = "/v1/posts/:id" as const;

const X_HOSTS = new Set(["x.com", "www.x.com", "twitter.com", "www.twitter.com", "mobile.twitter.com"]);

const ERROR_MESSAGE: Record<ErrorCode, string> = {
  invalid_request: "Provide a public x.com or twitter.com status URL.",
  unauthorized: "Missing or invalid API key.",
  payment_required: "This key has no credits remaining.",
  protected_user: "This account is protected.",
  not_found: "Not found.",
  user_not_found: "This user is suspended or does not exist.",
  post_not_found: "This post is deleted or does not exist.",
  rate_limited: "Rate limit exceeded.",
  upstream_blocked: "The upstream platform blocked this request.",
  internal: "Internal error.",
};

export type ParseUrlSuccess = { ok: true; statusId: string };
export type ParseUrlFailure = {
  ok: false;
  code: Extract<ErrorCode, "invalid_request">;
  message: string;
};
export type ParseUrlResult = ParseUrlSuccess | ParseUrlFailure;

export type ThreadOutcome = Ok<Thread> | Err;
export type PostOutcome = Ok<XPost> | Err;

export type UnrollInput = {
  db: ThreadApiDb;
  adapter: XAdapter;
  key: Key;
  url?: string;
  requestId?: string;
};

export type FetchThreadInput = {
  db: ThreadApiDb;
  adapter: XAdapter;
  rootId: string;
  requestId?: string;
};

export type FetchThreadOk = {
  ok: true;
  data: Thread;
  cached: boolean;
  requestId: string;
  upstreamMs: number;
};

export type FetchThreadErr = {
  ok: false;
  error: { code: ErrorCode; message: string; retryable: boolean };
  requestId: string;
};

export type FetchThreadResult = FetchThreadOk | FetchThreadErr;

export type GetPostInput = {
  db: ThreadApiDb;
  adapter: XAdapter;
  key: Key;
  id: string;
  requestId?: string;
};

export function isRetryableCode(code: ErrorCode): boolean {
  return code === "rate_limited" || code === "upstream_blocked" || code === "internal";
}

export function parseStatusUrl(urlRaw: string | undefined): ParseUrlResult {
  const trimmed = trimOrEmpty(urlRaw);
  if (trimmed === undefined) {
    return { ok: false, code: "invalid_request", message: ERROR_MESSAGE.invalid_request };
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, code: "invalid_request", message: "url is not a valid URL." };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, code: "invalid_request", message: "url is not a valid URL." };
  }
  const host = parsed.hostname.toLowerCase();
  if (!X_HOSTS.has(host)) {
    return {
      ok: false,
      code: "invalid_request",
      message: "url must be an x.com or twitter.com status URL.",
    };
  }
  const match = /\/status\/(\d+)/.exec(parsed.pathname);
  if (match?.[1] === undefined) {
    return {
      ok: false,
      code: "invalid_request",
      message: "url does not contain a status id.",
    };
  }
  return { ok: true, statusId: match[1] };
}

export async function unroll(input: UnrollInput): Promise<ThreadOutcome> {
  const requestId = input.requestId ?? newRequestId();
  const parsed = parseStatusUrl(input.url);
  if (!parsed.ok) {
    return fail(parsed.code, requestId, parsed.message);
  }

  const remaining = getCredits(input.db, input.key.id);
  if (remaining === null) {
    return fail("unauthorized", requestId);
  }
  if (remaining < SUCCESS_CREDIT_COST) {
    return fail("payment_required", requestId);
  }

  const fetched = await fetchThread({
    db: input.db,
    adapter: input.adapter,
    rootId: parsed.statusId,
    requestId,
  });
  if (!fetched.ok) {
    return fail(fetched.error.code, fetched.requestId, fetched.error.message);
  }
  return succeed(input, THREADS_BY_URL_ROUTE, {
    data: fetched.data,
    cached: fetched.cached,
    requestId: fetched.requestId,
    upstreamMs: fetched.upstreamMs,
  });
}

/** Shared by the paid by-url route and the free HTML unroller. Does not charge credits. */
export async function fetchThread(input: FetchThreadInput): Promise<FetchThreadResult> {
  const requestId = input.requestId ?? newRequestId();
  const rootId = trimOrEmpty(input.rootId);
  if (rootId === undefined || !/^\d+$/.test(rootId)) {
    return fetchFail("invalid_request", requestId, "id must be a numeric post id.");
  }

  const cacheKey = threadCacheKey(rootId);
  const cached = getCacheEntry(input.db, cacheKey);
  if (cached.hit && cached.kind === "thread") {
    const data = readCachedThread(cached.body);
    if (data !== null) {
      return { ok: true, data, cached: true, requestId, upstreamMs: 0 };
    }
  }
  if (cached.hit && cached.kind === "tombstone") {
    return fetchFail(cached.errorCode, requestId);
  }

  const started = performance.now();
  let conversation;
  try {
    conversation = await input.adapter.fetchConversation(rootId);
  } catch {
    return fetchFail("internal", requestId);
  }
  const upstreamMs = Math.max(0, Math.round(performance.now() - started));

  if (!conversation.ok) {
    if (conversation.code === "post_not_found") {
      setCacheTombstone(input.db, cacheKey, "post_not_found");
    }
    return fetchFail(conversation.code, requestId);
  }

  if (!conversation.posts.some((post) => post.id === rootId)) {
    return fetchFail("internal", requestId);
  }
  const thread = assembleThread(rootId, conversation.posts, conversation.missingIds);
  setBodyCache(
    input.db,
    cacheKey,
    "thread",
    JSON.stringify(thread),
    threadTtlMs({
      postCount: thread.posts.length,
      missingCount: thread.missingIds.length,
      rootCreatedAt: thread.posts[0]?.createdAt ?? "",
    }),
  );
  return { ok: true, data: thread, cached: false, requestId, upstreamMs };
}

export async function getPost(input: GetPostInput): Promise<PostOutcome> {
  const requestId = input.requestId ?? newRequestId();
  const id = trimOrEmpty(input.id);
  if (id === undefined || !/^\d+$/.test(id)) {
    return fail("invalid_request", requestId, "id must be a numeric post id.");
  }

  const remaining = getCredits(input.db, input.key.id);
  if (remaining === null) {
    return fail("unauthorized", requestId);
  }
  if (remaining < SUCCESS_CREDIT_COST) {
    return fail("payment_required", requestId);
  }

  const cacheKey = postCacheKey(id);
  const cached = getCacheEntry(input.db, cacheKey);
  if (cached.hit && cached.kind === "post") {
    const data = readCachedPost(cached.body);
    if (data !== null) {
      return succeed(input, POSTS_ROUTE, {
        data,
        cached: true,
        requestId,
        upstreamMs: 0,
      });
    }
  }
  if (cached.hit && cached.kind === "tombstone") {
    return fail(cached.errorCode, requestId);
  }

  const started = performance.now();
  let result;
  try {
    result = await input.adapter.fetchPost(id);
  } catch {
    return fail("internal", requestId);
  }
  const upstreamMs = Math.max(0, Math.round(performance.now() - started));

  if (!result.ok) {
    if (result.code === "post_not_found") {
      setCacheTombstone(input.db, cacheKey, "post_not_found");
    }
    return fail(result.code, requestId);
  }

  const post = shallowQuote(result.post);
  setBodyCache(input.db, cacheKey, "post", JSON.stringify(post), POST_TTL_MS);
  return succeed(input, POSTS_ROUTE, {
    data: post,
    cached: false,
    requestId,
    upstreamMs,
  });
}

export function assembleThread(
  rootId: string,
  posts: XPost[],
  missingIds: string[],
): Thread {
  const byId = new Map<string, XPost>();
  for (const post of posts) {
    byId.set(post.id, shallowQuote(post));
  }
  const root = byId.get(rootId);
  if (root === undefined) {
    throw new Error(`assembleThread missing root ${rootId}`);
  }

  const replies = [...byId.values()]
    .filter((post) => post.id !== rootId && post.author.id === root.author.id)
    .sort((a, b) => {
      const byTime = Date.parse(a.createdAt) - Date.parse(b.createdAt);
      if (byTime !== 0) {
        return byTime;
      }
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });

  const ordered = [root, ...replies];
  const knownMissing = [...new Set(missingIds.filter((id) => id !== rootId && !byId.has(id)))];
  knownMissing.sort();
  return {
    rootId,
    author: root.author,
    posts: ordered,
    missingIds: knownMissing,
  };
}

function shallowQuote(post: XPost): XPost {
  if (post.quote === null) {
    return post;
  }
  return { ...post, quote: { ...post.quote, quote: null } };
}

function succeed<T>(
  input: { db: ThreadApiDb; key: Key },
  route: string,
  ready: { data: T; cached: boolean; requestId: string; upstreamMs: number },
): Ok<T> {
  const skipCharge =
    input.key.prefix === "xk_test" && process.env.THREADAPI_TEST_KEYS_FREE === "1";
  let creditsCharged = 0;
  if (!skipCharge) {
    const charge = chargeCredits(input.db, {
      keyId: input.key.id,
      route,
      credits: SUCCESS_CREDIT_COST,
      cached: ready.cached,
    });
    creditsCharged = charge.ok ? charge.charged : 0;
  }
  return {
    data: ready.data,
    meta: {
      cached: ready.cached,
      creditsCharged,
      requestId: ready.requestId,
      upstreamMs: ready.upstreamMs,
    },
  };
}

function fail(code: ErrorCode, requestId: string, message?: string): Err {
  const err = fetchFail(code, requestId, message);
  return {
    error: err.error,
    meta: { creditsCharged: 0, requestId: err.requestId },
  };
}

function fetchFail(code: ErrorCode, requestId: string, message?: string): FetchThreadErr {
  return {
    ok: false,
    error: {
      code,
      message: message ?? ERROR_MESSAGE[code],
      retryable: isRetryableCode(code),
    },
    requestId,
  };
}

function readCachedThread(body: string): Thread | null {
  try {
    const parsed: unknown = JSON.parse(body);
    if (!isRecord(parsed) || typeof parsed.rootId !== "string" || !Array.isArray(parsed.posts)) {
      return null;
    }
    if (parsed.posts.length === 0) {
      return null;
    }
    return parsed as Thread;
  } catch {
    return null;
  }
}

function readCachedPost(body: string): XPost | null {
  try {
    const parsed: unknown = JSON.parse(body);
    if (!isRecord(parsed) || typeof parsed.id !== "string") {
      return null;
    }
    return parsed as XPost;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function trimOrEmpty(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function newRequestId(): string {
  return `req_${randomUUID()}`;
}
