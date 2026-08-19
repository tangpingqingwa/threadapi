import { randomUUID } from "node:crypto";
import type { XAdapter } from "../adapters/types.js";
import { chargeCredits, getCredits, SUCCESS_CREDIT_COST } from "../billing/credits.js";
import type { Key } from "../billing/keys.js";
import {
  getCacheEntry,
  SEARCH_TTL_MS,
  searchCacheKey,
  setBodyCache,
} from "../cache/store.js";
import type { ThreadApiDb } from "../db.js";
import type { Err, ErrorCode, Ok, SearchPage } from "../types.js";
import { isRetryableCode } from "./thread.js";

export const SEARCH_ROUTE = "/v1/search" as const;

/** v1 is 1 credit / page with hits. Raise to 2 if search COGS exceeds 40% of search revenue. */
export const SEARCH_CREDIT_COST = SUCCESS_CREDIT_COST;

export const SEARCH_DEFAULT_LIMIT = 20;
export const SEARCH_MIN_LIMIT = 1;
export const SEARCH_MAX_LIMIT = 50;

const ERROR_MESSAGE: Record<ErrorCode, string> = {
  invalid_request: "Provide a search query.",
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

export type SearchQuery = {
  q?: string;
  cursor?: string;
  limit?: string;
};

export type SearchOutcome = Ok<SearchPage> | Err;

export type SearchPostsInput = {
  db: ThreadApiDb;
  adapter: XAdapter;
  key: Key;
  query: SearchQuery;
  requestId?: string;
};

export async function searchPosts(input: SearchPostsInput): Promise<SearchOutcome> {
  const requestId = input.requestId ?? newRequestId();
  const parsed = parseSearchQuery(input.query);
  if (!parsed.ok) {
    return fail(parsed.code, requestId, parsed.message);
  }

  const remaining = getCredits(input.db, input.key.id);
  if (remaining === null) {
    return fail("unauthorized", requestId);
  }
  if (remaining < SEARCH_CREDIT_COST) {
    return fail("payment_required", requestId);
  }

  const cacheKey = searchCacheKey(parsed.q, parsed.cursor ?? "", parsed.limit);
  const cached = getCacheEntry(input.db, cacheKey);
  if (cached.hit && cached.kind === "search") {
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
    result = await input.adapter.search({
      q: parsed.q,
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

  const page = shallowQuotes({ ...result.page, query: parsed.q });
  setBodyCache(input.db, cacheKey, "search", JSON.stringify(page), SEARCH_TTL_MS);
  return succeed(input, {
    data: page,
    cached: false,
    requestId,
    upstreamMs,
  });
}

type ParsedSearchQuery = {
  q: string;
  cursor: string | undefined;
  limit: number;
};

type ParseSearchFailure = {
  ok: false;
  code: Extract<ErrorCode, "invalid_request">;
  message: string;
};

function parseSearchQuery(
  query: SearchQuery,
): (ParsedSearchQuery & { ok: true }) | ParseSearchFailure {
  const q = trimToUndefined(query.q);
  if (q === undefined) {
    return {
      ok: false,
      code: "invalid_request",
      message: "q is required.",
    };
  }
  if (q.length > 500) {
    return {
      ok: false,
      code: "invalid_request",
      message: "q must be 500 characters or fewer.",
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

  let limit = SEARCH_DEFAULT_LIMIT;
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
    if (limit < SEARCH_MIN_LIMIT || limit > SEARCH_MAX_LIMIT) {
      return {
        ok: false,
        code: "invalid_request",
        message: "limit must be an integer from 1 to 50.",
      };
    }
  }

  return { ok: true, q, cursor, limit };
}

function succeed(
  input: SearchPostsInput,
  ready: { data: SearchPage; cached: boolean; requestId: string; upstreamMs: number },
): Ok<SearchPage> {
  const skipCharge =
    input.key.prefix === "xk_test" && process.env.THREADAPI_TEST_KEYS_FREE === "1";
  let creditsCharged = 0;
  const shouldCharge = !skipCharge && ready.data.posts.length > 0;
  if (shouldCharge) {
    const charge = chargeCredits(input.db, {
      keyId: input.key.id,
      route: SEARCH_ROUTE,
      credits: SEARCH_CREDIT_COST,
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

function shallowQuotes(page: SearchPage): SearchPage {
  return {
    ...page,
    posts: page.posts.map((post) =>
      post.quote === null ? post : { ...post, quote: { ...post.quote, quote: null } },
    ),
  };
}

function readCachedPage(body: string): SearchPage | null {
  try {
    const parsed: unknown = JSON.parse(body);
    if (!isRecord(parsed) || typeof parsed.query !== "string" || !Array.isArray(parsed.posts)) {
      return null;
    }
    return parsed as SearchPage;
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
