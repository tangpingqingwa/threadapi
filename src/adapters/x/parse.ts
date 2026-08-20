import type { XEngagement, XMedia, XPost, XUser } from "../../types.js";
import type {
  AdapterFailureCode,
  ConversationResult,
  FetchPostResult,
  SearchResult,
  TimelineResult,
} from "../types.js";

/** Versioned live shape. Unknown HTML/JSON is noise, not a best-effort scrape. */
export const LIVE_X_ADAPTER_VERSION = "syndication-v1";

const BLOCKED_MARKERS = [
  "just a moment",
  "attention required",
  "captcha",
  "cf-browser-verification",
  "something went wrong",
  "rate limit",
  "temporarily restricted",
];

export function looksLikeHtml(body: string, contentType = ""): boolean {
  const type = contentType.toLowerCase();
  if (type.includes("text/html") || type.includes("application/xhtml")) {
    return true;
  }
  const head = body.trimStart().slice(0, 200).toLowerCase();
  return head.startsWith("<!doctype") || head.startsWith("<html") || head.startsWith("<head");
}

export function looksBlocked(body: string): boolean {
  const lower = body.toLowerCase();
  return BLOCKED_MARKERS.some((marker) => lower.includes(marker));
}

export function classifyPostHttp(status: number, body: string, _contentType = ""): AdapterFailureCode {
  if (status === 404 || status === 410) {
    return "post_not_found";
  }
  if (status === 403 && isProtectedPayload(body)) {
    return "protected_user";
  }
  return "upstream_blocked";
}

export function classifyUserHttp(status: number, body: string, _contentType = ""): AdapterFailureCode {
  if (status === 404 || status === 410) {
    return "user_not_found";
  }
  if (status === 403 && isProtectedPayload(body)) {
    return "protected_user";
  }
  return "upstream_blocked";
}

export function parseFetchPost(body: string, contentType = ""): FetchPostResult {
  if (looksLikeHtml(body, contentType) || looksBlocked(body)) {
    return { ok: false, code: "upstream_blocked" };
  }
  const raw = parseJson(body);
  if (raw === undefined) {
    return { ok: false, code: "upstream_blocked" };
  }
  if (isProtectedPayloadValue(raw)) {
    return { ok: false, code: "protected_user" };
  }
  if (isDeletedPayload(raw)) {
    return { ok: false, code: "post_not_found" };
  }
  const tweet = extractSingleTweet(raw);
  if (tweet === undefined) {
    return { ok: false, code: "upstream_blocked" };
  }
  const mapped = mapTweet(tweet, true);
  if (mapped === "protected") {
    return { ok: false, code: "protected_user" };
  }
  if (mapped === "not_found") {
    return { ok: false, code: "post_not_found" };
  }
  if (mapped === "noise") {
    return { ok: false, code: "upstream_blocked" };
  }
  return { ok: true, post: mapped };
}

export function parseConversation(
  rootId: string,
  documents: ReadonlyArray<{ id: string; status: number; body: string; contentType?: string }>,
): ConversationResult {
  const byId = new Map<string, FetchPostResult>();
  for (const doc of documents) {
    if (doc.status !== 200) {
      byId.set(doc.id, { ok: false, code: classifyPostHttp(doc.status, doc.body, doc.contentType) });
      continue;
    }
    byId.set(doc.id, parseFetchPost(doc.body, doc.contentType ?? ""));
  }

  const root = byId.get(rootId);
  if (root === undefined) {
    return { ok: false, code: "upstream_blocked" };
  }
  if (!root.ok) {
    return { ok: false, code: root.code };
  }

  const listed = collectConversationIds(rootId, documents);
  const posts: XPost[] = [root.post];
  const missingIds: string[] = [];
  const seen = new Set<string>([rootId]);

  for (const id of listed) {
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    const result = byId.get(id);
    if (result === undefined) {
      missingIds.push(id);
      continue;
    }
    if (!result.ok) {
      if (result.code === "post_not_found") {
        missingIds.push(id);
        continue;
      }
      return { ok: false, code: result.code };
    }
    if (result.post.author.id !== root.post.author.id) {
      continue;
    }
    posts.push(result.post);
  }

  return { ok: true, author: root.post.author, posts, missingIds };
}

export function listedConversationIds(rootId: string, body: string): string[] {
  const raw = parseJson(body);
  if (raw === undefined || !isRecord(raw)) {
    return [rootId];
  }
  return collectIdsFromValue(rootId, raw);
}

