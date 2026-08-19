import type { XAdapter } from "../adapters/types.js";
import type { Key } from "../billing/keys.js";
import type { ThreadApiDb } from "../db.js";

declare module "fastify" {
  interface FastifyInstance {
    db: ThreadApiDb;
    adapter: XAdapter;
  }

  interface FastifyRequest {
    apiKey?: Key;
  }
}

export {};
