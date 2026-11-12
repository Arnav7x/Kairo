import {
  isTerminalStatus,
  wsUrl,
  type OutputEvent,
  type ResultEvent,
} from "./api.js";

export type StreamState = "connecting" | "live" | "reconnecting" | "closed";

export interface StreamHandlers {
  onOutput?: (event: OutputEvent) => void;
  onResult?: (event: ResultEvent) => void;
  onState?: (state: StreamState) => void;
  onFatal?: (reason: string) => void;
}

export class JobStream {
  private handlers: StreamHandlers = {};
  private socket: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  private disposed = false;
  private lastEventId: string | undefined;
  private readonly seen = new Set<string>();

  setHandlers(handlers: StreamHandlers): void {
    this.handlers = handlers;
  }

  open(jobId: string, since?: string): void {
    if (since !== undefined) {
      this.lastEventId = since;
    }
    this.attempt = 0;
    this.disposed = false;
    this.replaceSocket(jobId);
  }

  dispose(): void {
    this.disposed = true;
    this.clearTimer();
    this.freeNode();
    this.handlers.onState?.("closed");
  }

  private clearTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private freeNode(): void {
    if (!this.socket) return;
    this.socket.onopen = null;
    this.socket.onmessage = null;
    this.socket.onerror = null;
    this.socket.onclose = null;
    try {
      this.socket.close(1000);
    } catch {
      try {
        this.socket.close();
      } catch {
        // already closed
      }
    }
    this.socket = null;
  }

  private replaceSocket(jobId: string): void {
    this.freeNode();
    this.clearTimer();
    const socket = new WebSocket(wsUrl(jobId, this.lastEventId));
    this.socket = socket;

    socket.onopen = () => {
      this.attempt = 0;
      this.handlers.onState?.("live");
    };

    socket.onmessage = (message: MessageEvent<string>) => this.ingest(jobId, message.data);

    socket.onclose = (close) => {
      this.socket = null;
      if (this.disposed) return;
      if (close.wasClean) {
        this.handlers.onState?.("closed");
        this.disposed = true;
        return;
      }
      this.scheduleReconnect(jobId);
    };

    socket.onerror = () => {};
  }

  private ingest(jobId: string, raw: string): void {
    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      this.handlers.onOutput?.({ id: "", job_id: jobId, stream: "stdout", data: raw });
      return;
    }

    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      this.handlers.onOutput?.({ id: "", job_id: jobId, stream: "stdout", data: raw });
      return;
    }

    const event = payload as Record<string, unknown>;
    const kind = event.event as string | undefined;
    const status = event.status as string | undefined;

    if (kind === "result" || (status !== undefined && isTerminalStatus(status))) {
      this.handlers.onResult?.({
        event: "result",
        id: String(event.id ?? "terminal"),
        job_id: jobId,
        status: status ?? "completed",
        exit_code: Number(event.exit_code ?? 0),
        stdout: String(event.stdout ?? ""),
        stderr: String(event.stderr ?? ""),
        duration_ms: Number(event.duration_ms ?? 0),
        peak_memory_bytes: Number(event.peak_memory_bytes ?? 0),
        error_message: (event.error_message as string | null) ?? null,
      });
      this.disposed = true;
      this.freeNode();
      this.handlers.onState?.("closed");
      return;
    }

    const id = String(event.id ?? "");
    if (id) {
      if (this.seen.has(id)) return;
      this.seen.add(id);
      this.lastEventId = id;
    }

    this.handlers.onOutput?.({
      id,
      job_id: String(event.job_id ?? jobId),
      phase: event.phase as string | undefined,
      stream: event.stream === "stderr" ? "stderr" : "stdout",
      data: String(event.data ?? ""),
      timestamp: event.timestamp as string | undefined,
    });
  }

  private scheduleReconnect(jobId: string): void {
    if (this.disposed || this.reconnectTimer) return;
    this.attempt += 1;
    if (this.attempt > 8) {
      this.handlers.onState?.("closed");
      this.handlers.onFatal?.("lost connection to job stream after 8 attempts");
      return;
    }
    const delay = Math.min(500 * 2 ** (this.attempt - 1), 5000);
    const jitter = delay * (0.75 + Math.random() * 0.5);
    this.handlers.onState?.("reconnecting");
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.replaceSocket(jobId);
    }, jitter);
  }
}

export function formatBytes(bytes: number | null | undefined): string {
  if (!bytes || bytes <= 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

export function formatMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "—";
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}