export function parseTimeline(handle: string, body: string, contentType = ""): TimelineResult {
  if (looksLikeHtml(body, contentType) || looksBlocked(body)) {
    return { ok: false, code: "upstream_blocked" };
  }
  const raw = parseJson(body);
  if (raw === undefined || !isRecord(raw)) {
    return { ok: false, code: "upstream_blocked" };
  }
  if (isProtectedPayloadValue(raw)) {
    return { ok: false, code: "protected_user" };
  }
  if (isUserMissingPayload(raw)) {
    return { ok: false, code: "user_not_found" };
  }

  const userRaw = firstRecord(raw.user, raw.author);
  const postsRaw = firstArray(raw.posts, raw.tweets, raw.items);
  if (postsRaw === undefined) {
    return { ok: false, code: "upstream_blocked" };
  }

  const posts: XPost[] = [];
  for (const item of postsRaw) {
    const mapped = mapTweet(item, true);
    if (mapped === "noise") {
      return { ok: false, code: "upstream_blocked" };
    }
    if (mapped === "protected") {
      return { ok: false, code: "protected_user" };
    }
    if (mapped === "not_found") {
      continue;
    }
    posts.push(mapped);
  }

  const user = userRaw !== undefined ? mapUser(userRaw) : posts[0]?.author;
  if (user === undefined || user === "noise") {
    return { ok: false, code: "upstream_blocked" };
  }
  if (normalizeHandle(user.handle) !== normalizeHandle(handle)) {
    return { ok: false, code: "upstream_blocked" };
  }

  const nextCursor = readOptionalString(raw.nextCursor) ?? null;
  return { ok: true, page: { user, posts, nextCursor } };
}

export function parseSearch(q: string, body: string, contentType = ""): SearchResult {
  if (looksLikeHtml(body, contentType) || looksBlocked(body)) {
    return { ok: false, code: "upstream_blocked" };
  }
  const raw = parseJson(body);
  if (raw === undefined || !isRecord(raw)) {
    return { ok: false, code: "upstream_blocked" };
  }

  const postsRaw = firstArray(raw.posts, raw.tweets, raw.items);
  if (postsRaw === undefined) {
    return { ok: false, code: "upstream_blocked" };
  }

  const posts: XPost[] = [];
  for (const item of postsRaw) {
    const mapped = mapTweet(item, true);
    if (mapped === "noise") {
      return { ok: false, code: "upstream_blocked" };
    }
    if (mapped === "protected" || mapped === "not_found") {
      continue;
    }
    posts.push(mapped);
  }

  const nextCursor = readOptionalString(raw.nextCursor) ?? null;
  return { ok: true, page: { query: q, posts, nextCursor } };
}

type MappedTweet = XPost | "noise" | "protected" | "not_found";

function extractSingleTweet(raw: unknown): unknown {
  if (!isRecord(raw)) {
    return undefined;
  }
  if (hasTweetFields(raw)) {
    return raw;
  }
  if (isRecord(raw.tweet) && hasTweetFields(raw.tweet)) {
    return raw.tweet;
  }
  if (isRecord(raw.data) && hasTweetFields(raw.data)) {
    return raw.data;
  }
  const tweets = firstArray(raw.tweets, raw.posts);
  if (tweets !== undefined && tweets.length === 1) {
    return tweets[0];
  }
  return undefined;
}

function hasTweetFields(value: Record<string, unknown>): boolean {
  return readTweetId(value) !== undefined;
}

