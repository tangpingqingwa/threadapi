import type { UserPostsPage, XPost, XUser } from "../types.js";

export type AdapterFailureCode =
  | "post_not_found"
  | "protected_user"
  | "user_not_found"
  | "upstream_blocked";

export type FetchPostOk = {
  ok: true;
  post: XPost;
};

export type FetchPostErr = {
  ok: false;
  code: AdapterFailureCode;
};

export type FetchPostResult = FetchPostOk | FetchPostErr;

export type ConversationOk = {
  ok: true;
  author: XUser;
  posts: XPost[];
  /** Self-reply ids the adapter knows about but could not fetch. */
  missingIds: string[];
};

export type ConversationErr = {
  ok: false;
  code: AdapterFailureCode;
};

export type ConversationResult = ConversationOk | ConversationErr;

export type TimelineRequest = {
  handle: string;
  cursor?: string;
  limit: number;
};

export type TimelineOk = {
  ok: true;
  page: UserPostsPage;
};

export type TimelineErr = {
  ok: false;
  code: AdapterFailureCode;
};

export type TimelineResult = TimelineOk | TimelineErr;

export type XAdapter = {
  fetchPost(id: string): Promise<FetchPostResult>;
  fetchConversation(rootId: string): Promise<ConversationResult>;
  fetchTimeline(request: TimelineRequest): Promise<TimelineResult>;
};
