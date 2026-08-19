import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SearchPage, UserPostsPage, XEngagement, XMedia, XPost, XUser } from "../../types.js";
import type {
  ConversationResult,
  FetchPostResult,
  SearchRequest,
  SearchResult,
  TimelineRequest,
  TimelineResult,
  XAdapter,
} from "../types.js";

export const DEFAULT_FIXTURE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../tests/fixtures/catalog.json",
);

export type FixtureUser = XUser & {
  protected?: boolean;
};

export type FixturePostRecord = {
  id: string;
  authorId: string;
  text: string;
  createdAt: string;
  lang: string | null;
  replyToId: string | null;
  quoteId: string | null;
  media: XMedia[];
  engagement: XEngagement;
};

export type FixtureCatalog = {
  users: Record<string, FixtureUser>;
  posts: Record<string, FixturePostRecord>;
  conversations: Record<string, { ids: string[] }>;
  deletedIds: string[];
};

export type FixtureAdapterOptions = {
  path?: string;
  catalog?: FixtureCatalog;
};

export function createFixtureAdapter(
  options: FixtureAdapterOptions = {},
): XAdapter {
  const catalog = options.catalog ?? loadFixtureCatalog(options.path ?? DEFAULT_FIXTURE_PATH);
  const deleted = new Set(catalog.deletedIds);

  return {
    async fetchPost(id: string): Promise<FetchPostResult> {
      return readPost(catalog, deleted, id);
    },
    async fetchConversation(rootId: string): Promise<ConversationResult> {
      const root = readPost(catalog, deleted, rootId);
      if (!root.ok) {
        return root;
      }
      const listed = catalog.conversations[rootId]?.ids ?? [];
      const posts: XPost[] = [root.post];
      const missingIds: string[] = [];
      const seen = new Set<string>([rootId]);
      for (const id of listed) {
        if (seen.has(id)) {
          continue;
        }
        seen.add(id);
        const result = readPost(catalog, deleted, id);
        if (!result.ok) {
          if (result.code === "post_not_found") {
            missingIds.push(id);
            continue;
          }
          return result;
        }
        if (result.post.author.id !== root.post.author.id) {
          continue;
        }
        posts.push(result.post);
      }
      return { ok: true, author: root.post.author, posts, missingIds };
    },
    async fetchTimeline(request: TimelineRequest): Promise<TimelineResult> {
      return readTimeline(catalog, deleted, request);
    },
    async search(request: SearchRequest): Promise<SearchResult> {
      return readSearch(catalog, deleted, request);
    },
  };
}

export function loadFixtureCatalog(path: string): FixtureCatalog {
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  return parseCatalog(raw, path);
}

function readPost(
  catalog: FixtureCatalog,
  deleted: Set<string>,
  id: string,
): FetchPostResult {
  if (deleted.has(id) || catalog.posts[id] === undefined) {
    return { ok: false, code: "post_not_found" };
  }
  const record = catalog.posts[id];
  const author = catalog.users[record.authorId];
  if (author === undefined) {
    return { ok: false, code: "user_not_found" };
  }
  if (author.protected === true) {
    return { ok: false, code: "protected_user" };
  }
  return { ok: true, post: toXPost(catalog, deleted, record, true) };
}

function readTimeline(
  catalog: FixtureCatalog,
  deleted: Set<string>,
  request: TimelineRequest,
): TimelineResult {
  const user = findUserByHandle(catalog, request.handle);
  if (user === undefined) {
    return { ok: false, code: "user_not_found" };
  }
  if (user.protected === true) {
    return { ok: false, code: "protected_user" };
  }

  const start = parseOffsetCursor(request.cursor);
  if (start === null) {
    return { ok: false, code: "user_not_found" };
  }

  const authored = Object.values(catalog.posts)
    .filter((record) => record.authorId === user.id && !deleted.has(record.id))
    .sort(compareTimelinePosts)
    .map((record) => toXPost(catalog, deleted, record, true));

  const posts = authored.slice(start, start + request.limit);
  const nextOffset = start + request.limit;
  const page: UserPostsPage = {
    user: publicUser(user),
    posts,
    nextCursor: nextOffset < authored.length ? String(nextOffset) : null,
  };
  return { ok: true, page };
}

