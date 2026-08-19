import type { Key } from "../billing/keys.js";
import type { ThreadApiDb } from "../db.js";

declare module "fastify" {
  interface FastifyInstance {
    db: ThreadApiDb;
  }

  interface FastifyRequest {
    apiKey?: Key;
  }
}

export {};
