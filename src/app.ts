import Fastify, { type FastifyInstance } from "fastify";
import { createAppAdapter, type XAdapter } from "./adapters/index.js";
import { bootstrapKeyIfEmpty } from "./billing/keys.js";
import { openDatabase, type ThreadApiDb } from "./db.js";
import { healthRoutes } from "./http/routes/health.js";
import { htmlRoutes } from "./http/routes/html.js";
import { meRoutes } from "./http/routes/me.js";
import { postRoutes } from "./http/routes/posts.js";
import { searchRoutes } from "./http/routes/search.js";
import { threadRoutes } from "./http/routes/threads.js";
import { userRoutes } from "./http/routes/users.js";
import { mcpRoutes } from "./mcp/server.js";

export type BuildAppOptions = {
  logger?: boolean;
  db?: ThreadApiDb;
  databasePath?: string;
  bootstrapKey?: string;
  adapter?: XAdapter;
};

export async function buildApp(
  options: BuildAppOptions = {},
): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger ?? false });
  const ownsDb = options.db === undefined;
  const db = options.db ?? openDatabase(options.databasePath ?? ":memory:");
  if (options.bootstrapKey !== undefined) {
    bootstrapKeyIfEmpty(db, options.bootstrapKey);
  }
  app.decorate("db", db);
  app.decorate("adapter", options.adapter ?? createAppAdapter());
  app.decorateRequest("apiKey", undefined);
  if (ownsDb) {
    app.addHook("onClose", async (instance) => {
      instance.db.close();
    });
  }
  await app.register(healthRoutes);
  await app.register(htmlRoutes);
  await app.register(meRoutes);
  await app.register(threadRoutes);
  await app.register(postRoutes);
  await app.register(userRoutes);
  await app.register(searchRoutes);
  await app.register(mcpRoutes);
  return app;
}
