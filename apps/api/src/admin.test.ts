import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "./app.js";

const noOpDependencies = {
  pingRedis: async () => {},
  pingPostgres: async () => {},
  enqueue: async () => {},
};

test("Admin endpoints require valid X-Admin-Key", async () => {
  const app = await createApp(noOpDependencies);

  // Without header
  const r1 = await app.inject({
    method: "POST",
    url: "/v1/admin/users/123/ban",
    payload: { banned: true },
  });
  assert.equal(r1.statusCode, 403);

  // With invalid header
  const r2 = await app.inject({
    method: "POST",
    url: "/v1/admin/users/123/ban",
    headers: { "x-admin-key": "wrong-secret" },
    payload: { banned: true },
  });
  assert.equal(r2.statusCode, 403);

  await app.close();
});

test("Admin queue depth and workers inspection endpoints return metrics", async () => {
  const mockRedis = {
    xLen: async () => 42,
    xInfoGroups: async () => [{ name: "workers", pending: 2 }],
    keys: async () => ["kairo:worker:1:heartbeat"],
    get: async () => JSON.stringify({ worker_id: "worker-1", concurrency: 4, timestamp: "2026-01-01T00:00:00Z" }),
  };

  const app = await createApp({
    ...noOpDependencies,
    redisClient: mockRedis as any,
  });

  const rQueue = await app.inject({
    method: "GET",
    url: "/v1/admin/queue/depth",
    headers: { "x-admin-key": "admin-secret-key" },
  });
  assert.equal(rQueue.statusCode, 200);
  assert.equal(rQueue.json().length, 42);

  const rWorkers = await app.inject({
    method: "GET",
    url: "/v1/admin/workers",
    headers: { "x-admin-key": "admin-secret-key" },
  });
  assert.equal(rWorkers.statusCode, 200);
  assert.equal(rWorkers.json().active_workers_count, 1);
  assert.equal(rWorkers.json().workers[0].worker_id, "worker-1");

  await app.close();
});
