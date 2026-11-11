export type JobStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "timeout"
  | "oom_killed"
  | "output_limit"
  | "cancelled"
  | "internal_error"
  | string;

export interface LanguageInfo {
  id: string;
  name?: string;
  compiled?: boolean;
}

export interface JobRecord {
  id: string;
  language: string;
  source_code?: string;
  status: JobStatus;
  exit_code: number | null;
  stdout: string | null;
  stderr: string | null;
  duration_ms: number | null;
  peak_memory_bytes: number | null;
  error_message: string | null;
  created_at?: string;
  completed_at?: string | null;
}

export interface JobSummary {
  id: string;
  language: string;
  status: JobStatus;
  exit_code: number | null;
  duration_ms: number | null;
  peak_memory_bytes: number | null;
  error_message: string | null;
  created_at: string;
  completed_at: string | null;
}

export interface SubmitResponse {
  job_id: string;
  status: JobStatus;
  language: string;
  limits?: Record<string, number>;
}

export interface OutputEvent {
  id: string;
  job_id: string;
  phase?: string;
  stream: "stdout" | "stderr";
  data: string;
  timestamp?: string;
}

export interface ResultEvent {
  event: "result";
  id: string;
  job_id: string;
  status: JobStatus;
  exit_code: number;
  stdout: string;
  stderr: string;
  duration_ms: number;
  peak_memory_bytes: number;
  error_message: string | null;
}

const TERMINAL_STATUSES = new Set([
  "completed",
  "failed",
  "timeout",
  "oom_killed",
  "output_limit",
  "cancelled",
  "internal_error",
]);

export function isTerminalStatus(status: JobStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  const text = await response.text();
  const body = text ? (JSON.parse(text) as unknown) : null;
  if (!response.ok) {
    const message =
      body && typeof body === "object" && "error" in body
        ? String((body as { error: unknown }).error)
        : `HTTP ${response.status}`;
    throw new Error(message);
  }
  return body as T;
}

export function fetchLanguages(): Promise<{ languages: LanguageInfo[] }> {
  return request("/v1/languages");
}

export function submitJob(payload: {
  language: string;
  source_code: string;
  stdin?: string;
}): Promise<SubmitResponse> {
  return request("/v1/jobs", { method: "POST", body: JSON.stringify(payload) });
}

export function fetchJob(id: string): Promise<JobRecord> {
  return request(`/v1/jobs/${encodeURIComponent(id)}`);
}

export function fetchJobs(limit = 25): Promise<{ jobs: JobSummary[] }> {
  return request(`/v1/jobs?limit=${limit}`);
}

export function cancelJob(id: string): Promise<{ id: string; status: string }> {
  return request(`/v1/jobs/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export function wsUrl(id: string, since?: string): string {
  const proto = globalThis.location.protocol === "https:" ? "wss" : "ws";
  const query = since ? `?since=${encodeURIComponent(since)}` : "";
  return `${proto}://${globalThis.location.host}/v1/jobs/${encodeURIComponent(id)}/ws${query}`;
}
