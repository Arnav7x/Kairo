import assert from "node:assert/strict";
import test from "node:test";

import { createApp, type Job } from "./app.js";
import { TokenBucketLimiter } from "./ratelimit.js";
import type { ValidatedJob } from "./validation.js";

const noOpDependencies = {
  pingRedis: async () => {},
  pingPostgres: async () => {},
  enqueue: async (_job: ValidatedJob) => {},
};

test("health endpoint is always live", async () => {
  const app = await createApp(noOpDependencies);
  const response = await app.inject({ method: "GET", url: "/healthz" });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { status: "ok" });
  await app.close();
});

test("language endpoint exposes the configured registry", async () => {
  const app = await createApp({
    ...noOpDependencies,
    languages: [{ id: "go", name: "Go", compiled: true }, { id: "node", name: "Node.js" }],
  });
  const response = await app.inject({ method: "GET", url: "/v1/languages" });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    languages: [{ id: "go", name: "Go", compiled: true }, { id: "node", name: "Node.js" }],
  });
  await app.close();
});

test("job submission adds a queue payload with clamped limits", async () => {
  let queued: ValidatedJob | undefined;
  const app = await createApp({
    ...noOpDependencies,
    enqueue: async (job) => {
      queued = job;
    },
  });
  const response = await app.inject({
    method: "POST",
    url: "/v1/jobs",
    payload: {
      language: "python",
      source_code: "print('hi')",
      limits: { timeout_ms: 500, memory_mb: 2000 },
    },
  });

  assert.equal(response.statusCode, 202);
  const body = response.json();
  assert.equal(body.status, "queued");
  assert.equal(queued?.language, "python");
  assert.equal(queued?.source_code, "print('hi')");
  // Clamped
  assert.equal(queued?.limits.timeout_ms, 1000); // clamped to min 1000
  assert.equal(queued?.limits.memory_mb, 1024); // clamped to max 1024
  assert.ok(queued?.id);
  await app.close();
});

test("job submission rejects disallowed language with 400", async () => {
  const app = await createApp(noOpDependencies);
  const response = await app.inject({
    method: "POST",
    url: "/v1/jobs",
    payload: { language: "pascal", source_code: "begin end." },
  });

  assert.equal(response.statusCode, 400);
  assert.match(response.json().error, /Unsupported language/);
  await app.close();
});

test("readiness reports unavailable dependencies", async () => {
  const app = await createApp({
    pingRedis: async () => {},
    pingPostgres: async () => {
      throw new Error("connection refused");
    },
    enqueue: async () => {},
  });
  const response = await app.inject({ method: "GET", url: "/readyz" });

  assert.equal(response.statusCode, 503);
  assert.equal(response.json().checks.postgres, "unhealthy: connection refused");
  await app.close();
});

test("rate limiting returns 429 when capacity is exhausted", async () => {
  const tightLimiter = new TokenBucketLimiter({ capacity: 2, refillRate: 1, cost: 1 });
  const app = await createApp({
    ...noOpDependencies,
    rateLimiter: tightLimiter,
  });

  // Request 1: OK
  const r1 = await app.inject({
    method: "POST",
    url: "/v1/jobs",
    payload: { language: "python", source_code: "print(1)" },
  });
  assert.equal(r1.statusCode, 202);

  // Request 2: OK
  const r2 = await app.inject({
    method: "POST",
    url: "/v1/jobs",
    payload: { language: "python", source_code: "print(2)" },
  });
  assert.equal(r2.statusCode, 202);

  // Request 3: Rate limited!
  const r3 = await app.inject({
    method: "POST",
    url: "/v1/jobs",
    payload: { language: "python", source_code: "print(3)" },
  });
  assert.equal(r3.statusCode, 429);
  assert.ok(r3.headers["retry-after"]);
  assert.equal(r3.json().error, "Too Many Requests");

  await app.close();
});

test("queue backpressure returns 503 with Retry-After", async () => {
  const mockOverloadedRedis = {
    eval: async () => [1, 20, 0],
    xLen: async () => 2000, // exceeds max depth
  };

  const app = await createApp({
    ...noOpDependencies,
    redisClient: mockOverloadedRedis as any,
  });

  const response = await app.inject({
    method: "POST",
    url: "/v1/jobs",
    payload: { language: "python", source_code: "print('hi')" },
  });

  assert.equal(response.statusCode, 503);
  assert.equal(response.headers["retry-after"], "5");
  assert.equal(response.json().error, "Queue backpressure");

  await app.close();
});

