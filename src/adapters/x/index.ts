import type { ConversationResult, FetchPostResult, XAdapter } from "../types.js";

/**
 * Live X path is a later PR. This stub implements the adapter contract
 * without opening a network socket.
 */
export function createLiveXAdapter(): XAdapter {
  return {
    async fetchPost(): Promise<FetchPostResult> {
      return { ok: false, code: "upstream_blocked" };
    },
    async fetchConversation(): Promise<ConversationResult> {
      return { ok: false, code: "upstream_blocked" };
    },
  };
}
