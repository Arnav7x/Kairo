import assert from "node:assert/strict";
import test from "node:test";

import { checkQueueBackpressure, TokenBucketLimiter } from "./ratelimit.js";

test("TokenBucketLimiter allows requests up to capacity and rejects overflow with 429 Retry-After", async () => {
  const limiter = new TokenBucketLimiter({
    capacity: 3,
    refillRate: 1, // 1 token per second
    cost: 1,
  });

  // First 3 requests allowed
  const r1 = await limiter.checkLimit("user-1");
  assert.equal(r1.allowed, true);
  assert.equal(r1.remaining, 2);

  const r2 = await limiter.checkLimit("user-1");
  assert.equal(r2.allowed, true);
  assert.equal(r2.remaining, 1);

  const r3 = await limiter.checkLimit("user-1");
  assert.equal(r3.allowed, true);
  assert.equal(r3.remaining, 0);

  // 4th request must be rate limited
  const r4 = await limiter.checkLimit("user-1");
  assert.equal(r4.allowed, false);
  assert.equal(r4.remaining, 0);
  assert.ok(r4.retryAfter >= 1);

  // Different user identifier has independent capacity
  const rOther = await limiter.checkLimit("user-2");
  assert.equal(rOther.allowed, true);
  assert.equal(rOther.remaining, 2);
});

test("checkQueueBackpressure detects overloaded queue and returns Retry-After", async () => {
  const mockHealthyRedis = {
    xLen: async () => 50,
  };
  const healthy = await checkQueueBackpressure(mockHealthyRedis, 100);
  assert.equal(healthy.overloaded, false);

  const mockOverloadedRedis = {
    xLen: async () => 150,
  };
  const overloaded = await checkQueueBackpressure(mockOverloadedRedis, 100);
  assert.equal(overloaded.overloaded, true);
  assert.equal(overloaded.retryAfter, 5);
});
