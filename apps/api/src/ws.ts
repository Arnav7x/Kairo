import type { FastifyRequest } from "fastify";
import type WebSocket from "ws";

export interface StreamEntry {
  id: string;
  message: Record<string, string>;
}

export interface WsRedisDependencies {
  xRange(streamKey: string, start: string, end: string): Promise<StreamEntry[]>;
  get(key: string): Promise<string | null>;
  duplicate(): {
    connect(): Promise<void>;
    subscribe(channel: string, listener: (message: string) => void): Promise<void>;
    unsubscribe(channel: string): Promise<void>;
    quit(): Promise<void>;
    disconnect(): void;
  };
}

export interface WebSocketHubOptions {
  redisClient: WsRedisDependencies;
}

export function handleJobWebSocket(
  socket: WebSocket,
  request: FastifyRequest<{ Params: { id: string }; Querystring: { since?: string } }>,
  redis: WsRedisDependencies,
): void {
  const jobId = request.params.id;
  const since = request.query?.since;

  const streamKey = `kairo:job:${jobId}:events`;
  const channelKey = `kairo:job:${jobId}:events:live`;
  const terminalKey = `kairo:job:${jobId}:terminal`;

  const seenEventIds = new Set<string>();
  let isClosed = false;
  let subClient: ReturnType<WsRedisDependencies["duplicate"]> | null = null;
  const liveBuffer: string[] = [];
  let isReplayDone = false;

  const cleanup = async () => {
    if (isClosed) return;
    isClosed = true;
    if (subClient) {
      try {
        await subClient.unsubscribe(channelKey);
        await subClient.quit();
      } catch {
        subClient.disconnect();
      }
      subClient = null;
    }
  };

  socket.on("close", () => {
    void cleanup();
  });

  socket.on("error", () => {
    void cleanup();
  });

  const sendEvent = (event: unknown) => {
    if (socket.readyState === socket.OPEN && !isClosed) {
      socket.send(typeof event === "string" ? event : JSON.stringify(event));
    }
  };

  const processMessage = (rawMessage: string) => {
    try {
      const payload = JSON.parse(rawMessage) as Record<string, unknown>;

      // Check if it's a terminal result event
      if (payload.event === "result" || payload.status === "completed" || payload.status === "failed") {
        const resultEvent = {
          event: "result",
          id: payload.id ?? "terminal",
          job_id: jobId,
          status: payload.status ?? payload.Status ?? "completed",
          exit_code: payload.exit_code ?? payload.ExitCode ?? 0,
          stdout: payload.stdout ?? payload.Stdout ?? "",
          stderr: payload.stderr ?? payload.Stderr ?? "",
          duration_ms: payload.duration_ms ?? (payload.Duration ? Math.round(Number(payload.Duration) / 1e6) : 0),
          peak_memory_bytes: payload.peak_memory_bytes ?? payload.PeakMemoryBytes ?? 0,
          error_message: payload.error_message ?? payload.ErrorMessage ?? null,
        };
        sendEvent(resultEvent);
        socket.close(1000, "Job execution finished");
        void cleanup();
        return;
      }

      // Output event deduplication
      const eventId = String(payload.id ?? "");
      if (eventId && seenEventIds.has(eventId)) {
        return; // Deduplicate!
      }
      if (eventId) {
        seenEventIds.add(eventId);
      }
      sendEvent(payload);
    } catch {
      sendEvent(rawMessage);
    }
  };

  const start = async () => {
    try {
      // 1. Subscribe to live Pub/Sub first to not miss any in-flight events
      subClient = redis.duplicate();
      await subClient.connect();

      await subClient.subscribe(channelKey, (message: string) => {
        if (!isReplayDone) {
          liveBuffer.push(message);
        } else {
          processMessage(message);
        }
      });

      // 2. Replay from Redis stream
      const startRange = since ? since : "-";
      let entries: StreamEntry[] = [];
      try {
        entries = await redis.xRange(streamKey, startRange, "+");
      } catch {
        entries = [];
      }

      for (const entry of entries) {
        // If 'since' was specified and exact match, skip it
        if (since && entry.id === since) {
          continue;
        }

        try {
          const rawEvent = entry.message.event;
          const parsed = rawEvent ? JSON.parse(rawEvent) : {};
          parsed.id = parsed.id || entry.id;
          parsed.job_id = parsed.job_id || jobId;

          seenEventIds.add(entry.id);
          if (parsed.id) {
            seenEventIds.add(parsed.id);
          }
          sendEvent(parsed);
        } catch {
          seenEventIds.add(entry.id);
          sendEvent({ id: entry.id, job_id: jobId, ...entry.message });
        }
      }

      // 3. Process buffered live messages
      isReplayDone = true;
      while (liveBuffer.length > 0) {
        const msg = liveBuffer.shift();
        if (msg) {
          processMessage(msg);
        }
      }

      // 4. Handle race condition: check if job is already terminal in Redis
      const terminalData = await redis.get(terminalKey);
      if (terminalData && !isClosed) {
        try {
          const parsedResult = JSON.parse(terminalData);
          const terminalEvent = {
            event: "result",
            id: "terminal",
            job_id: jobId,
            status: parsedResult.Status ?? parsedResult.status ?? "completed",
            exit_code: parsedResult.ExitCode ?? parsedResult.exit_code ?? 0,
            stdout: parsedResult.Stdout ?? parsedResult.stdout ?? "",
            stderr: parsedResult.Stderr ?? parsedResult.stderr ?? "",
            duration_ms:
              parsedResult.duration_ms ??
              (parsedResult.Duration ? Math.round(Number(parsedResult.Duration) / 1e6) : 0),
            peak_memory_bytes: parsedResult.PeakMemoryBytes ?? parsedResult.peak_memory_bytes ?? 0,
            error_message: parsedResult.ErrorMessage ?? parsedResult.error_message ?? null,
          };
          sendEvent(terminalEvent);
          socket.close(1000, "Job execution finished");
          void cleanup();
        } catch {
          socket.close(1000, "Job execution finished");
          void cleanup();
        }
      }
    } catch (err) {
      socket.close(1011, "Internal server error");
      void cleanup();
    }
  };

  void start();
}
