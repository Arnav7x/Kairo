import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import type { FastifyInstance, FastifyRequest } from "fastify";
import Fastify from "fastify";
import type { Pool } from "pg";
import type WebSocket from "ws";

import { registerAdminRoutes } from "./admin.js";
import { lookupUserByApiKey, TIER_CONFIGS, type User } from "./auth.js";
import { getJobById, insertJob, listJobs, updateJobTerminal } from "./db.js";
import { QuotaManager } from "./quotas.js";
import {
  checkQueueBackpressure,
  type RedisRateLimiterClient,
  TokenBucketLimiter,
} from "./ratelimit.js";
import {
  DEFAULT_CONFIG,
  type LimitsInput,
  type ValidatedJob,
  type ValidationConfig,
  validateJobSubmission,
} from "./validation.js";
import { handleJobWebSocket, type WsRedisDependencies } from "./ws.js";

export interface Job {
  id: string;
  language: string;
  source_code: string;
  stdin?: string;
  args?: string[];
  limits?: Record<string, number> | LimitsInput;
}

export interface LanguageInfo {
  id: string;
  name?: string;
  image?: string;
  filename?: string;
  compiled?: boolean;
  aliases?: string[];
}

export interface AppDependencies {
  pingRedis(): Promise<void>;
  pingPostgres(): Promise<void>;
  enqueue(job: ValidatedJob): Promise<void>;
   redisClient?: (WsRedisDependencies & RedisRateLimiterClient & {
     xLen?(streamKey: string): Promise<number>;
     get?(key: string): Promise<string | null>;
     set?(key: string, value: string, options?: any): Promise<unknown>;
     keys?(pattern: string): Promise<string[]>;
     xInfoGroups?(streamKey: string): Promise<any[]>;
   }) | null;
  postgresPool?: Pool | null;
  rateLimiter?: TokenBucketLimiter;
  quotaManager?: QuotaManager;
  validationConfig?: ValidationConfig;
  /** Registry snapshot supplied by deployment configuration. */
  languages?: LanguageInfo[];
  requestTimeoutMs?: number;
}

export type HealthDependencies = AppDependencies;

