import client from "prom-client";

// Collect default Node.js and runtime metrics
export const register = new client.Registry();
client.collectDefaultMetrics({ register, prefix: "kairo_api_" });

// kairo_jobs_total{status, language}
export const jobsTotal = new client.Counter({
  name: "kairo_jobs_total",
  help: "Total count of jobs submitted to or handled by the platform.",
  labelNames: ["status", "language"] as const,
  registers: [register],
});

// kairo_queue_depth
export const queueDepthGauge = new client.Gauge({
  name: "kairo_queue_depth",
  help: "Current depth of the job execution stream in Redis.",
  registers: [register],
});

// kairo_job_duration_seconds
export const jobDurationHistogram = new client.Histogram({
  name: "kairo_job_duration_seconds",
  help: "Execution duration of sandbox jobs in seconds.",
  labelNames: ["language"] as const,
  buckets: [0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0, 30.0, 60.0],
  registers: [register],
});

// kairo_container_start_seconds
export const containerStartHistogram = new client.Histogram({
  name: "kairo_container_start_seconds",
  help: "Container creation and startup latency in seconds.",
  labelNames: ["runtime", "language"] as const,
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1.0, 2.0, 5.0],
  registers: [register],
});

// kairo_worker_active_jobs
export const workerActiveJobsGauge = new client.Gauge({
  name: "kairo_worker_active_jobs",
  help: "Current active jobs executing across the worker fleet.",
  registers: [register],
});

// kairo_output_bytes_total
export const outputBytesCounter = new client.Counter({
  name: "kairo_output_bytes_total",
  help: "Total output bytes emitted by sandbox containers.",
  labelNames: ["stream", "language"] as const,
  registers: [register],
});
