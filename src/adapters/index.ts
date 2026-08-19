import { createFixtureAdapter } from "./x/fixture.js";
import type { XAdapter } from "./types.js";

export type {
  AdapterFailureCode,
  ConversationErr,
  ConversationOk,
  ConversationResult,
  FetchPostErr,
  FetchPostOk,
  FetchPostResult,
  TimelineErr,
  TimelineOk,
  TimelineRequest,
  TimelineResult,
  XAdapter,
} from "./types.js";
export { createFixtureAdapter } from "./x/fixture.js";
export { createLiveXAdapter } from "./x/index.js";

/** PR 2 wires the fixture adapter only. Live X is a later PR. */
export function createAppAdapter(): XAdapter {
  return createFixtureAdapter();
}
