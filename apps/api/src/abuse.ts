import type { Pool } from "pg";
import { setUserBanned } from "./auth.js";

export interface AbuseEvent {
  jobId: string;
  userId: string;
  status: string;
  durationMs: number;
  cpuTimeout: boolean;
}

export interface AbuseClient {
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>;
  incr?(key: string): Promise<number>;
  expire?(key: string, seconds: number): Promise<unknown>;
}

export const LUA_RECORD_TIMEOUT_ABUSE = `
local abuse_key = KEYS[1]
local threshold = tonumber(ARGV[1])
local window_secs = tonumber(ARGV[2])

local count = redis.call("INCR", abuse_key)
if count == 1 then
  redis.call("EXPIRE", abuse_key, window_secs)
end

if count >= threshold then
  return 1 -- Flagged / Ban threshold triggered
else
  return 0
end
`;

export class AbuseDetector {
  private timeoutCounts = new Map<string, { count: number; expiresAt: number }>();
  private readonly threshold: number;
  private readonly windowSeconds: number;

  constructor(options?: { threshold?: number; windowSeconds?: number }) {
    this.threshold = options?.threshold ?? 3; // 3 consecutive timeouts within window
    this.windowSeconds = options?.windowSeconds ?? 300; // 5 minute window
  }

  async recordExecutionOutcome(
    event: AbuseEvent,
    pool?: Pool | null,
    redis?: AbuseClient | null,
  ): Promise<{ shouldBan: boolean }> {
    if (!event.cpuTimeout || !event.userId || event.userId.startsWith("anon_")) {
      return { shouldBan: false };
    }

    let triggered = false;

    if (redis && typeof redis.eval === "function") {
      try {
        const abuseKey = `kairo:abuse:timeout:${event.userId}`;
        const res = (await redis.eval(LUA_RECORD_TIMEOUT_ABUSE, {
          keys: [abuseKey],
          arguments: [String(this.threshold), String(this.windowSeconds)],
        })) as number;
        triggered = res === 1;
      } catch {
        // Fall back to memory
      }
    }

    if (!triggered) {
      const now = Date.now();
      const existing = this.timeoutCounts.get(event.userId);
      if (!existing || existing.expiresAt <= now) {
        this.timeoutCounts.set(event.userId, { count: 1, expiresAt: now + this.windowSeconds * 1000 });
      } else {
        existing.count += 1;
        if (existing.count >= this.threshold) {
          triggered = true;
        }
      }
    }

    if (triggered && pool) {
      try {
        await setUserBanned(pool, event.userId, true);
      } catch {
        // Ignore db failure
      }
    }

    return { shouldBan: triggered };
  }
}