function mapTweet(raw: unknown, includeQuote: boolean): MappedTweet {
  if (!isRecord(raw)) {
    return "noise";
  }
  if (isProtectedPayloadValue(raw)) {
    return "protected";
  }
  if (isDeletedPayload(raw)) {
    return "not_found";
  }

  const id = readTweetId(raw);
  if (id === undefined) {
    return "noise";
  }
  if (typeof raw.text !== "string" && typeof raw.full_text !== "string") {
    return "noise";
  }
  const text = typeof raw.text === "string" ? raw.text : String(raw.full_text);
  const createdAt = readCreatedAt(raw);
  if (createdAt === undefined) {
    return "noise";
  }

  const userRaw = firstRecord(raw.user, raw.author);
  if (userRaw === undefined) {
    return "noise";
  }
  const author = mapUser(userRaw);
  if (author === "noise") {
    return "noise";
  }
  if (userRaw.protected === true) {
    return "protected";
  }

  let quote: XPost | null = null;
  if (includeQuote) {
    const quoted = firstRecord(raw.quoted_tweet, raw.quote, raw.quotedPost);
    if (quoted !== undefined) {
      const mappedQuote = mapTweet(quoted, false);
      if (mappedQuote === "noise") {
        return "noise";
      }
      if (mappedQuote !== "protected" && mappedQuote !== "not_found") {
        quote = { ...mappedQuote, quote: null };
      }
    }
  }

  const lang = readOptionalString(raw.lang) ?? null;
  const replyToId =
    readOptionalString(raw.replyToId) ??
    readOptionalString(raw.in_reply_to_status_id_str) ??
    readOptionalString(raw.in_reply_to_status_id) ??
    null;

  return {
    id,
    author,
    text,
    createdAt,
    lang,
    replyToId,
    quote,
    media: readMedia(raw),
    engagement: readEngagement(raw),
    permalink: `https://x.com/${author.handle}/status/${id}`,
  };
}

function mapUser(raw: Record<string, unknown>): XUser | "noise" {
  const id = readUserId(raw);
  const handle = readRequiredString(raw.handle, raw.screen_name, raw.username);
  const name = readRequiredString(raw.name);
  if (id === undefined || handle === undefined || name === undefined) {
    return "noise";
  }
  let verified: boolean | null = null;
  if (typeof raw.verified === "boolean") {
    verified = raw.verified;
  } else if (typeof raw.is_blue_verified === "boolean") {
    verified = raw.is_blue_verified;
  }
  return { id, handle, name, verified };
}

function readMedia(raw: Record<string, unknown>): XMedia[] {
  const out: XMedia[] = [];
  const photos = firstArray(raw.photos, raw.media);
  if (photos !== undefined) {
    for (const item of photos) {
      const media = mapMedia(item);
      if (media !== undefined) {
        out.push(media);
      }
    }
  }
  if (isRecord(raw.video)) {
    const video = mapMedia({ ...raw.video, type: raw.video.type ?? "video" });
    if (video !== undefined) {
      out.push(video);
    }
  }
  if (isRecord(raw.entities) && Array.isArray(raw.entities.media)) {
    for (const item of raw.entities.media) {
      const media = mapMedia(item);
      if (media !== undefined && !out.some((existing) => existing.url === media.url)) {
        out.push(media);
      }
    }
  }
  return out;
}

function mapMedia(raw: unknown): XMedia | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  const url = readRequiredString(raw.url, raw.media_url_https, raw.src);
  if (url === undefined || !/^https?:\/\//i.test(url)) {
    return undefined;
  }
  const typeRaw = (readRequiredString(raw.type) ?? "photo").toLowerCase();
  const type: XMedia["type"] =
    typeRaw === "video" || typeRaw === "animated_gif" || typeRaw === "gif"
      ? typeRaw === "animated_gif"
        ? "gif"
        : typeRaw === "gif"
          ? "gif"
          : "video"
      : "photo";
  const previewUrl = readRequiredString(raw.previewUrl, raw.poster, raw.preview_image_url);
  return previewUrl === undefined ? { type, url } : { type, url, previewUrl };
}

function readEngagement(raw: Record<string, unknown>): XEngagement {
  const nested = isRecord(raw.engagement) ? raw.engagement : raw;
  return {
    replies: readOptionalNumber(nested.replies) ?? readOptionalNumber(nested.reply_count),
    reposts: readOptionalNumber(nested.reposts) ?? readOptionalNumber(nested.retweet_count),
    likes: readOptionalNumber(nested.likes) ?? readOptionalNumber(nested.favorite_count),
  };
}

function collectConversationIds(
  rootId: string,
  documents: ReadonlyArray<{ id: string; body: string }>,
): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  const push = (id: string): void => {
    if (seen.has(id)) {
      return;
    }
    seen.add(id);
    ids.push(id);
  };
  push(rootId);
  for (const doc of documents) {
    const raw = parseJson(doc.body);
    if (raw === undefined || !isRecord(raw)) {
      continue;
    }
    for (const id of collectIdsFromValue(rootId, raw)) {
      push(id);
    }
  }
  return ids;
}

