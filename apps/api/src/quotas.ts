import { createHash } from "node:crypto";
import type { User, UserTier } from "./auth.js";
import { TIER_CONFIGS } from "./auth.js";

export interface QuotaCheckResult {
  allowed: boolean;
  statusCode?: 403 | 429;
  error?: string;
  retryAfter?: number;
  sourceHash?: string;
}

export interface QuotasRedisClient {
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>;
  incrBy?(key: string, value: number): Promise<number>;
  decr?(key: string): Promise<number>;
  get?(key: string): Promise<string | null>;
  set?(key: string, value: string, options?: any): Promise<unknown>;
  del?(key: string): Promise<number>;
}

export function computeSourceHash(language: string, sourceCode: string): string {
  return createHash("sha256").update(`${language}:${sourceCode}`).digest("hex");
}

export function todayDateKey(): string {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

/**
 * Lua script for atomic quota and concurrency evaluation:
 * KEYS[1] = in-flight key (e.g. kairo:inflight:<userId>)
 * KEYS[2] = daily CPU ms key (e.g. kairo:dailycpu:<userId>:<date>)
 * KEYS[3] = dedupe key (e.g. kairo:dedupe:<sourceHash>)
 *
 * ARGV[1] = max_concurrency
 * ARGV[2] = max_daily_cpu_ms
 * ARGV[3] = estimated_cpu_ms
 * ARGV[4] = dedupe_window_seconds
 * ARGV[5] = job_id
 *
 * Return:
 * {status_code, reason} where status_code 1 = allowed, 2 = concurrency exceeded, 3 = daily cpu exceeded, 4 = dedupe collision
 */
export const LUA_CHECK_AND_ACQUIRE_QUOTA = `
local inflight_key = KEYS[1]
local daily_key = KEYS[2]
local dedupe_key = KEYS[3]

local max_concurrency = tonumber(ARGV[1])
local max_daily_cpu = tonumber(ARGV[2])
local estimated_cpu = tonumber(ARGV[3])
local dedupe_window = tonumber(ARGV[4])
local job_id = ARGV[5]

-- 1. Check dedupe window if specified
if dedupe_window > 0 and dedupe_key ~= "" then
  local existing_job = redis.call("GET", dedupe_key)
  if existing_job then
    return {4, existing_job}
  end
end

-- 2. Check concurrency
local current_inflight = tonumber(redis.call("GET", inflight_key) or "0")
if current_inflight >= max_concurrency then
  return {2, tostring(current_inflight)}
end

-- 3. Check daily CPU budget
local current_daily_cpu = tonumber(redis.call("GET", daily_key) or "0")
if (current_daily_cpu + estimated_cpu) > max_daily_cpu then
  return {3, tostring(current_daily_cpu)}
end

-- Allowed: increment in-flight
redis.call("INCR", inflight_key)
redis.call("EXPIRE", inflight_key, 3600)

-- Mark dedupe key if requested
if dedupe_window > 0 and dedupe_key ~= "" then
  redis.call("SET", dedupe_key, job_id, "EX", dedupe_window)
end

return {1, "ok"}
`;

export class QuotaManager {
  private inMemoryInflight = new Map<string, number>();
  private inMemoryDailyCpu = new Map<string, number>();
  private inMemoryDedupe = new Map<string, { jobId: string; expiresAt: number }>();

  async checkAndAcquire(
    user: User,
    language: string,
    sourceCode: string,
    estimatedTimeoutMs: number,
    jobId: string,
    redis?: QuotasRedisClient | null,
    enableDedupeWindowSeconds = 5,
  ): Promise<QuotaCheckResult> {
    if (user.is_banned) {
      return { allowed: false, statusCode: 403, error: "user account is suspended" };
    }

    const tierConfig = TIER_CONFIGS[user.tier] ?? TIER_CONFIGS.anonymous;
    const maxConcurrency = user.concurrency_limit || tierConfig.concurrency_limit;
    const maxDailyCpuMs = user.daily_cpu_ms_limit || tierConfig.daily_cpu_ms_limit;
    const sourceHash = computeSourceHash(language, sourceCode);
    const dateKey = todayDateKey();

    if (redis && typeof redis.eval === "function") {
      try {
        const inflightKey = `kairo:user:${user.id}:inflight`;
        const dailyKey = `kairo:user:${user.id}:daily_cpu:${dateKey}`;
        const dedupeKey = enableDedupeWindowSeconds > 0 ? `kairo:dedupe:${sourceHash}` : "";

        const result = (await redis.eval(LUA_CHECK_AND_ACQUIRE_QUOTA, {
          keys: [inflightKey, dailyKey, dedupeKey],
          arguments: [
            String(maxConcurrency),
            String(maxDailyCpuMs),
            String(estimatedTimeoutMs),
            String(enableDedupeWindowSeconds),
            jobId,
          ],
        })) as [number, string];

        const [code, meta] = result;
        if (code === 1) {
          return { allowed: true, sourceHash };
        }
        if (code === 2) {
          return {
            allowed: false,
            statusCode: 429,
            error: `concurrency limit of ${maxConcurrency} active jobs reached`,
            retryAfter: 2,
          };
        }
        if (code === 3) {
          return {
            allowed: false,
            statusCode: 429,
            error: `daily CPU quota exceeded (${Math.round(maxDailyCpuMs / 1000)}s/day limit)`,
            retryAfter: 60,
          };
        }
        if (code === 4) {
          return {
            allowed: false,
            statusCode: 429,
            error: `duplicate execution detected within cooldown period (existing job: ${meta})`,
            retryAfter: 3,
          };
        }
      } catch {
        // Fall back to memory checks
      }
    }

    // In-memory fallback
    const now = Date.now();
    if (enableDedupeWindowSeconds > 0) {
      const existing = this.inMemoryDedupe.get(sourceHash);
      if (existing && existing.expiresAt > now) {
        return {
          allowed: false,
          statusCode: 429,
          error: `duplicate execution detected within cooldown period (existing job: ${existing.jobId})`,
          retryAfter: 3,
        };
      }
    }

    const currentInflight = this.inMemoryInflight.get(user.id) ?? 0;
    if (currentInflight >= maxConcurrency) {
      return {
        allowed: false,
        statusCode: 429,
        error: `concurrency limit of ${maxConcurrency} active jobs reached`,
        retryAfter: 2,
      };
    }

    const currentDaily = this.inMemoryDailyCpu.get(`${user.id}:${dateKey}`) ?? 0;
    if (currentDaily + estimatedTimeoutMs > maxDailyCpuMs) {
      return {
        allowed: false,
        statusCode: 429,
        error: `daily CPU quota exceeded (${Math.round(maxDailyCpuMs / 1000)}s/day limit)`,
        retryAfter: 60,
      };
    }

    this.inMemoryInflight.set(user.id, currentInflight + 1);
    if (enableDedupeWindowSeconds > 0) {
      this.inMemoryDedupe.set(sourceHash, { jobId, expiresAt: now + enableDedupeWindowSeconds * 1000 });
    }

    return { allowed: true, sourceHash };
  }

  async releaseInflightAndRecordUsage(
    userId: string,
    durationMs: number,
    redis?: QuotasRedisClient | null,
  ): Promise<void> {
    const dateKey = todayDateKey();
    if (redis) {
      try {
        const inflightKey = `kairo:user:${userId}:inflight`;
        const dailyKey = `kairo:user:${userId}:daily_cpu:${dateKey}`;
        if (typeof redis.eval === "function") {
          await redis.eval(
            `
            local current = tonumber(redis.call("GET", KEYS[1]) or "0")
            if current > 0 then
              redis.call("DECR", KEYS[1])
            end
            redis.call("INCRBY", KEYS[2], tonumber(ARGV[1]))
            redis.call("EXPIRE", KEYS[2], 86400 * 2)
            return 1
            `,
            { keys: [inflightKey, dailyKey], arguments: [String(Math.max(0, durationMs))] },
          );
          return;
        }
      } catch {
        // Fall back to memory
      }
    }

    const cur = this.inMemoryInflight.get(userId) ?? 0;
    if (cur > 0) {
      this.inMemoryInflight.set(userId, cur - 1);
    }
    const curDaily = this.inMemoryDailyCpu.get(`${userId}:${dateKey}`) ?? 0;
    this.inMemoryDailyCpu.set(`${userId}:${dateKey}`, curDaily + Math.max(0, durationMs));
  }
}
