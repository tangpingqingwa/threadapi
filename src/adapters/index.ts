import { resolveAdapterKind } from "../config.js";
import { createFixtureAdapter } from "./x/fixture.js";
import { createLiveXAdapter } from "./x/index.js";
import type { XAdapter } from "./types.js";

export type {
  AdapterFailureCode,
  ConversationErr,
  ConversationOk,
  ConversationResult,
  FetchPostErr,
  FetchPostOk,
  FetchPostResult,
  SearchErr,
  SearchOk,
  SearchRequest,
  SearchResult,
  TimelineErr,
  TimelineOk,
  TimelineRequest,
  TimelineResult,
  XAdapter,
} from "./types.js";
export { createFixtureAdapter } from "./x/fixture.js";
export { createLiveXAdapter } from "./x/index.js";

/** Fixture unless THREADAPI_LIVE=1 / THREADAPI_ADAPTER=live. CI sets THREADAPI_FIXTURE_ONLY=1. */
export function createAppAdapter(env: NodeJS.ProcessEnv = process.env): XAdapter {
  if (resolveAdapterKind(env) === "live") {
    return createLiveXAdapter();
  }
  return createFixtureAdapter();
}