function readSearch(
  catalog: FixtureCatalog,
  deleted: Set<string>,
  request: SearchRequest,
): SearchResult {
  const start = parseOffsetCursor(request.cursor);
  if (start === null) {
    return { ok: true, page: { query: request.q, posts: [], nextCursor: null } };
  }

  const tokens = tokenizeQuery(request.q);
  const hits = Object.values(catalog.posts)
    .filter((record) => {
      if (deleted.has(record.id)) {
        return false;
      }
      const author = catalog.users[record.authorId];
      if (author === undefined || author.protected === true) {
        return false;
      }
      return matchesQuery(record, author, tokens);
    })
    .sort(compareTimelinePosts)
    .map((record) => toXPost(catalog, deleted, record, true));

  const posts = hits.slice(start, start + request.limit);
  const nextOffset = start + request.limit;
  const page: SearchPage = {
    query: request.q,
    posts,
    nextCursor: nextOffset < hits.length ? String(nextOffset) : null,
  };
  return { ok: true, page };
}

function tokenizeQuery(q: string): string[] {
  return q
    .toLowerCase()
    .split(/\s+/)
    .map((token) => token.replace(/^[@#]+/, ""))
    .filter((token) => token.length > 0);
}

function matchesQuery(record: FixturePostRecord, author: FixtureUser, tokens: string[]): boolean {
  if (tokens.length === 0) {
    return false;
  }
  const haystack = `${record.text} ${author.handle} ${author.name}`.toLowerCase();
  return tokens.every((token) => haystack.includes(token));
}

function findUserByHandle(catalog: FixtureCatalog, handle: string): FixtureUser | undefined {
  const needle = normalizeHandle(handle);
  if (needle === null) {
    return undefined;
  }
  return Object.values(catalog.users).find((user) => user.handle.toLowerCase() === needle);
}

export function normalizeHandle(handle: string): string | null {
  const normalized = handle.trim().replace(/^@+/, "").toLowerCase();
  return normalized === "" ? null : normalized;
}

function parseOffsetCursor(cursor: string | undefined): number | null {
  if (cursor === undefined || cursor === "") {
    return 0;
  }
  if (!/^\d+$/.test(cursor)) {
    return null;
  }
  return Number(cursor);
}

function compareTimelinePosts(a: FixturePostRecord, b: FixturePostRecord): number {
  const byTime = Date.parse(b.createdAt) - Date.parse(a.createdAt);
  if (byTime !== 0) {
    return byTime;
  }
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

function toXPost(
  catalog: FixtureCatalog,
  deleted: Set<string>,
  record: FixturePostRecord,
  includeQuote: boolean,
): XPost {
  const author = catalog.users[record.authorId];
  if (author === undefined) {
    throw new Error(`fixture post ${record.id} references unknown author`);
  }
  let quote: XPost | null = null;
  if (includeQuote && record.quoteId !== null) {
    const quoted = catalog.posts[record.quoteId];
    if (quoted !== undefined && !deleted.has(record.quoteId)) {
      const quotedAuthor = catalog.users[quoted.authorId];
      if (quotedAuthor !== undefined && quotedAuthor.protected !== true) {
        quote = toXPost(catalog, deleted, quoted, false);
      }
    }
  }
  return {
    id: record.id,
    author: publicUser(author),
    text: record.text,
    createdAt: record.createdAt,
    lang: record.lang,
    replyToId: record.replyToId,
    quote,
    media: record.media.map(cloneMedia),
    engagement: { ...record.engagement },
    permalink: `https://x.com/${author.handle}/status/${record.id}`,
  };
}

function publicUser(user: FixtureUser): XUser {
  return {
    id: user.id,
    handle: user.handle,
    name: user.name,
    verified: user.verified,
  };
}

function cloneMedia(item: XMedia): XMedia {
  return item.previewUrl === undefined
    ? { type: item.type, url: item.url }
    : { type: item.type, url: item.url, previewUrl: item.previewUrl };
}

function parseCatalog(raw: unknown, path: string): FixtureCatalog {
  if (!isRecord(raw)) {
    throw new Error(`fixture ${path} must be an object`);
  }
  if (!isRecord(raw.users)) {
    throw new Error(`fixture ${path} users must be an object`);
  }
  if (!isRecord(raw.posts)) {
    throw new Error(`fixture ${path} posts must be an object`);
  }
  if (!isRecord(raw.conversations)) {
    throw new Error(`fixture ${path} conversations must be an object`);
  }
  if (!Array.isArray(raw.deletedIds) || raw.deletedIds.some((id) => typeof id !== "string")) {
    throw new Error(`fixture ${path} deletedIds must be string[]`);
  }
  const users: Record<string, FixtureUser> = {};
  for (const [key, value] of Object.entries(raw.users)) {
    users[key] = parseUser(value, path, key);
  }
  const posts: Record<string, FixturePostRecord> = {};
  for (const [key, value] of Object.entries(raw.posts)) {
    const post = parsePost(value, path, key);
    if (posts[post.id] !== undefined) {
      throw new Error(`fixture ${path} duplicate post id ${post.id}`);
    }
    posts[post.id] = post;
  }
  const conversations: Record<string, { ids: string[] }> = {};
  for (const [rootId, value] of Object.entries(raw.conversations)) {
    if (!isRecord(value) || !Array.isArray(value.ids) || value.ids.some((id) => typeof id !== "string")) {
      throw new Error(`fixture ${path} conversation ${rootId} ids must be string[]`);
    }
    conversations[rootId] = { ids: value.ids };
  }
  return { users, posts, conversations, deletedIds: raw.deletedIds };
}

function parseUser(value: unknown, path: string, key: string): FixtureUser {
  if (!isRecord(value)) {
    throw new Error(`fixture ${path} user ${key} must be an object`);
  }
  if (typeof value.id !== "string" || value.id === "") {
    throw new Error(`fixture ${path} user ${key} id is required`);
  }
  if (typeof value.handle !== "string" || value.handle === "") {
    throw new Error(`fixture ${path} user ${key} handle is required`);
  }
  if (typeof value.name !== "string") {
    throw new Error(`fixture ${path} user ${key} name is required`);
  }
  if (value.verified !== null && typeof value.verified !== "boolean") {
    throw new Error(`fixture ${path} user ${key} verified must be boolean|null`);
  }
  if (value.protected !== undefined && typeof value.protected !== "boolean") {
    throw new Error(`fixture ${path} user ${key} protected must be boolean`);
  }
  return {
    id: value.id,
    handle: value.handle,
    name: value.name,
    verified: value.verified,
    protected: value.protected,
  };
}

function parsePost(value: unknown, path: string, key: string): FixturePostRecord {
  if (!isRecord(value)) {
    throw new Error(`fixture ${path} post ${key} must be an object`);
  }
  if (typeof value.id !== "string" || value.id === "") {
    throw new Error(`fixture ${path} post ${key} id is required`);
  }
  if (typeof value.authorId !== "string" || value.authorId === "") {
    throw new Error(`fixture ${path} post ${key} authorId is required`);
  }
  if (typeof value.text !== "string") {
    throw new Error(`fixture ${path} post ${key} text must be a string`);
  }
  if (typeof value.createdAt !== "string" || value.createdAt === "") {
    throw new Error(`fixture ${path} post ${key} createdAt is required`);
  }
  if (value.lang !== null && typeof value.lang !== "string") {
    throw new Error(`fixture ${path} post ${key} lang must be string|null`);
  }
  if (value.replyToId !== null && typeof value.replyToId !== "string") {
    throw new Error(`fixture ${path} post ${key} replyToId must be string|null`);
  }
  if (value.quoteId !== null && typeof value.quoteId !== "string") {
    throw new Error(`fixture ${path} post ${key} quoteId must be string|null`);
  }
  if (!Array.isArray(value.media)) {
    throw new Error(`fixture ${path} post ${key} media must be an array`);
  }
  if (!isRecord(value.engagement)) {
    throw new Error(`fixture ${path} post ${key} engagement is required`);
  }
  return {
    id: value.id,
    authorId: value.authorId,
    text: value.text,
    createdAt: value.createdAt,
    lang: value.lang,
    replyToId: value.replyToId,
    quoteId: value.quoteId,
    media: value.media.map((item, index) => parseMedia(item, path, key, index)),
    engagement: parseEngagement(value.engagement, path, key),
  };
}

function parseMedia(
  value: unknown,
  path: string,
  postId: string,
  index: number,
): XMedia {
  if (!isRecord(value)) {
    throw new Error(`fixture ${path} post ${postId} media[${index}] must be an object`);
  }
  if (value.type !== "photo" && value.type !== "video" && value.type !== "gif") {
    throw new Error(`fixture ${path} post ${postId} media[${index}] has invalid type`);
  }
  if (typeof value.url !== "string" || value.url === "") {
    throw new Error(`fixture ${path} post ${postId} media[${index}] url is required`);
  }
  if (value.previewUrl !== undefined && typeof value.previewUrl !== "string") {
    throw new Error(
      `fixture ${path} post ${postId} media[${index}] previewUrl must be a string`,
    );
  }
  return value.previewUrl === undefined
    ? { type: value.type, url: value.url }
    : { type: value.type, url: value.url, previewUrl: value.previewUrl };
}

function parseEngagement(value: Record<string, unknown>, path: string, postId: string): XEngagement {
  const replies = nullableNumber(value.replies, `${path} post ${postId} engagement.replies`);
  const reposts = nullableNumber(value.reposts, `${path} post ${postId} engagement.reposts`);
  const likes = nullableNumber(value.likes, `${path} post ${postId} engagement.likes`);
  return { replies, reposts, likes };
}

function nullableNumber(value: unknown, label: string): number | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} must be number|null`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