function collectIdsFromValue(rootId: string, raw: Record<string, unknown>): string[] {
  const ids: string[] = [rootId];
  const listed = firstArray(
    isRecord(raw.conversation) ? raw.conversation.ids : undefined,
    isRecord(raw.self_thread) ? raw.self_thread.ids : undefined,
    raw.ids,
  );
  if (listed !== undefined) {
    for (const item of listed) {
      if (typeof item === "string" && /^\d+$/.test(item)) {
        ids.push(item);
      }
    }
  }
  const tweets = firstArray(raw.tweets, raw.posts);
  if (tweets !== undefined) {
    for (const item of tweets) {
      if (isRecord(item)) {
        const id = readTweetId(item);
        if (id !== undefined) {
          ids.push(id);
        }
      }
    }
  }
  return ids;
}

function isProtectedPayload(body: string): boolean {
  const raw = parseJson(body);
  return raw !== undefined && isProtectedPayloadValue(raw);
}

function isProtectedPayloadValue(raw: unknown): boolean {
  if (!isRecord(raw)) {
    return false;
  }
  if (raw.protected === true || raw.visibility === "protected") {
    return true;
  }
  if (isRecord(raw.user) && raw.user.protected === true) {
    return true;
  }
  if (isRecord(raw.error) && raw.error.code === "protected_user") {
    return true;
  }
  if (raw.code === "protected_user") {
    return true;
  }
  if (isLimitedVisibilityTombstone(raw)) {
    return true;
  }
  return false;
}

function isDeletedPayload(raw: unknown): boolean {
  if (!isRecord(raw)) {
    return false;
  }
  if (isLimitedVisibilityTombstone(raw)) {
    return false;
  }
  if (raw.tombstone !== undefined && raw.tombstone !== null) {
    return true;
  }
  if (raw.code === "post_not_found" || raw.code === "not_found") {
    return true;
  }
  if (isRecord(raw.error) && (raw.error.code === "post_not_found" || raw.error.code === "not_found")) {
    return true;
  }
  return false;
}

function readTombstoneText(raw: Record<string, unknown>): string {
  const tombstone = raw.tombstone;
  if (typeof tombstone === "string") {
    return tombstone;
  }
  if (!isRecord(tombstone)) {
    return "";
  }
  if (typeof tombstone.text === "string") {
    return tombstone.text;
  }
  if (isRecord(tombstone.text) && typeof tombstone.text.text === "string") {
    return tombstone.text.text;
  }
  return "";
}

/** Live syndication uses a tombstone, not HTTP 403, for protected authors. */
function isLimitedVisibilityTombstone(raw: Record<string, unknown>): boolean {
  const text = readTombstoneText(raw).toLowerCase();
  return (
    text.includes("limits who can view") ||
    text.includes("protected account") ||
    text.includes("these posts are protected")
  );
}

function isUserMissingPayload(raw: unknown): boolean {
  if (!isRecord(raw)) {
    return false;
  }
  return raw.code === "user_not_found" || (isRecord(raw.error) && raw.error.code === "user_not_found");
}

function readTweetId(raw: Record<string, unknown>): string | undefined {
  const value = raw.id_str ?? raw.id;
  if (typeof value === "string" && /^\d+$/.test(value)) {
    return value;
  }
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return String(value);
  }
  return undefined;
}

function readUserId(raw: Record<string, unknown>): string | undefined {
  const value = raw.id_str ?? raw.id;
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed === "" ? undefined : trimmed;
  }
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return String(value);
  }
  return undefined;
}

function readCreatedAt(raw: Record<string, unknown>): string | undefined {
  const value = raw.createdAt ?? raw.created_at;
  if (typeof value !== "string" || value.trim() === "") {
    return undefined;
  }
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) {
    return undefined;
  }
  return new Date(ms).toISOString();
}

function readRequiredString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed !== "") {
        return trimmed;
      }
    }
  }
  return undefined;
}

function readOptionalString(value: unknown): string | null | undefined {
  if (value === null) {
    return null;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function readOptionalNumber(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return value;
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return undefined;
  }
}

function firstRecord(...values: unknown[]): Record<string, unknown> | undefined {
  for (const value of values) {
    if (isRecord(value)) {
      return value;
    }
  }
  return undefined;
}

function firstArray(...values: unknown[]): unknown[] | undefined {
  for (const value of values) {
    if (Array.isArray(value)) {
      return value;
    }
  }
  return undefined;
}

function normalizeHandle(handle: string): string {
  return handle.trim().replace(/^@+/, "").toLowerCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
