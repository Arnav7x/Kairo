import assert from "node:assert/strict";
import test from "node:test";

import { createApp } from "./app.js";

test("health endpoint is always live", async () => {
  const app = createApp({ pingRedis: async () => {}, pingPostgres: async () => {} });
  const response = await app.inject({ method: "GET", url: "/healthz" });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { status: "ok" });
  await app.close();
});

test("readiness reports unavailable dependencies", async () => {
  const app = createApp({
    pingRedis: async () => {},
    pingPostgres: async () => {
      throw new Error("connection refused");
    },
  });
  const response = await app.inject({ method: "GET", url: "/readyz" });

  assert.equal(response.statusCode, 503);
  assert.equal(response.json().checks.postgres, "unhealthy: connection refused");
  await app.close();
});
