import type { XAdapter } from "../adapters/types.js";
import type { Key } from "../billing/keys.js";
import { searchPosts } from "../core/search.js";
import { getPost, isRetryableCode, unroll } from "../core/thread.js";
import { listUserPosts } from "../core/timeline.js";
import type { ThreadApiDb } from "../db.js";
import type { Err, ErrorCode, Ok } from "../types.js";

export const UNROLL_THREAD_TOOL = "unroll_thread" as const;
export const GET_POST_TOOL = "get_post" as const;
export const LIST_USER_POSTS_TOOL = "list_user_posts" as const;
export const SEARCH_X_TOOL = "search_x" as const;

export const MCP_TOOL_NAMES = [
  UNROLL_THREAD_TOOL,
  GET_POST_TOOL,
  LIST_USER_POSTS_TOOL,
  SEARCH_X_TOOL,
] as const;

export type McpToolName = (typeof MCP_TOOL_NAMES)[number];

export type McpToolDefinition = {
  name: McpToolName;
  description: string;
  inputSchema: Record<string, unknown>;
};

export type McpToolOutcome = Ok<unknown> | Err;

export type CallMcpToolInput = {
  name: string;
  args: Record<string, unknown>;
  db: ThreadApiDb;
  adapter: XAdapter;
  key: Key;
  requestId?: string;
};

export const MCP_TOOLS: readonly McpToolDefinition[] = [
  {
    name: UNROLL_THREAD_TOOL,
    description:
      "Expand a public X/Twitter thread to the root plus same-author self-replies. " +
      "Maps to GET /v1/threads/by-url. 1 credit on success, including cache hits. " +
      "Missing floors are listed in missingIds — never invent text. " +
      "Not for posting, private accounts, or a firehose.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["url"],
      properties: {
        url: {
          type: "string",
          description: "Public x.com or twitter.com status URL",
        },
      },
    },
  },
  {
    name: GET_POST_TOOL,
    description:
      "One public post plus an optional one-level quote. Maps to GET /v1/posts/{id}. " +
      "1 credit on success, including cache hits. Failures charge 0.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["id"],
      properties: {
        id: {
          type: "string",
          description: "Numeric post id",
        },
      },
    },
  },
  {
    name: LIST_USER_POSTS_TOOL,
    description:
      "One page of a public user timeline. Maps to GET /v1/users/{handle}/posts. " +
      "1 credit per page. Protected accounts return protected_user and charge 0. " +
      "Handle may include a leading @.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["handle"],
      properties: {
        handle: {
          type: "string",
          description: "Public X username, with or without @",
        },
        cursor: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 50 },
      },
    },
  },
  {
    name: SEARCH_X_TOOL,
    description:
      "Recent public posts matching a keyword query. Maps to GET /v1/search. " +
      "1 credit per page with hits (may become 2 if search COGS is high). " +
      "Empty pages charge 0. Not a full archive. Not a firehose.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["q"],
      properties: {
        q: {
          type: "string",
          description: "Keyword query over recent public posts",
        },
        cursor: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 50 },
      },
    },
  },
];

export function isMcpToolName(name: string): name is McpToolName {
  return (MCP_TOOL_NAMES as readonly string[]).includes(name);
}

/** Dispatch an MCP tool to core/* only. */
export async function callMcpTool(input: CallMcpToolInput): Promise<McpToolOutcome> {
  if (!isMcpToolName(input.name)) {
    return fail(
      "invalid_request",
      input.requestId,
      `Unknown MCP tool '${input.name}'.`,
    );
  }

  switch (input.name) {
    case UNROLL_THREAD_TOOL:
      return unroll({
        db: input.db,
        adapter: input.adapter,
        key: input.key,
        requestId: input.requestId,
        url: readStringArg(input.args, "url"),
      });
    case GET_POST_TOOL:
      return getPost({
        db: input.db,
        adapter: input.adapter,
        key: input.key,
        requestId: input.requestId,
        id: readStringArg(input.args, "id") ?? "",
      });
    case LIST_USER_POSTS_TOOL:
      return listUserPosts({
        db: input.db,
        adapter: input.adapter,
        key: input.key,
        requestId: input.requestId,
        query: {
          handle: readStringArg(input.args, "handle") ?? "",
          cursor: readStringArg(input.args, "cursor"),
          limit: readLimitArg(input.args),
        },
      });
    case SEARCH_X_TOOL:
      return searchPosts({
        db: input.db,
        adapter: input.adapter,
        key: input.key,
        requestId: input.requestId,
        query: {
          q: readStringArg(input.args, "q"),
          cursor: readStringArg(input.args, "cursor"),
          limit: readLimitArg(input.args),
        },
      });
  }
}

function fail(code: ErrorCode, requestId: string | undefined, message: string): Err {
  return {
    error: {
      code,
      message,
      retryable: isRetryableCode(code),
    },
    meta: { creditsCharged: 0, requestId: requestId ?? "req_mcp_unknown_tool" },
  };
}

function readStringArg(
  args: Record<string, unknown>,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string") {
      return value;
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
  }
  return undefined;
}

function readLimitArg(args: Record<string, unknown>): string | undefined {
  const value = args.limit;
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" && Number.isInteger(value)) {
    return String(value);
  }
  return undefined;
}
