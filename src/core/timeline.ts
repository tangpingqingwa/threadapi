import { randomUUID } from "node:crypto";
import type { XAdapter } from "../adapters/types.js";
import { chargeCredits, getCredits, SUCCESS_CREDIT_COST } from "../billing/credits.js";
import type { Key } from "../billing/keys.js";
import {
  getCacheEntry,
  setBodyCache,
  TIMELINE_TTL_MS,
  timelineCacheKey,
} from "../cache/store.js";
import type { ThreadApiDb } from "../db.js";
import type { Err, ErrorCode, Ok, UserPostsPage } from "../types.js";
import { isRetryableCode } from "./thread.js";

export const USER_POSTS_ROUTE = "/v1/users/:handle/posts" as const;

export const TIMELINE_DEFAULT_LIMIT = 20;
export const TIMELINE_MIN_LIMIT = 1;
export const TIMELINE_MAX_LIMIT = 50;

const ERROR_MESSAGE: Record<ErrorCode, string> = {
  invalid_request: "Provide a public X handle.",
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

export type TimelineQuery = {
  handle: string;
  cursor?: string;
  limit?: string;
};

export type TimelineOutcome = Ok<UserPostsPage> | Err;

export type ListUserPostsInput = {
  db: ThreadApiDb;
  adapter: XAdapter;
  key: Key;
  query: TimelineQuery;
  requestId?: string;
};

export function normalizeHandle(handle: string): string | null {
  const normalized = handle.trim().replace(/^@+/, "").toLowerCase();
  if (normalized === "" || !/^[a-z0-9_]{1,15}$/.test(normalized)) {
    return null;
  }
  return normalized;
}

export async function listUserPosts(input: ListUserPostsInput): Promise<TimelineOutcome> {
  const requestId = input.requestId ?? newRequestId();
  const parsed = parseTimelineQuery(input.query);
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

  const cacheKey = timelineCacheKey(parsed.handle, parsed.cursor ?? "", parsed.limit);
  const cached = getCacheEntry(input.db, cacheKey);
  if (cached.hit && cached.kind === "timeline") {
    const data = readCachedPage(cached.body);
    if (data !== null) {
      return succeed(input, {
        data,
        cached: true,
        requestId,
        upstreamMs: 0,
      });
    }
  }

  const started = performance.now();
  let result;
  try {
    result = await input.adapter.fetchTimeline({
      handle: parsed.handle,
      cursor: parsed.cursor,
      limit: parsed.limit,
    });
  } catch {
    return fail("internal", requestId);
  }
  const upstreamMs = Math.max(0, Math.round(performance.now() - started));

  if (!result.ok) {
    return fail(result.code, requestId);
  }

  const page = shallowQuotes(result.page);
  setBodyCache(input.db, cacheKey, "timeline", JSON.stringify(page), TIMELINE_TTL_MS);
  return succeed(input, {
    data: page,
    cached: false,
    requestId,
    upstreamMs,
  });
}

type ParsedTimelineQuery = {
  handle: string;
  cursor: string | undefined;
  limit: number;
};

type ParseTimelineFailure = {
  ok: false;
  code: Extract<ErrorCode, "invalid_request">;
  message: string;
};

function parseTimelineQuery(
  query: TimelineQuery,
): (ParsedTimelineQuery & { ok: true }) | ParseTimelineFailure {
  const handle = normalizeHandle(query.handle);
  if (handle === null) {
    return {
      ok: false,
      code: "invalid_request",
      message: "handle must be a public X username, with or without @.",
    };
  }

  const cursor = trimToUndefined(query.cursor);
  if (cursor !== undefined && !/^[A-Za-z0-9._-]+$/.test(cursor)) {
    return {
      ok: false,
      code: "invalid_request",
      message: "cursor is not a valid page token.",
    };
  }

  let limit = TIMELINE_DEFAULT_LIMIT;
  const rawLimit = trimToUndefined(query.limit);
  if (rawLimit !== undefined) {
    if (!/^\d+$/.test(rawLimit)) {
      return {
        ok: false,
        code: "invalid_request",
        message: "limit must be an integer from 1 to 50.",
      };
    }
    limit = Number(rawLimit);
    if (limit < TIMELINE_MIN_LIMIT || limit > TIMELINE_MAX_LIMIT) {
      return {
        ok: false,
        code: "invalid_request",
        message: "limit must be an integer from 1 to 50.",
      };
    }
  }

  return { ok: true, handle, cursor, limit };
}

function succeed(
  input: ListUserPostsInput,
  ready: { data: UserPostsPage; cached: boolean; requestId: string; upstreamMs: number },
): Ok<UserPostsPage> {
  const skipCharge =
    input.key.prefix === "xk_test" && process.env.THREADAPI_TEST_KEYS_FREE === "1";
  let creditsCharged = 0;
  if (!skipCharge) {
    const charge = chargeCredits(input.db, {
      keyId: input.key.id,
      route: USER_POSTS_ROUTE,
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
  return {
    error: {
      code,
      message: message ?? ERROR_MESSAGE[code],
      retryable: isRetryableCode(code),
    },
    meta: { creditsCharged: 0, requestId },
  };
}

function shallowQuotes(page: UserPostsPage): UserPostsPage {
  return {
    ...page,
    posts: page.posts.map((post) =>
      post.quote === null ? post : { ...post, quote: { ...post.quote, quote: null } },
    ),
  };
}

function readCachedPage(body: string): UserPostsPage | null {
  try {
    const parsed: unknown = JSON.parse(body);
    if (!isRecord(parsed) || !isRecord(parsed.user) || !Array.isArray(parsed.posts)) {
      return null;
    }
    return parsed as UserPostsPage;
  } catch {
    return null;
  }
}

function trimToUndefined(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function newRequestId(): string {
  return `req_${randomUUID()}`;
}
