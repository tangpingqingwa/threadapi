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

export type Ok<T> = {
  data: T;
  meta: { cached: boolean; creditsCharged: number; requestId: string; upstreamMs: number };
};

export type Err = {
  error: { code: ErrorCode; message: string; retryable: boolean };
  meta: { creditsCharged: 0; requestId: string };
};
