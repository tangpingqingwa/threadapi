import type {
  ConversationResult,
  FetchPostResult,
  SearchResult,
  TimelineRequest,
  TimelineResult,
  XAdapter,
} from "../types.js";
import {
  classifyPostHttp,
  classifyUserHttp,
  listedConversationIds,
  LIVE_X_ADAPTER_VERSION,
  parseConversation,
  parseFetchPost,
  parseTimeline,
} from "./parse.js";

export { LIVE_X_ADAPTER_VERSION } from "./parse.js";

/** Public syndication host. Official API hosts stay out of this adapter. */
export const LIVE_X_SYNDICATION_ORIGIN = "https://cdn.syndication.twimg.com";

export type LiveXHttpResponse = {
  status: number;
  body: string;
  contentType?: string;
};

export type LiveXFetch = (url: string) => Promise<LiveXHttpResponse>;

export type LiveXAdapterOptions = {
  fetch?: LiveXFetch;
  origin?: string;
};

/**
 * Versioned live X adapter. Env-gated by createAppAdapter.
 * Unrecognised HTML/JSON is `upstream_blocked`. Never invent tweet text.
 */
export function createLiveXAdapter(options: LiveXAdapterOptions = {}): XAdapter {
  const origin = (options.origin ?? LIVE_X_SYNDICATION_ORIGIN).replace(/\/+$/, "");
  const get = options.fetch ?? defaultFetch;

  return {
    async fetchPost(id: string): Promise<FetchPostResult> {
      const response = await get(tweetUrl(origin, id));
      if (response.status !== 200) {
        return { ok: false, code: classifyPostHttp(response.status, response.body, response.contentType) };
      }
      return parseFetchPost(response.body, response.contentType ?? "");
    },
    async fetchConversation(rootId: string): Promise<ConversationResult> {
      const root = await get(tweetUrl(origin, rootId));
      const documents = [{ id: rootId, ...root }];
      if (root.status === 200) {
        const ids = listedConversationIds(rootId, root.body);
        for (const id of ids) {
          if (id === rootId) {
            continue;
          }
          const child = await get(tweetUrl(origin, id));
          documents.push({ id, ...child });
        }
      }
      return parseConversation(rootId, documents);
    },
    async fetchTimeline(request: TimelineRequest): Promise<TimelineResult> {
      const response = await get(timelineUrl(origin, request.handle, request.cursor, request.limit));
      if (response.status !== 200) {
        return { ok: false, code: classifyUserHttp(response.status, response.body, response.contentType) };
      }
      return parseTimeline(request.handle, response.body, response.contentType ?? "");
    },
    async search(): Promise<SearchResult> {
      // No versioned live search shape yet. Do not scrape HTML or invent hits.
      return { ok: false, code: "upstream_blocked" };
    },
  };
}

/** Same public token react-tweet / platform embeds send. Not a secret. */
export function syndicationTweetToken(id: string): string {
  const n = Number(id);
  if (!Number.isFinite(n)) {
    return "0";
  }
  return ((n / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, "");
}

function tweetUrl(origin: string, id: string): string {
  const params = new URLSearchParams({
    id,
    lang: "en",
    token: syndicationTweetToken(id),
  });
  return `${origin}/tweet-result?${params.toString()}`;
}

function timelineUrl(origin: string, handle: string, cursor: string | undefined, limit: number): string {
  const params = new URLSearchParams({
    screen_name: handle.replace(/^@+/, ""),
    limit: String(limit),
  });
  if (cursor !== undefined && cursor !== "") {
    params.set("cursor", cursor);
  }
  return `${origin}/timeline/profile?${params.toString()}`;
}

async function defaultFetch(url: string): Promise<LiveXHttpResponse> {
  try {
    const response = await globalThis.fetch(url, {
      method: "GET",
      redirect: "manual",
      headers: {
        accept: "application/json,text/plain;q=0.9,*/*;q=0.1",
        "user-agent": `threadapi-live/${LIVE_X_ADAPTER_VERSION}`,
      },
    });
    return {
      status: response.status,
      body: await response.text(),
      contentType: response.headers.get("content-type") ?? undefined,
    };
  } catch {
    return { status: 503, body: "", contentType: "text/plain" };
  }
}
