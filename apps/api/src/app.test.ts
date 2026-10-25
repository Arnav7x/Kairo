import assert from "node:assert/strict";
import test from "node:test";

import { createApp, type Job } from "./app.js";

const noOpDependencies = { pingRedis: async () => {}, pingPostgres: async () => {}, enqueue: async (_job: Job) => {} };

test("health endpoint is always live", async () => {
  const app = createApp(noOpDependencies);
  const response = await app.inject({ method: "GET", url: "/healthz" });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { status: "ok" });
  await app.close();
});

test("job submission adds a queue payload", async () => {
  let queued: Job | undefined;
  const app = createApp({ ...noOpDependencies, enqueue: async (job) => { queued = job; } });
  const response = await app.inject({ method: "POST", url: "/jobs", payload: { language: "python", source_code: "print('hi')" } });

  assert.equal(response.statusCode, 202);
  assert.equal(queued?.language, "python");
  assert.equal(queued?.source_code, "print('hi')");
  assert.ok(queued?.id);
  await app.close();
});

test("readiness reports unavailable dependencies", async () => {
  const app = createApp({
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
