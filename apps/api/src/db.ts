import type { Pool } from "pg";
import type { ValidatedJob } from "./validation.js";

export interface JobRecord {
  id: string;
  language: string;
  source_code: string;
  stdin: string | null;
  args: string[] | null;
  limits: Record<string, unknown>;
  status: string;
  exit_code: number | null;
  stdout: string | null;
  stderr: string | null;
  duration_ms: number | null;
  peak_memory_bytes: number | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface TerminalExecutionResult {
  Status?: string;
  status?: string;
  ExitCode?: number;
  exit_code?: number;
  Stdout?: string;
  stdout?: string;
  Stderr?: string;
  stderr?: string;
  Duration?: number; // nanoseconds in Go
  duration_ms?: number;
  PeakMemoryBytes?: number;
  peak_memory_bytes?: number;
  ErrorMessage?: string;
  error_message?: string;
}

export interface JobSummary {
  id: string;
  language: string;
  status: string;
  exit_code: number | null;
  duration_ms: number | null;
  peak_memory_bytes: number | null;
  error_message: string | null;
  created_at: string;
  completed_at: string | null;
}

export interface ListJobsOptions {
  limit?: number;
  status?: string;
}

export async function initDb(pool: Pool): Promise<void> {
  const schema = `
    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT NOT NULL,
      tier TEXT NOT NULL DEFAULT 'authenticated',
      is_banned BOOLEAN NOT NULL DEFAULT FALSE,
      concurrency_limit INTEGER NOT NULL DEFAULT 5,
      daily_cpu_ms_limit BIGINT NOT NULL DEFAULT 600000,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS api_keys (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      key_hash TEXT NOT NULL UNIQUE,
      prefix TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys (key_hash);

    CREATE TABLE IF NOT EXISTS jobs (
      id UUID PRIMARY KEY,
      user_id UUID REFERENCES users(id) ON DELETE SET NULL,
      language TEXT NOT NULL,
      source_code TEXT NOT NULL,
      stdin TEXT,
      args JSONB,
      limits JSONB NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      exit_code INTEGER,
      stdout TEXT,
      stderr TEXT,
      duration_ms BIGINT,
      peak_memory_bytes BIGINT,
      error_message TEXT,
      source_hash TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs (status);
    CREATE INDEX IF NOT EXISTS idx_jobs_created_at ON jobs (created_at);
    CREATE INDEX IF NOT EXISTS idx_jobs_user_id ON jobs (user_id);
    CREATE INDEX IF NOT EXISTS idx_jobs_source_hash ON jobs (source_hash);
  `;
  await pool.query(schema);
}

export async function insertJob(
  pool: Pool,
  job: ValidatedJob,
  userId?: string | null,
  sourceHash?: string | null,
): Promise<JobRecord> {
  const query = `
    INSERT INTO jobs (id, user_id, language, source_code, stdin, args, limits, status, source_hash, created_at, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, 'queued', $8, NOW(), NOW())
    RETURNING *;
  `;
  const res = await pool.query(query, [
    job.id,
    userId ?? null,
    job.language,
    job.source_code,
    job.stdin ?? null,
    job.args ? JSON.stringify(job.args) : null,
    JSON.stringify(job.limits),
    sourceHash ?? null,
  ]);
  return formatJobRow(res.rows[0]);
}

export async function updateJobTerminal(
  pool: Pool,
  jobId: string,
  result: TerminalExecutionResult,
): Promise<JobRecord | null> {
  const status = result.Status ?? result.status ?? "completed";
  const exitCode = result.ExitCode ?? result.exit_code ?? 0;
  const stdout = result.Stdout ?? result.stdout ?? "";
  const stderr = result.Stderr ?? result.stderr ?? "";
  const durationMs = result.duration_ms ?? (result.Duration ? Math.round(result.Duration / 1e6) : 0);
  const peakMemoryBytes = result.PeakMemoryBytes ?? result.peak_memory_bytes ?? 0;
  const errorMessage = result.ErrorMessage ?? result.error_message ?? null;

  const query = `
    UPDATE jobs
    SET status = $2,
        exit_code = $3,
        stdout = $4,
        stderr = $5,
        duration_ms = $6,
        peak_memory_bytes = $7,
        error_message = $8,
        updated_at = NOW(),
        completed_at = NOW()
    WHERE id = $1
    RETURNING *;
  `;
  const res = await pool.query(query, [
    jobId,
    status,
    exitCode,
    stdout,
    stderr,
    durationMs,
    peakMemoryBytes,
    errorMessage,
  ]);

  if (res.rowCount === 0) {
    return null;
  }
  return formatJobRow(res.rows[0]);
}

export async function getJobById(pool: Pool, jobId: string): Promise<JobRecord | null> {
  const res = await pool.query("SELECT * FROM jobs WHERE id = $1", [jobId]);
  if (res.rowCount === 0) {
    return null;
  }
  return formatJobRow(res.rows[0]);
}

export async function listJobs(pool: Pool, options: ListJobsOptions = {}): Promise<JobSummary[]> {
  const limit = Math.min(Math.max(Number(options.limit ?? 25) || 25, 1), 100);
  const params: unknown[] = [];
  let where = "";
  if (options.status) {
    params.push(options.status);
    where = `WHERE status = $${params.length}`;
  }

  const query = `
    SELECT id, language, status, exit_code, duration_ms, peak_memory_bytes,
           error_message, created_at, completed_at
    FROM jobs
    ${where}
    ORDER BY created_at DESC
    LIMIT $${params.length + 1};
  `;
  params.push(limit);
  const res = await pool.query(query, params);
  return res.rows.map(formatJobSummary);
}

function formatJobSummary(row: Record<string, unknown>): JobSummary {
  return {
    id: String(row.id),
    language: String(row.language),
    status: String(row.status),
    exit_code: row.exit_code !== null && row.exit_code !== undefined ? Number(row.exit_code) : null,
    duration_ms: row.duration_ms !== null && row.duration_ms !== undefined ? Number(row.duration_ms) : null,
    peak_memory_bytes:
      row.peak_memory_bytes !== null && row.peak_memory_bytes !== undefined ? Number(row.peak_memory_bytes) : null,
    error_message: row.error_message ? String(row.error_message) : null,
    created_at: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    completed_at:
      row.completed_at instanceof Date
        ? row.completed_at.toISOString()
        : row.completed_at
          ? String(row.completed_at)
          : null,
  };
}

function formatJobRow(row: Record<string, unknown>): JobRecord {
  return {
    id: String(row.id),
    language: String(row.language),
    source_code: String(row.source_code),
    stdin: row.stdin ? String(row.stdin) : null,
    args: typeof row.args === "string" ? JSON.parse(row.args) : (row.args as string[] | null) ?? null,
    limits: typeof row.limits === "string" ? JSON.parse(row.limits) : (row.limits as Record<string, unknown>) ?? {},
    status: String(row.status),
    exit_code: row.exit_code !== null && row.exit_code !== undefined ? Number(row.exit_code) : null,
    stdout: row.stdout !== null && row.stdout !== undefined ? String(row.stdout) : null,
    stderr: row.stderr !== null && row.stderr !== undefined ? String(row.stderr) : null,
    duration_ms: row.duration_ms !== null && row.duration_ms !== undefined ? Number(row.duration_ms) : null,
    peak_memory_bytes:
      row.peak_memory_bytes !== null && row.peak_memory_bytes !== undefined ? Number(row.peak_memory_bytes) : null,
    error_message: row.error_message ? String(row.error_message) : null,
    created_at: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    updated_at: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
    completed_at:
      row.completed_at instanceof Date
        ? row.completed_at.toISOString()
        : row.completed_at
          ? String(row.completed_at)
          : null,
  };
}