test("GET /v1/jobs/:id returns 404 for unknown job", async () => {
  const app = await createApp(noOpDependencies);
  const response = await app.inject({ method: "GET", url: "/v1/jobs/00000000-0000-0000-0000-000000000000" });

  assert.equal(response.statusCode, 404);
  assert.equal(response.json().error, "job not found");
  await app.close();
});

test("GET /v1/jobs/:id resolves terminal result from Redis if available", async () => {
  const jobId = "test-job-sync";
  const mockRedis = {
    eval: async () => [1, 20, 0],
    get: async (key: string) => {
      if (key === `kairo:job:${jobId}:terminal`) {
        return JSON.stringify({
          Status: "completed",
          ExitCode: 0,
          Stdout: "hello from test\n",
          Duration: 12345678,
        });
      }
      return null;
    },
  };

  const app = await createApp({
    ...noOpDependencies,
    redisClient: mockRedis as any,
  });

  const response = await app.inject({ method: "GET", url: `/v1/jobs/${jobId}` });
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.id, jobId);
  assert.equal(body.status, "completed");
  assert.equal(body.exit_code, 0);
  assert.equal(body.stdout, "hello from test\n");

  await app.close();
});

test("CORS preflight responds to OPTIONS request", async () => {
  const app = await createApp(noOpDependencies);
  const response = await app.inject({
    method: "OPTIONS",
    url: "/v1/jobs",
    headers: {
      origin: "http://example.com",
      "access-control-request-method": "POST",
    },
  });

  assert.equal(response.statusCode, 204);
  assert.equal(response.headers["access-control-allow-origin"], "http://example.com");
  await app.close();
});

test("GET /v1/jobs lists recent jobs from Postgres", async () => {
  const rows = [
    { id: "job-b", language: "python", status: "queued", exit_code: null, duration_ms: null, peak_memory_bytes: null, error_message: null, created_at: new Date("2026-01-02T00:00:00Z"), completed_at: null },
    { id: "job-a", language: "cpp", status: "completed", exit_code: 0, duration_ms: 42, peak_memory_bytes: 2400, error_message: null, created_at: new Date("2026-01-01T00:00:00Z"), completed_at: new Date("2026-01-01T00:00:01Z") },
  ];
  const mockPool = {
    query: async (text: string, params: unknown[]) => {
      if (!text.includes("FROM jobs") || !text.includes("ORDER BY created_at DESC")) {
        throw new Error(`unexpected query: ${text}`);
      }
      assert.equal(params.length, 2);
      return { rows };
    },
  } as any;

  const app = await createApp({ ...noOpDependencies, postgresPool: mockPool });
  const response = await app.inject({ method: "GET", url: "/v1/jobs?limit=2&status=completed" });

  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.jobs.length, 2);
  assert.equal(body.jobs[0].id, "job-b");
  assert.equal(body.jobs[1].duration_ms, 42);
  assert.equal(body.jobs[1].completed_at, "2026-01-01T00:00:01.000Z");
  await app.close();
});

test("GET /v1/jobs returns empty list without Postgres", async () => {
  const app = await createApp(noOpDependencies);
  const response = await app.inject({ method: "GET", url: "/v1/jobs" });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { jobs: [] });
  await app.close();
});

test("DELETE /v1/jobs/:id signals workers through the cancel key", async () => {
  const jobId = "cancel-me";
  const cancelKeys: string[] = [];
  const mockRedis = {
    eval: async () => [1, 20, 0],
    set: async (key: string, _value: string) => {
      cancelKeys.push(key);
      return "OK";
    },
  };

  const app = await createApp({
    ...noOpDependencies,
    redisClient: mockRedis as any,
  });

  const response = await app.inject({ method: "DELETE", url: `/v1/jobs/${jobId}` });
  assert.equal(response.statusCode, 202);
  assert.equal(response.json().status, "cancelling");
  assert.deepEqual(cancelKeys, [`kairo:job:${jobId}:cancel`]);
  await app.close();
});

test("DELETE /v1/jobs/:id returns 503 without a Redis backend", async () => {
  const app = await createApp(noOpDependencies);
  const response = await app.inject({ method: "DELETE", url: "/v1/jobs/cancel-me" });

  assert.equal(response.statusCode, 503);
  assert.equal(response.json().error, "cancellation backend unavailable");
  await app.close();
});
