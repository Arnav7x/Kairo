import { randomUUID } from "node:crypto";

export interface Limits {
  timeout_ms: number;
  memory_mb: number;
  output_bytes: number;
  cpu_nano_cores: number;
  pids_limit: number;
}

export interface LimitsInput {
  timeout_ms?: number;
  timeoutMs?: number;
  TimeoutMS?: number;
  memory_mb?: number;
  memoryMb?: number;
  MemoryMB?: number;
  output_bytes?: number;
  outputBytes?: number;
  OutputBytes?: number;
  cpu_nano_cores?: number;
  cpuNanoCores?: number;
  CPUNanoCores?: number;
  pids_limit?: number;
  pidsLimit?: number;
  PidsLimit?: number;
}

export interface JobSubmission {
  language: string;
  source_code: string;
  stdin?: string;
  args?: string[];
  limits?: LimitsInput;
}

export interface ValidatedJob {
  id: string;
  language: string;
  source_code: string;
  stdin?: string;
  args?: string[];
  limits: Limits;
}

export interface ValidationConfig {
  allowedLanguages: string[];
  maxSourceBytes: number;
  maxStdinBytes: number;
  minTimeoutMs: number;
  maxTimeoutMs: number;
  defaultTimeoutMs: number;
  minMemoryMb: number;
  maxMemoryMb: number;
  defaultMemoryMb: number;
  minOutputBytes: number;
  maxOutputBytes: number;
  defaultOutputBytes: number;
  minCpuNanoCores: number;
  maxCpuNanoCores: number;
  defaultCpuNanoCores: number;
  minPidsLimit: number;
  maxPidsLimit: number;
  defaultPidsLimit: number;
}

export const DEFAULT_CONFIG: ValidationConfig = {
  allowedLanguages: (process.env.KAIRO_ALLOWED_LANGUAGES ?? "python,go,node,rust,cpp,c,bash,java")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
  maxSourceBytes: Number(process.env.KAIRO_MAX_SOURCE_BYTES ?? 262144), // 256 KB
  maxStdinBytes: Number(process.env.KAIRO_MAX_STDIN_BYTES ?? 262144),   // 256 KB
  minTimeoutMs: 1000,
  maxTimeoutMs: Number(process.env.KAIRO_MAX_TIMEOUT_MS ?? 30000),     // 30s
  defaultTimeoutMs: 10000,
  minMemoryMb: 32,
  maxMemoryMb: Number(process.env.KAIRO_MAX_MEMORY_MB ?? 1024),        // 1024 MB
  defaultMemoryMb: 256,
  minOutputBytes: 1024,
  maxOutputBytes: Number(process.env.KAIRO_MAX_OUTPUT_BYTES ?? 1048576), // 1 MB
  defaultOutputBytes: 1048576,
  minCpuNanoCores: 100_000_000,                                        // 0.1 CPU
  maxCpuNanoCores: 2_000_000_000,                                      // 2.0 CPU
  defaultCpuNanoCores: 500_000_000,                                    // 0.5 CPU
  minPidsLimit: 16,
  maxPidsLimit: 256,
  defaultPidsLimit: 64,
};

function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value) || !Number.isFinite(value)) {
    return min;
  }
  return Math.min(Math.max(Math.floor(value), min), max);
}

export function clampLimits(input?: LimitsInput, config: ValidationConfig = DEFAULT_CONFIG): Limits {
  const rawTimeout = input?.timeout_ms ?? input?.timeoutMs ?? input?.TimeoutMS;
  const rawMemory = input?.memory_mb ?? input?.memoryMb ?? input?.MemoryMB;
  const rawOutput = input?.output_bytes ?? input?.outputBytes ?? input?.OutputBytes;
  const rawCpu = input?.cpu_nano_cores ?? input?.cpuNanoCores ?? input?.CPUNanoCores;
  const rawPids = input?.pids_limit ?? input?.pidsLimit ?? input?.PidsLimit;

  return {
    timeout_ms: rawTimeout !== undefined
      ? clamp(rawTimeout, config.minTimeoutMs, config.maxTimeoutMs)
      : config.defaultTimeoutMs,
    memory_mb: rawMemory !== undefined
      ? clamp(rawMemory, config.minMemoryMb, config.maxMemoryMb)
      : config.defaultMemoryMb,
    output_bytes: rawOutput !== undefined
      ? clamp(rawOutput, config.minOutputBytes, config.maxOutputBytes)
      : config.defaultOutputBytes,
    cpu_nano_cores: rawCpu !== undefined
      ? clamp(rawCpu, config.minCpuNanoCores, config.maxCpuNanoCores)
      : config.defaultCpuNanoCores,
    pids_limit: rawPids !== undefined
      ? clamp(rawPids, config.minPidsLimit, config.maxPidsLimit)
      : config.defaultPidsLimit,
  };
}

export type ValidationResult =
  | { success: true; job: ValidatedJob }
  | { success: false; statusCode: number; error: string };

export function validateJobSubmission(
  body: unknown,
  config: ValidationConfig = DEFAULT_CONFIG,
): ValidationResult {
  if (!body || typeof body !== "object") {
    return { success: false, statusCode: 400, error: "request body must be a JSON object" };
  }

  const raw = body as Partial<JobSubmission>;

  if (typeof raw.language !== "string" || raw.language.trim() === "") {
    return { success: false, statusCode: 400, error: "language is required and must be a string" };
  }

  const normalizedLanguage = raw.language.trim().toLowerCase();
  if (!config.allowedLanguages.includes(normalizedLanguage)) {
    return {
      success: false,
      statusCode: 400,
      error: `Unsupported language: '${raw.language}'. Allowed languages: ${config.allowedLanguages.join(", ")}`,
    };
  }

  if (typeof raw.source_code !== "string" || raw.source_code === "") {
    return { success: false, statusCode: 400, error: "source_code is required and must be a non-empty string" };
  }

  const sourceBytes = Buffer.byteLength(raw.source_code, "utf8");
  if (sourceBytes > config.maxSourceBytes) {
    return {
      success: false,
      statusCode: 413,
      error: `source_code size (${sourceBytes} bytes) exceeds maximum allowed limit of ${config.maxSourceBytes} bytes`,
    };
  }

  let stdin: string | undefined;
  if (raw.stdin !== undefined) {
    if (typeof raw.stdin !== "string") {
      return { success: false, statusCode: 400, error: "stdin must be a string if provided" };
    }
    const stdinBytes = Buffer.byteLength(raw.stdin, "utf8");
    if (stdinBytes > config.maxStdinBytes) {
      return {
        success: false,
        statusCode: 413,
        error: `stdin size (${stdinBytes} bytes) exceeds maximum allowed limit of ${config.maxStdinBytes} bytes`,
      };
    }
    stdin = raw.stdin;
  }

  let args: string[] | undefined;
  if (raw.args !== undefined) {
    if (!Array.isArray(raw.args) || !raw.args.every((a) => typeof a === "string")) {
      return { success: false, statusCode: 400, error: "args must be an array of strings" };
    }
    if (raw.args.length > 100) {
      return { success: false, statusCode: 400, error: "args array exceeds maximum length of 100 items" };
    }
    args = raw.args;
  }

  const limits = clampLimits(raw.limits, config);

  return {
    success: true,
    job: {
      id: randomUUID(),
      language: normalizedLanguage,
      source_code: raw.source_code,
      stdin,
      args,
      limits,
    },
  };
}
