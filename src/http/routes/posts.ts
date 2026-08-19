import type { FastifyPluginAsync } from "fastify";
import { getPost } from "../../core/thread.js";
import { requireAuth } from "../auth.js";
import { sendErr, sendOk } from "../envelope.js";

export const POSTS_PATH = "/v1/posts/:id" as const;

type PostsParams = {
  id: string;
};

export const postRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Params: PostsParams }>(
    POSTS_PATH,
    { preHandler: requireAuth },
    async (request, reply) => {
      const key = request.apiKey;
      if (key === undefined) {
        return sendErr(reply, "internal", "Authenticated route missing key.");
      }
      const result = await getPost({
        db: request.server.db,
        adapter: request.server.adapter,
        key,
        id: request.params.id,
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
