export type ErrorCode =
  | "invalid_request"
  | "unauthorized"
  | "payment_required"
  | "protected_user"
  | "not_found"
  | "user_not_found"
  | "post_not_found"
  | "rate_limited"
  | "upstream_blocked"
  | "internal";

export const ERROR_CODES: readonly ErrorCode[] = [
  "invalid_request",
  "unauthorized",
  "payment_required",
  "protected_user",
  "not_found",
  "user_not_found",
  "post_not_found",
  "rate_limited",
  "upstream_blocked",
  "internal",
];

export type MediaType = "photo" | "video" | "gif";

export type XUser = {
  id: string;
  handle: string;
  name: string;
  verified: boolean | null;
};

export type XMedia = {
  type: MediaType;
  url: string;
  previewUrl?: string;
};

export type XEngagement = {
  replies: number | null;
  reposts: number | null;
  likes: number | null;
};

export type XPost = {
  id: string;
  author: XUser;
  text: string;
  createdAt: string;
  lang: string | null;
  replyToId: string | null;
  quote: XPost | null;
  media: XMedia[];
  engagement: XEngagement;
  permalink: string;
};

export type Thread = {
  rootId: string;
  author: XUser;
  posts: XPost[];
  missingIds: string[];
};

export type Ok<T> = {
  data: T;
  meta: { cached: boolean; creditsCharged: number; requestId: string; upstreamMs: number };
};

export type Err = {
  error: { code: ErrorCode; message: string; retryable: boolean };
  meta: { creditsCharged: 0; requestId: string };
};
