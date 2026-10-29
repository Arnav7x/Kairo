import { createClient } from "redis";
import { Pool } from "pg";
import fastifyStatic from "@fastify/static";
import { resolve } from "node:path";

import { createApp } from "./app.js";
import { initDb, updateJobTerminal } from "./db.js";

const port = Number.parseInt(process.env.PORT ?? "8080", 10);
const redis = createClient({ url: process.env.KAIRO_REDIS_URL ?? "redis://localhost:6379" });
const postgres = process.env.KAIRO_DATABASE_URL
  ? new Pool({ connectionString: process.env.KAIRO_DATABASE_URL })
  : null;

await redis.connect();

if (postgres) {
  try {
    await initDb(postgres);
  } catch (err) {
    console.warn("Database initialization deferred or failed:", err);
  }
}

// Background subscriber to persist terminal events to PostgreSQL
const terminalSub = redis.duplicate();
await terminalSub.connect();
await terminalSub.subscribe("kairo:jobs:terminal", async (message) => {
  try {
    const parsed = JSON.parse(message);
    if (parsed.job_id && postgres) {
      await updateJobTerminal(postgres, parsed.job_id, parsed);
    }
  } catch (err) {
    console.error("Failed to update terminal job in Postgres:", err);
  }
});

const app = createApp({
  pingRedis: async () => {
    await redis.ping();
  },
  pingPostgres: async () => {
    if (postgres) {
      await postgres.query("SELECT 1");
    }
  },
  enqueue: async (job) => {
    await redis.xAdd("kairo:jobs", "*", { job: JSON.stringify(job) });
  },
  redisClient: redis as any,
  postgresPool: postgres,
});

if (process.env.WEB_DIST_DIR) {
  await app.register(fastifyStatic, { root: resolve(process.env.WEB_DIST_DIR) });
}

const shutdown = async () => {
  await app.close();
  try {
    await terminalSub.unsubscribe("kairo:jobs:terminal");
    await terminalSub.quit();
  } catch {
    terminalSub.disconnect();
  }
  await redis.close();
  if (postgres) {
    await postgres.end();
  }
};

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

await app.listen({ host: "0.0.0.0", port });
