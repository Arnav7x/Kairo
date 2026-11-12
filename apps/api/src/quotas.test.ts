import test from "node:test";
import assert from "node:assert/strict";
import { QuotaManager } from "./quotas.js";
import { AbuseDetector } from "./abuse.js";
import { generateApiKey, hashApiKey, TIER_CONFIGS, type User } from "./auth.js";

test("API key generation produces unique hashable keys", () => {
  const { key, prefix, hash } = generateApiKey();
  assert.ok(key.startsWith("kro_"));
  assert.equal(prefix, key.slice(0, 8));
  assert.equal(hash, hashApiKey(key));
});

test("QuotaManager enforces concurrency limit and rejects with 429", async () => {
  const qm = new QuotaManager();
  const testUser: User = {
    id: "user-test-concurrency",
    name: "Tester",
    tier: "authenticated",
    is_banned: false,
    concurrency_limit: 2,
    daily_cpu_ms_limit: 60000,
    created_at: new Date().toISOString(),
  };

  const r1 = await qm.checkAndAcquire(testUser, "python", "print(1)", 1000, "job-1", null, 0);
  assert.equal(r1.allowed, true);

  const r2 = await qm.checkAndAcquire(testUser, "python", "print(2)", 1000, "job-2", null, 0);
  assert.equal(r2.allowed, true);

  // 3rd concurrent run should fail
  const r3 = await qm.checkAndAcquire(testUser, "python", "print(3)", 1000, "job-3", null, 0);
  assert.equal(r3.allowed, false);
  assert.equal(r3.statusCode, 429);
  assert.match(r3.error ?? "", /concurrency limit/i);

  // Release one job
  await qm.releaseInflightAndRecordUsage(testUser.id, 500, null);

  // Now 4th job should be accepted
  const r4 = await qm.checkAndAcquire(testUser, "python", "print(4)", 1000, "job-4", null, 0);
  assert.equal(r4.allowed, true);
});

test("QuotaManager enforces daily CPU seconds quota", async () => {
  const qm = new QuotaManager();
  const testUser: User = {
    id: "user-test-cpu-quota",
    name: "Tester",
    tier: "anonymous",
    is_banned: false,
    concurrency_limit: 10,
    daily_cpu_ms_limit: 5000, // 5 seconds
    created_at: new Date().toISOString(),
  };

  const r1 = await qm.checkAndAcquire(testUser, "python", "print(1)", 4000, "job-1", null, 0);
  assert.equal(r1.allowed, true);
  await qm.releaseInflightAndRecordUsage(testUser.id, 4500, null);

  // Asking for another 2000 ms exceeds 5000 ms daily limit
  const r2 = await qm.checkAndAcquire(testUser, "python", "print(2)", 2000, "job-2", null, 0);
  assert.equal(r2.allowed, false);
  assert.equal(r2.statusCode, 429);
  assert.match(r2.error ?? "", /daily CPU quota/i);
});

test("QuotaManager reserves CPU at enqueue and reconciles actual execution time", async () => {
  const qm = new QuotaManager();
  const user: User = {
    id: "user-reservation",
    name: "Tester",
    tier: "anonymous",
    is_banned: false,
    concurrency_limit: 10,
    daily_cpu_ms_limit: 5000,
    created_at: new Date().toISOString(),
  };

  assert.equal((await qm.checkAndAcquire(user, "python", "print(1)", 4000, "job-reserved", null, 0)).allowed, true);
  // This must be rejected before job-reserved completes: its 4s budget is
  // already reserved, so admission cannot be gamed by a large queued burst.
  const denied = await qm.checkAndAcquire(user, "python", "print(2)", 2000, "job-denied", null, 0);
  assert.equal(denied.allowed, false);
  assert.match(denied.error ?? "", /daily CPU quota/i);

  // The job actually used only 1s; reconciliation returns the unused 3s.
  await qm.releaseInflightAndRecordUsage(user.id, 1000, null, "job-reserved");
  assert.equal((await qm.checkAndAcquire(user, "python", "print(3)", 4000, "job-after-reconcile", null, 0)).allowed, true);
});

test("QuotaManager deduplicates identical runs within window", async () => {
  const qm = new QuotaManager();
  const testUser: User = {
    id: "user-test-dedupe",
    name: "Tester",
    tier: "authenticated",
    is_banned: false,
    concurrency_limit: 10,
    daily_cpu_ms_limit: 60000,
    created_at: new Date().toISOString(),
  };

  const source = "print('identical payload')";
  const r1 = await qm.checkAndAcquire(testUser, "python", source, 1000, "job-orig", null, 5);
  assert.equal(r1.allowed, true);

  // Immediate second run with exact same code is deduplicated
  const r2 = await qm.checkAndAcquire(testUser, "python", source, 1000, "job-dup", null, 5);
  assert.equal(r2.allowed, false);
  assert.equal(r2.statusCode, 429);
  assert.match(r2.error ?? "", /duplicate execution detected/i);
});

test("AbuseDetector flags users on repeated CPU timeouts", async () => {
  const detector = new AbuseDetector({ threshold: 3, windowSeconds: 60 });
  const userId = "abusive-user-1";

  const res1 = await detector.recordExecutionOutcome({
    jobId: "j1",
    userId,
    status: "timeout",
    durationMs: 10000,
    cpuTimeout: true,
  });
  assert.equal(res1.shouldBan, false);

  const res2 = await detector.recordExecutionOutcome({
    jobId: "j2",
    userId,
    status: "timeout",
    durationMs: 10000,
    cpuTimeout: true,
  });
  assert.equal(res2.shouldBan, false);

  const res3 = await detector.recordExecutionOutcome({
    jobId: "j3",
    userId,
    status: "timeout",
    durationMs: 10000,
    cpuTimeout: true,
  });
  assert.equal(res3.shouldBan, true);
});
