import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { setUserBanned } from "./auth.js";

export interface AdminDependencies {
  postgresPool?: Pool | null;
  redisClient?: any;
}

export function registerAdminRoutes(app: FastifyInstance, dependencies: AdminDependencies): void {
  // Middleware/check for admin key
  const requireAdmin = (request: FastifyRequest, reply: any, done: () => void) => {
    const adminKey = request.headers["x-admin-key"] || request.headers["x-api-key"];
    const expected = process.env.KAIRO_ADMIN_KEY ?? "admin-secret-key";
    if (!adminKey || adminKey !== expected) {
      void reply.code(403).send({ error: "Forbidden: admin access required" });
      return;
    }
    done();
  };

  // POST /v1/admin/users/:id/ban
  app.post<{ Params: { id: string }; Body?: { banned?: boolean } }>(
    "/v1/admin/users/:id/ban",
    { preHandler: requireAdmin },
    async (request, reply) => {
      const { id } = request.params;
      const banned = request.body?.banned !== false; // defaults to true
      if (!dependencies.postgresPool) {
        return reply.code(503).send({ error: "Postgres database unavailable" });
      }
      try {
        const updated = await setUserBanned(dependencies.postgresPool, id, banned);
        if (!updated) {
          return reply.code(404).send({ error: "User not found" });
        }
        return reply.code(200).send({ user_id: id, is_banned: banned });
      } catch (err) {
        return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );

  // GET /v1/admin/queue/depth
  app.get("/v1/admin/queue/depth", { preHandler: requireAdmin }, async (_request, reply) => {
    if (!dependencies.redisClient) {
      return reply.code(503).send({ error: "Redis backend unavailable" });
    }
    try {
      const streamKey = "kairo:jobs";
      let streamLength = 0;
      if (typeof dependencies.redisClient.xLen === "function") {
        streamLength = await dependencies.redisClient.xLen(streamKey);
      }
      let groupsInfo: any[] = [];
      if (typeof dependencies.redisClient.xInfoGroups === "function") {
        try {
          groupsInfo = await dependencies.redisClient.xInfoGroups(streamKey);
        } catch {
          // ignore if stream doesn't exist yet
        }
      }
      return reply.code(200).send({
        stream: streamKey,
        length: streamLength,
        groups: groupsInfo,
      });
    } catch (err) {
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // GET /v1/admin/workers
  app.get("/v1/admin/workers", { preHandler: requireAdmin }, async (_request, reply) => {
    if (!dependencies.redisClient) {
      return reply.code(503).send({ error: "Redis backend unavailable" });
    }
    try {
      const workers: any[] = [];
      if (typeof dependencies.redisClient.keys === "function") {
        const keys = await dependencies.redisClient.keys("kairo:worker:*:heartbeat");
        for (const key of keys) {
          const val = await dependencies.redisClient.get(key);
          if (val) {
            try {
              workers.push(JSON.parse(val));
            } catch {
              workers.push({ key, raw: val });
            }
          }
        }
      }
      return reply.code(200).send({
        active_workers_count: workers.length,
        workers,
      });
    } catch (err) {
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}
