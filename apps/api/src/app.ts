import cors from "@fastify/cors";
import type { FastifyInstance } from "fastify";
import Fastify from "fastify";
import { randomUUID } from "node:crypto";

export interface HealthDependencies {
  pingRedis(): Promise<void>;
  pingPostgres(): Promise<void>;
  enqueue(job: Job): Promise<void>;
}

export interface Job {
  id: string;
  language: string;
  source_code: string;
  stdin?: string;
  args?: string[];
  limits?: Record<string, number>;
}

export function createApp(dependencies: HealthDependencies): FastifyInstance {
  const app = Fastify({ logger: true });

  void app.register(cors, { origin: true });

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

  app.post("/jobs", async (request, reply) => {
    const body = request.body as Partial<Job> | undefined;
    if (!body || typeof body.language !== "string" || typeof body.source_code !== "string" || body.source_code === "") {
      return reply.code(400).send({ error: "language and source_code are required" });
    }
    const job: Job = {
      id: randomUUID(),
      language: body.language,
      source_code: body.source_code,
      stdin: typeof body.stdin === "string" ? body.stdin : undefined,
      args: Array.isArray(body.args) && body.args.every((arg) => typeof arg === "string") ? body.args : undefined,
      limits: body.limits,
    };
    await dependencies.enqueue(job);
    return reply.code(202).send({ job_id: job.id, status: "queued" });
  });

  return app;
}
