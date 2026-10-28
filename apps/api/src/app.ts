import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import type { FastifyInstance, FastifyRequest } from "fastify";
import Fastify from "fastify";
import type { Pool } from "pg";
import type WebSocket from "ws";

import { getJobById, insertJob, updateJobTerminal } from "./db.js";
import {
  checkQueueBackpressure,
  type RedisRateLimiterClient,
  TokenBucketLimiter,
} from "./ratelimit.js";
import {
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

export interface AppDependencies {
  pingRedis(): Promise<void>;
  pingPostgres(): Promise<void>;
  enqueue(job: ValidatedJob): Promise<void>;
  redisClient?: (WsRedisDependencies & RedisRateLimiterClient & {
    xLen?(streamKey: string): Promise<number>;
    get?(key: string): Promise<string | null>;
  }) | null;
  postgresPool?: Pool | null;
  rateLimiter?: TokenBucketLimiter;
  validationConfig?: ValidationConfig;
  requestTimeoutMs?: number;
}

export type HealthDependencies = AppDependencies;

export function createApp(dependencies: AppDependencies): FastifyInstance {
  const app = Fastify({
    logger: true,
    bodyLimit: 1048576, // 1 MB request body limit
    connectionTimeout: 15000,
    requestTimeout: 15000,
  });

  const defaultLimiter = new TokenBucketLimiter();
  const timeoutMs = dependencies.requestTimeoutMs ?? 15000;

  void app.register(cors, {
    origin: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-API-Key"],
  });

  void app.register(websocket);

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

    // 2. Rate limiting check per IP or API Key
    const apiKey = request.headers["x-api-key"] as string | undefined;
    const authHeader = request.headers["authorization"] as string | undefined;
    let identifier = "";
    if (apiKey && typeof apiKey === "string" && apiKey.trim() !== "") {
      identifier = `key:${apiKey.trim()}`;
    } else if (authHeader && authHeader.startsWith("Bearer ")) {
      identifier = `key:${authHeader.slice(7).trim()}`;
    } else {
      const forwarded = request.headers["x-forwarded-for"] as string | undefined;
      const ip = forwarded ? forwarded.split(",")[0].trim() : request.ip || "127.0.0.1";
      identifier = `ip:${ip}`;
    }

    const limiter = dependencies.rateLimiter ?? defaultLimiter;
    const rateResult = await limiter.checkLimit(identifier, dependencies.redisClient);

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

    // 3. Validation and limit clamping
    const validation = validateJobSubmission(request.body, dependencies.validationConfig);
    if (!validation.success) {
      return reply.code(validation.statusCode).send({ error: validation.error });
    }

    const job = validation.job;

    // 4. Postgres persistence: create the job on submit
    if (dependencies.postgresPool) {
      try {
        await insertJob(dependencies.postgresPool, job);
      } catch (error) {
        request.log.error({ error, jobId: job.id }, "failed to insert job into Postgres");
      }
    }

    // 5. Enqueue job to Redis Stream
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
