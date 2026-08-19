import type { FastifyPluginAsync } from "fastify";
import { searchPosts } from "../../core/search.js";
import { requireAuth } from "../auth.js";
import { sendErr, sendOk } from "../envelope.js";

export const SEARCH_PATH = "/v1/search" as const;

type SearchQuerystring = {
  q?: string;
  cursor?: string;
  limit?: string;
};

export const searchRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Querystring: SearchQuerystring }>(
    SEARCH_PATH,
    { preHandler: requireAuth },
    async (request, reply) => {
      const key = request.apiKey;
      if (key === undefined) {
        return sendErr(reply, "internal", "Authenticated route missing key.");
      }
      const result = await searchPosts({
        db: request.server.db,
        adapter: request.server.adapter,
        key,
        query: {
          q: request.query.q,
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
