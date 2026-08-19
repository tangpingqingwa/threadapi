import type { FastifyPluginAsync } from "fastify";
import { unroll } from "../../core/thread.js";
import { requireAuth } from "../auth.js";
import { sendErr, sendOk } from "../envelope.js";

export const THREADS_BY_URL_PATH = "/v1/threads/by-url" as const;

type ThreadsQuerystring = {
  url?: string;
};

export const threadRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Querystring: ThreadsQuerystring }>(
    THREADS_BY_URL_PATH,
    { preHandler: requireAuth },
    async (request, reply) => {
      const key = request.apiKey;
      if (key === undefined) {
        return sendErr(reply, "internal", "Authenticated route missing key.");
      }
      const result = await unroll({
        db: request.server.db,
        adapter: request.server.adapter,
        key,
        url: request.query.url,
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
