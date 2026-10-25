import cors from "@fastify/cors";
import type { FastifyInstance } from "fastify";
import Fastify from "fastify";

export interface HealthDependencies {
  pingRedis(): Promise<void>;
  pingPostgres(): Promise<void>;
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

  return app;
}
