import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { fetchThread, parseStatusUrl } from "../../core/thread.js";
import { httpStatusFor } from "../envelope.js";
import { renderHome } from "../../views/home.js";
import { renderThreadPage } from "../../views/thread.js";

export const HOME_PATH = "/" as const;
export const STATUS_PATH = "/status/:id" as const;

type HomeQuery = {
  url?: string;
};

type StatusParams = {
  id: string;
};

const UNROLL_FAILED = "We could not unroll this thread.";

export const htmlRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Querystring: HomeQuery }>(HOME_PATH, async (request, reply) => {
    const raw = request.query.url;
    if (raw === undefined || raw.trim() === "") {
      return sendHtml(reply, 200, renderHome());
    }
    const parsed = parseStatusUrl(raw);
    if (!parsed.ok) {
      return sendHtml(reply, 400, renderHome({ url: raw, error: parsed.message }));
    }
    return reply.redirect(`/status/${parsed.statusId}`, 302);
  });

  app.get<{ Params: StatusParams }>(STATUS_PATH, async (request, reply) => {
    const id = request.params.id.trim();
    if (!/^\d+$/.test(id)) {
      return sendHtml(
        reply,
        400,
        renderHome({ error: "Provide a numeric status id." }),
      );
    }
    const result = await fetchThread({
      db: request.server.db,
      adapter: request.server.adapter,
      rootId: id,
    });
    if (!result.ok) {
      const status = httpStatusFor(result.error.code);
      return sendHtml(
        reply,
        status,
        renderHome({
          url: `https://x.com/i/status/${id}`,
          error: `${UNROLL_FAILED} ${result.error.message}`,
        }),
      );
    }
    return sendHtml(reply, 200, renderThreadPage(result.data));
  });
};

function sendHtml(reply: FastifyReply, status: number, body: string): FastifyReply {
  return reply.type("text/html; charset=utf-8").status(status).send(body);
}
