export interface RateLimitOptions {
  capacity?: number;
  refillRate?: number; // tokens per second
  cost?: number;
  ttlSeconds?: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfter: number; // in seconds
  limit: number;
  resetTime: number; // timestamp in seconds
  backpressure?: boolean;
}

export interface RedisRateLimiterClient {
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>;
  xLen?(streamKey: string): Promise<number>;
}

const LUA_TOKEN_BUCKET = `
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refill_rate = tonumber(ARGV[2])
local cost = tonumber(ARGV[3])
local now = tonumber(ARGV[4])
local ttl = tonumber(ARGV[5])

local data = redis.call("HMGET", key, "tokens", "last_refill")
local tokens = tonumber(data[1])
local last_refill = tonumber(data[2])

if tokens == nil then
  tokens = capacity
  last_refill = now
else
  local delta = math.max(0, (now - last_refill) / 1000)
  tokens = math.min(capacity, tokens + delta * refill_rate)
  last_refill = now
end

if tokens >= cost then
  tokens = tokens - cost
  redis.call("HMSET", key, "tokens", tokens, "last_refill", last_refill)
  redis.call("EXPIRE", key, ttl)
  return {1, math.floor(tokens), 0}
else
  redis.call("HMSET", key, "tokens", tokens, "last_refill", last_refill)
  redis.call("EXPIRE", key, ttl)
  local missing = cost - tokens
  local retry_after = math.ceil(missing / refill_rate)
  if retry_after < 1 then retry_after = 1 end
  return {0, math.floor(tokens), retry_after}
end
`;

export class TokenBucketLimiter {
  private inMemoryBuckets = new Map<string, { tokens: number; lastRefill: number }>();
  private readonly capacity: number;
  private readonly refillRate: number;
  private readonly ttlSeconds: number;

  constructor(options?: RateLimitOptions) {
    this.capacity = options?.capacity ?? Number(process.env.KAIRO_RATE_LIMIT_CAPACITY ?? 20);
    this.refillRate = options?.refillRate ?? Number(process.env.KAIRO_RATE_LIMIT_REFILL_RATE ?? 5);
    this.ttlSeconds = options?.ttlSeconds ?? 60;
  }

  async checkLimit(
    identifier: string,
    redisClient?: RedisRateLimiterClient | null,
    cost = 1,
  ): Promise<RateLimitResult> {
    const nowMs = Date.now();
    const nowSec = Math.floor(nowMs / 1000);

    if (redisClient && typeof redisClient.eval === "function") {
      try {
        const key = `kairo:ratelimit:${identifier}`;
        const res = (await redisClient.eval(LUA_TOKEN_BUCKET, {
          keys: [key],
          arguments: [
            this.capacity.toString(),
            this.refillRate.toString(),
            cost.toString(),
            nowMs.toString(),
            this.ttlSeconds.toString(),
          ],
        })) as [number, number, number];

        const [allowedNum, remaining, retryAfter] = res;
        return {
          allowed: allowedNum === 1,
          remaining: Math.max(0, remaining),
          retryAfter,
          limit: this.capacity,
          resetTime: nowSec + retryAfter,
        };
      } catch (err) {
        // Fallback to in-memory on eval failure
      }
    }

    // In-memory fallback
    const bucket = this.inMemoryBuckets.get(identifier) ?? {
      tokens: this.capacity,
      lastRefill: nowMs,
    };

    const delta = Math.max(0, (nowMs - bucket.lastRefill) / 1000);
    bucket.tokens = Math.min(this.capacity, bucket.tokens + delta * this.refillRate);
    bucket.lastRefill = nowMs;

    if (bucket.tokens >= cost) {
      bucket.tokens -= cost;
      this.inMemoryBuckets.set(identifier, bucket);
      return {
        allowed: true,
        remaining: Math.floor(bucket.tokens),
        retryAfter: 0,
        limit: this.capacity,
        resetTime: nowSec,
      };
    }

    const missing = cost - bucket.tokens;
    const retryAfter = Math.max(1, Math.ceil(missing / this.refillRate));
    this.inMemoryBuckets.set(identifier, bucket);
    return {
      allowed: false,
      remaining: Math.max(0, Math.floor(bucket.tokens)),
      retryAfter,
      limit: this.capacity,
      resetTime: nowSec + retryAfter,
    };
  }
}

export async function checkQueueBackpressure(
  redisClient: { xLen?(streamKey: string): Promise<number> } | null | undefined,
  maxQueueDepth = Number(process.env.KAIRO_MAX_QUEUE_DEPTH ?? 1000),
): Promise<{ overloaded: boolean; queueDepth: number; retryAfter: number }> {
  if (!redisClient || typeof redisClient.xLen !== "function") {
    return { overloaded: false, queueDepth: 0, retryAfter: 0 };
  }

  try {
    const queueDepth = await redisClient.xLen("kairo:jobs");
    if (queueDepth >= maxQueueDepth) {
      return { overloaded: true, queueDepth, retryAfter: 5 };
    }
    return { overloaded: false, queueDepth, retryAfter: 0 };
  } catch {
    return { overloaded: false, queueDepth: 0, retryAfter: 0 };
  }
}
