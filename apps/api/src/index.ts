import { createClient } from "redis";
import { Pool } from "pg";
import fastifyStatic from "@fastify/static";
import { resolve } from "node:path";

import { createApp } from "./app.js";

const port = Number.parseInt(process.env.PORT ?? "8080", 10);
const redis = createClient({ url: process.env.KAIRO_REDIS_URL ?? "redis://localhost:6379" });
const postgres = new Pool({ connectionString: process.env.KAIRO_DATABASE_URL });

await redis.connect();

const app = createApp({
  pingRedis: async () => {
    await redis.ping();
  },
  pingPostgres: async () => {
    await postgres.query("SELECT 1");
  },
  enqueue: async (job) => {
    await redis.xAdd("kairo:jobs", "*", { job: JSON.stringify(job) });
  },
});

if (process.env.WEB_DIST_DIR) {
  await app.register(fastifyStatic, { root: resolve(process.env.WEB_DIST_DIR) });
}

const shutdown = async () => {
  await app.close();
  await redis.close();
  await postgres.end();
};

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

await app.listen({ host: "0.0.0.0", port });