export async function createApp(dependencies: AppDependencies): Promise<FastifyInstance> {
  const app = Fastify({
    logger: true,
    bodyLimit: 1048576, // 1 MB request body limit
    connectionTimeout: 15000,
    requestTimeout: 15000,
  });

  const defaultLimiter = new TokenBucketLimiter();
  const quotaManager = dependencies.quotaManager ?? new QuotaManager();
  const timeoutMs = dependencies.requestTimeoutMs ?? 15000;

  // Plugins must be awaited before routes are declared, otherwise route
  // options (e.g. `websocket: true`) bypass the plugin's onRoute hook.
  await app.register(cors, {
    origin: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-API-Key", "X-Admin-Key"],
  });

  await app.register(websocket);

  // Register admin endpoints
  registerAdminRoutes(app, {
    postgresPool: dependencies.postgresPool,
    redisClient: dependencies.redisClient,
  });

  // Request timeout hook for HTTP routes (skip WebSocket upgrade requests)
  app.addHook("onRequest", (request, reply, done) => {
    if ((request as FastifyRequest & { ws?: boolean }).ws) {
      return done();
    }

    const timer = setTimeout(() => {
      if (!reply.raw.headersSent) {
        void reply.code(504).send({ error: "Gateway Timeout", message: "Request timed out" });
      }
    }, timeoutMs);

    reply.raw.on("finish", () => clearTimeout(timer));
    reply.raw.on("close", () => clearTimeout(timer));
    done();
  });

  // Health and readiness endpoints
  app.get("/healthz", async () => ({ status: "ok" }));

  // This is deliberately a registry view, rather than a hand-maintained route
  // list: callers can discover exactly which language IDs submissions accept.
  app.get("/v1/languages", async () => ({
    languages: dependencies.languages ?? (dependencies.validationConfig ?? DEFAULT_CONFIG).allowedLanguages.map((id) => ({ id })),
  }));

  app.get("/readyz", async (_request, reply) => {
    const checks: Record<string, string> = {};
    let ready = true;

    for (const [name, ping] of Object.entries({
      redis: dependencies.pingRedis,
      postgres: dependencies.pingPostgres,
    })) {
      try {
        await ping();
        checks[name] = "ok";
      } catch (error) {
        ready = false;
        checks[name] = `unhealthy: ${error instanceof Error ? error.message : String(error)}`;
      }
    }

    return reply.code(ready ? 200 : 503).send({ ready, checks });
  });

  // Job submission handler (shared between /v1/jobs and /jobs)
  const submitJobHandler = async (request: FastifyRequest, reply: any) => {
    // 1. Check queue backpressure
    if (dependencies.redisClient) {
      const backpressure = await checkQueueBackpressure(dependencies.redisClient);
      if (backpressure.overloaded) {
        reply.header("Retry-After", backpressure.retryAfter.toString());
        return reply.code(503).send({
          error: "Queue backpressure",
          message: "Server queue is at capacity. Please retry later.",
          retry_after: backpressure.retryAfter,
        });
      }
    }

    // 2. Authentication and User Tier resolution
    const rawApiKey = (request.headers["x-api-key"] as string | undefined) ||
      ((request.headers["authorization"] as string | undefined)?.startsWith("Bearer ")
        ? (request.headers["authorization"] as string).slice(7).trim()
        : undefined);

    const forwarded = request.headers["x-forwarded-for"] as string | undefined;
    const clientIp = forwarded ? forwarded.split(",")[0].trim() : request.ip || "127.0.0.1";

    let currentUser: User;
    if (rawApiKey && dependencies.postgresPool) {
      const found = await lookupUserByApiKey(dependencies.postgresPool, rawApiKey);
      if (found) {
        currentUser = found;
      } else {
        return reply.code(401).send({ error: "Invalid API key" });
      }
    } else {
      currentUser = {
        id: `anon_${clientIp.replace(/[^a-zA-Z0-9]/g, "_")}`,
        name: "Anonymous",
        tier: "anonymous",
        is_banned: false,
        concurrency_limit: TIER_CONFIGS.anonymous.concurrency_limit,
        daily_cpu_ms_limit: TIER_CONFIGS.anonymous.daily_cpu_ms_limit,
        created_at: new Date().toISOString(),
      };
    }

    if (currentUser.is_banned) {
      return reply.code(403).send({ error: "Forbidden: user account has been suspended" });
    }

    // 3. Rate limiting check per user ID or IP
    const limiterIdentifier = currentUser.id.startsWith("anon_")
      ? `ip:${clientIp}`
      : `user:${currentUser.id}`;

    const limiter = dependencies.rateLimiter ?? defaultLimiter;
    const rateResult = await limiter.checkLimit(limiterIdentifier, dependencies.redisClient);

    reply.header("X-RateLimit-Limit", rateResult.limit.toString());
    reply.header("X-RateLimit-Remaining", rateResult.remaining.toString());
    reply.header("X-RateLimit-Reset", rateResult.resetTime.toString());

    if (!rateResult.allowed) {
      reply.header("Retry-After", rateResult.retryAfter.toString());
      return reply.code(429).send({
        error: "Too Many Requests",
        message: `Rate limit exceeded. Try again in ${rateResult.retryAfter} seconds.`,
        retry_after: rateResult.retryAfter,
      });
    }

    // 4. Validation and limit clamping
    // If validationConfig is explicitly supplied (e.g. in tests or server config), honor it.
    // Otherwise fallback to tier config defaults.
    let validationConfig = dependencies.validationConfig;
    if (!validationConfig) {
      const tierConfig = TIER_CONFIGS[currentUser.tier] ?? TIER_CONFIGS.anonymous;
      validationConfig = {
        ...DEFAULT_CONFIG,
        maxTimeoutMs: tierConfig.max_timeout_ms,
        maxMemoryMb: tierConfig.max_memory_mb,
      };
    }

    const validation = validateJobSubmission(request.body, validationConfig);
    if (!validation.success) {
      return reply.code(validation.statusCode).send({ error: validation.error });
    }

    const job = validation.job;

    // 5. Quota, Concurrency, and Deduplication enforcement
    const quotaResult = await quotaManager.checkAndAcquire(
      currentUser,
      job.language,
      job.source_code,
      job.limits.timeout_ms,
      job.id,
      dependencies.redisClient as any,
      0, // Dedupe window disabled on generic anonymous burst submissions unless requested
    );

    if (!quotaResult.allowed) {
      if (quotaResult.retryAfter) {
        reply.header("Retry-After", quotaResult.retryAfter.toString());
      }
      return reply.code(quotaResult.statusCode ?? 429).send({
        error: quotaResult.error,
        retry_after: quotaResult.retryAfter,
      });
    }

    // 6. Postgres persistence: create the job on submit
    if (dependencies.postgresPool) {
      try {
        await insertJob(
          dependencies.postgresPool,
          job,
          currentUser.id.startsWith("anon_") ? null : currentUser.id,
          quotaResult.sourceHash,
        );
      } catch (error) {
        request.log.error({ error, jobId: job.id }, "failed to insert job into Postgres");
      }
    }

    // 7. Enqueue job to Redis Stream
    await dependencies.enqueue(job);

    return reply.code(202).send({
      job_id: job.id,
      status: "queued",
      language: job.language,
      limits: job.limits,
    });
  };

  app.post("/v1/jobs", submitJobHandler);
  app.post("/jobs", submitJobHandler);

  // Job query handler (shared between /v1/jobs/:id and /jobs/:id)
  const getJobHandler = async (
    request: FastifyRequest<{ Params: { id: string } }>,
    reply: any,
  ) => {
    const { id } = request.params;
    let jobRecord = null;

    if (dependencies.postgresPool) {
      try {
        jobRecord = await getJobById(dependencies.postgresPool, id);
      } catch (error) {
        request.log.error({ error, jobId: id }, "failed to query job from Postgres");
      }
    }

    // Handle race or sync from Redis terminal key if available
    if (dependencies.redisClient && typeof dependencies.redisClient.get === "function") {
      try {
        const terminalData = await dependencies.redisClient.get(`kairo:job:${id}:terminal`);
        if (terminalData) {
          const parsedResult = JSON.parse(terminalData);
          if (dependencies.postgresPool) {
            const updated = await updateJobTerminal(dependencies.postgresPool, id, parsedResult);
            if (updated) {
              jobRecord = updated;
            }
          } else if (!jobRecord) {
            return reply.code(200).send({
              id,
              status: parsedResult.Status ?? parsedResult.status ?? "completed",
              exit_code: parsedResult.ExitCode ?? parsedResult.exit_code ?? 0,
              stdout: parsedResult.Stdout ?? parsedResult.stdout ?? "",
              stderr: parsedResult.Stderr ?? parsedResult.stderr ?? "",
              duration_ms:
                parsedResult.duration_ms ??
                (parsedResult.Duration ? Math.round(Number(parsedResult.Duration) / 1e6) : 0),
              peak_memory_bytes: parsedResult.PeakMemoryBytes ?? parsedResult.peak_memory_bytes ?? 0,
              error_message: parsedResult.ErrorMessage ?? parsedResult.error_message ?? null,
            });
          }
        }
      } catch {
        // ignore redis fetch error
      }
    }

    if (!jobRecord) {
      return reply.code(404).send({ error: "job not found" });
    }

    return reply.code(200).send(jobRecord);
  };

  app.get("/v1/jobs/:id", getJobHandler);
  app.get("/jobs/:id", getJobHandler);

  // Job list handler for run-history views
  const listJobsHandler = async (
    request: FastifyRequest<{ Querystring: { limit?: string; status?: string } }>,
    reply: any,
  ) => {
    if (!dependencies.postgresPool) {
      return reply.code(200).send({ jobs: [] });
    }
    try {
      const limit = Number.parseInt(request.query.limit ?? "25", 10);
      const rawStatus = (request.query.status ?? "").trim().toLowerCase();
      const allowedStatuses = ["queued", "running", "completed", "failed", "cancelled", "timeout"];
      const status = allowedStatuses.includes(rawStatus) ? rawStatus : undefined;
      const jobs = await listJobs(dependencies.postgresPool, {
        limit: Number.isNaN(limit) ? undefined : limit,
        status,
      });
      return reply.code(200).send({ jobs });
    } catch (error) {
      request.log.error({ error }, "failed to list jobs from Postgres");
      return reply.code(500).send({ error: "failed to list jobs" });
    }
  };

  app.get("/v1/jobs", listJobsHandler);
  app.get("/jobs", listJobsHandler);

  // Cancellation handler: signals active workers via the per-job cancel key.
  const cancelJobHandler = async (
    request: FastifyRequest<{ Params: { id: string } }>,
    reply: any,
  ) => {
    const { id } = request.params;
    if (!dependencies.redisClient || typeof dependencies.redisClient.set !== "function") {
      return reply.code(503).send({ error: "cancellation backend unavailable" });
    }
    try {
      const cancelKey = `kairo:job:${id}:cancel`;
      await dependencies.redisClient.set(cancelKey, "1");
      return reply.code(202).send({ id, status: "cancelling" });
    } catch (error) {
      request.log.error({ error, jobId: id }, "failed to set cancellation key");
      return reply.code(500).send({ error: "failed to cancel job" });
    }
  };

  app.delete("/v1/jobs/:id", cancelJobHandler);
  app.delete("/jobs/:id", cancelJobHandler);

  // WebSocket hub handlers
  const wsRouteHandler = (
    socket: WebSocket,
    req: FastifyRequest<{ Params: { id: string }; Querystring: { since?: string } }>,
  ) => {
    if (dependencies.redisClient) {
      handleJobWebSocket(socket, req, dependencies.redisClient);
    } else {
      socket.close(1011, "WebSocket streaming backend unavailable");
    }
  };

  app.get("/v1/jobs/:id/ws", { websocket: true }, wsRouteHandler);
  app.get("/v1/jobs/:id/events", { websocket: true }, wsRouteHandler);
  app.get("/jobs/:id/ws", { websocket: true }, wsRouteHandler);
  app.get("/jobs/:id/events", { websocket: true }, wsRouteHandler);

  return app;
}
