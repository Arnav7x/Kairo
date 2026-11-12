import { createClient } from "redis";
import { Pool } from "pg";
import fastifyStatic from "@fastify/static";
import { resolve } from "node:path";

import { createApp } from "./app.js";
import { AbuseDetector } from "./abuse.js";
import { getJobAccountingRecord, initDb, updateJobTerminal } from "./db.js";
import { QuotaManager } from "./quotas.js";

const port = Number.parseInt(process.env.PORT ?? "8080", 10);
const redis = createClient({ url: process.env.KAIRO_REDIS_URL ?? "redis://localhost:6379" });
const postgres = process.env.KAIRO_DATABASE_URL
  ? new Pool({ connectionString: process.env.KAIRO_DATABASE_URL })
  : null;

await redis.connect();
const quotaManager = new QuotaManager();
const abuseDetector = new AbuseDetector();

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
    if (parsed.job_id) {
      const accounting = postgres ? await getJobAccountingRecord(postgres, parsed.job_id) : null;
      if (postgres) await updateJobTerminal(postgres, parsed.job_id, parsed);
      const quotaOwner = accounting?.userId ?? await redis.get(`kairo:job:${parsed.job_id}:quota_owner`);
      if (quotaOwner) {
        const durationMs = Math.max(0, Number(parsed.duration_ms ?? 0));
        await quotaManager.releaseInflightAndRecordUsage(quotaOwner, durationMs, redis as any, parsed.job_id);
        await abuseDetector.recordExecutionOutcome(
          {
            jobId: parsed.job_id,
            userId: quotaOwner,
            status: String(parsed.status ?? ""),
            durationMs,
            cpuTimeout: String(parsed.status ?? "") === "timeout",
          },
          postgres,
          redis as any,
        );
      }
    }
  } catch (err) {
    console.error("Failed to update terminal job in Postgres:", err);
  }
});

const app = await createApp({
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
  quotaManager,
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
