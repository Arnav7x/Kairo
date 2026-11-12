import { createHash, randomBytes } from "node:crypto";
import type { Pool } from "pg";

export type UserTier = "anonymous" | "authenticated" | "admin";

export interface User {
  id: string;
  name: string;
  tier: UserTier;
  is_banned: boolean;
  concurrency_limit: number;
  daily_cpu_ms_limit: number;
  created_at: string;
}

export interface ApiKeyRecord {
  id: string;
  user_id: string;
  key_hash: string;
  prefix: string;
  created_at: string;
}

export interface TierConfig {
  concurrency_limit: number;
  daily_cpu_ms_limit: number; // in milliseconds
  default_timeout_ms: number;
  max_timeout_ms: number;
  max_memory_mb: number;
}

export const TIER_CONFIGS: Record<UserTier, TierConfig> = {
  anonymous: {
    concurrency_limit: 10,
    daily_cpu_ms_limit: 600 * 1000, // 600 seconds of CPU per day
    default_timeout_ms: 10000,
    max_timeout_ms: 30000,
    max_memory_mb: 1024,
  },
  authenticated: {
    concurrency_limit: 25,
    daily_cpu_ms_limit: 3600 * 1000, // 1 hour of CPU per day
    default_timeout_ms: 15000,
    max_timeout_ms: 60000,
    max_memory_mb: 1024,
  },
  admin: {
    concurrency_limit: 100,
    daily_cpu_ms_limit: 86400 * 1000, // Unrestricted / very high
    default_timeout_ms: 30000,
    max_timeout_ms: 120000,
    max_memory_mb: 2048,
  },
};

export function hashApiKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

export function generateApiKey(): { key: string; prefix: string; hash: string } {
  const secret = randomBytes(24).toString("hex");
  const key = `kro_${secret}`;
  const prefix = key.slice(0, 8);
  const hash = hashApiKey(key);
  return { key, prefix, hash };
}

export async function lookupUserByApiKey(pool: Pool, rawKey: string): Promise<User | null> {
  const hash = hashApiKey(rawKey);
  const query = `
    SELECT u.id, u.name, u.tier, u.is_banned, u.concurrency_limit, u.daily_cpu_ms_limit, u.created_at
    FROM users u
    JOIN api_keys k ON u.id = k.user_id
    WHERE k.key_hash = $1
    LIMIT 1;
  `;
  const result = await pool.query(query, [hash]);
  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  return {
    id: String(row.id),
    name: String(row.name),
    tier: row.tier as UserTier,
    is_banned: Boolean(row.is_banned),
    concurrency_limit: Number(row.concurrency_limit),
    daily_cpu_ms_limit: Number(row.daily_cpu_ms_limit),
    created_at: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
  };
}

export async function getUserById(pool: Pool, userId: string): Promise<User | null> {
  const query = `
    SELECT id, name, tier, is_banned, concurrency_limit, daily_cpu_ms_limit, created_at
    FROM users
    WHERE id = $1
    LIMIT 1;
  `;
  const result = await pool.query(query, [userId]);
  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  return {
    id: String(row.id),
    name: String(row.name),
    tier: row.tier as UserTier,
    is_banned: Boolean(row.is_banned),
    concurrency_limit: Number(row.concurrency_limit),
    daily_cpu_ms_limit: Number(row.daily_cpu_ms_limit),
    created_at: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
  };
}

export async function setUserBanned(pool: Pool, userId: string, banned: boolean): Promise<boolean> {
  const query = `UPDATE users SET is_banned = $1, updated_at = NOW() WHERE id = $2 RETURNING id;`;
  const res = await pool.query(query, [banned, userId]);
  return (res.rowCount ?? 0) > 0;
}
