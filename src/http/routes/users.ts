import type { FastifyPluginAsync } from "fastify";
import { listUserPosts } from "../../core/timeline.js";
import { requireAuth } from "../auth.js";
import { sendErr, sendOk } from "../envelope.js";

export const USER_POSTS_PATH = "/v1/users/:handle/posts" as const;

type UserParams = {
  handle: string;
};

type UserQuerystring = {
  cursor?: string;
  limit?: string;
};

export const userRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Params: UserParams; Querystring: UserQuerystring }>(
    USER_POSTS_PATH,
    { preHandler: requireAuth },
    async (request, reply) => {
      const key = request.apiKey;
      if (key === undefined) {
        return sendErr(reply, "internal", "Authenticated route missing key.");
      }
      const result = await listUserPosts({
        db: request.server.db,
        adapter: request.server.adapter,
        key,
        query: {
          handle: request.params.handle,
          cursor: request.query.cursor,
          limit: request.query.limit,
        },
      });
      if ("error" in result) {
        return sendErr(
          reply,
          result.error.code,
          result.error.message,
          result.meta.requestId,
        );
      }
      return sendOk(reply, result.data, result.meta);
    },
  );
};
