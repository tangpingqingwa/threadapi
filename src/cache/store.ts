import type { ThreadApiDb } from "../db.js";
import type { ErrorCode } from "../types.js";

export const COMPLETED_THREAD_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const LIVE_THREAD_TTL_MS = 2 * 60 * 1000;
export const POST_TTL_MS = 60 * 60 * 1000;
export const TOMBSTONE_TTL_MS = 24 * 60 * 60 * 1000;
export const COMPLETED_THREAD_MIN_AGE_MS = 60 * 60 * 1000;

export type CacheTombstoneCode = Extract<ErrorCode, "post_not_found">;

export type CacheLookup =
  | { hit: false }
  | { hit: true; kind: "thread" | "post"; body: string }
  | { hit: true; kind: "tombstone"; errorCode: CacheTombstoneCode };

type CacheRow = {
  kind: string;
  body: string | null;
  error_code: string | null;
  expires_at: string;
};

export function threadCacheKey(rootId: string): string {
  return `thread:${rootId}`;
}

export function postCacheKey(id: string): string {
  return `post:${id}`;
}

export function getCacheEntry(
  db: ThreadApiDb,
  cacheKey: string,
  now: Date = new Date(),
): CacheLookup {
  const row = db
    .prepare<[string], CacheRow>(
      `SELECT kind, body, error_code, expires_at
       FROM cache_entries WHERE cache_key = ?`,
    )
    .get(cacheKey);
  if (row === undefined || row.expires_at <= now.toISOString()) {
    return { hit: false };
  }
  if ((row.kind === "thread" || row.kind === "post") && row.body !== null) {
    return { hit: true, kind: row.kind, body: row.body };
  }
  if (row.kind === "tombstone" && row.error_code === "post_not_found") {
    return { hit: true, kind: "tombstone", errorCode: "post_not_found" };
  }
  return { hit: false };
}

export function setBodyCache(
  db: ThreadApiDb,
  cacheKey: string,
  kind: "thread" | "post",
  body: string,
  ttlMs: number,
  now: Date = new Date(),
): void {
  upsertCache(db, {
    cacheKey,
    kind,
    body,
    errorCode: null,
    expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
  });
}

export function setCacheTombstone(
  db: ThreadApiDb,
  cacheKey: string,
  errorCode: CacheTombstoneCode,
  now: Date = new Date(),
  ttlMs: number = TOMBSTONE_TTL_MS,
): void {
  upsertCache(db, {
    cacheKey,
    kind: "tombstone",
    body: null,
    errorCode,
    expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
  });
}

export function threadTtlMs(
  input: { postCount: number; missingCount: number; rootCreatedAt: string },
  now: Date = new Date(),
): number {
  const rootAge = now.getTime() - Date.parse(input.rootCreatedAt);
  const completed =
    input.postCount >= 2 &&
    input.missingCount === 0 &&
    Number.isFinite(rootAge) &&
    rootAge > COMPLETED_THREAD_MIN_AGE_MS;
  return completed ? COMPLETED_THREAD_TTL_MS : LIVE_THREAD_TTL_MS;
}

function upsertCache(
  db: ThreadApiDb,
  entry: {
    cacheKey: string;
    kind: string;
    body: string | null;
    errorCode: string | null;
    expiresAt: string;
  },
): void {
  db.prepare(
    `INSERT INTO cache_entries (cache_key, kind, body, error_code, expires_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(cache_key) DO UPDATE SET
       kind = excluded.kind,
       body = excluded.body,
       error_code = excluded.error_code,
       expires_at = excluded.expires_at`,
  ).run(entry.cacheKey, entry.kind, entry.body, entry.errorCode, entry.expiresAt);
}
