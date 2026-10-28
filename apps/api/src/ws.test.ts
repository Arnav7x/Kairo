import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type WebSocket from "ws";

import { handleJobWebSocket, type StreamEntry, type WsRedisDependencies } from "./ws.js";

class MockWebSocket extends EventEmitter {
  public OPEN = 1;
  public readyState = 1;
  public sent: string[] = [];
  public closedWith: { code?: number; reason?: string } | null = null;

  send(data: string) {
    this.sent.push(data);
  }

  close(code?: number, reason?: string) {
    this.readyState = 3; // CLOSED
    this.closedWith = { code, reason: reason?.toString() };
    this.emit("close");
  }
}

test("WebSocket hub replays from stream and follows live PubSub without duplicates", async () => {
  const jobId = "job-test-1";
  const channelKey = `kairo:job:${jobId}:events:live`;

  // Pre-existing stream events
  const streamEntries: StreamEntry[] = [
    {
      id: "1000-0",
      message: {
        event: JSON.stringify({ id: "1000-0", job_id: jobId, stream: "stdout", data: "line 1\n" }),
      },
    },
    {
      id: "1001-0",
      message: {
        event: JSON.stringify({ id: "1001-0", job_id: jobId, stream: "stdout", data: "line 2\n" }),
      },
    },
  ];

  let pubSubHandler!: (msg: string) => void;

  const mockRedis: WsRedisDependencies = {
    xRange: async () => streamEntries,
    get: async () => null, // not finished yet
    duplicate: () => ({
      connect: async () => {},
      subscribe: async (_channel, cb) => {
        pubSubHandler = cb;
      },
      unsubscribe: async () => {},
      quit: async () => {},
      disconnect: () => {},
    }),
  };

  const socket = new MockWebSocket();
  const request = {
    params: { id: jobId },
    query: {},
  } as any;

  handleJobWebSocket(socket as unknown as WebSocket, request, mockRedis);

  // Wait a tick for async replay to finish
  await new Promise((r) => setTimeout(r, 20));

  assert.equal(socket.sent.length, 2);
  assert.equal(JSON.parse(socket.sent[0]).data, "line 1\n");
  assert.equal(JSON.parse(socket.sent[1]).data, "line 2\n");

  // Send a duplicate of line 2 via Pub/Sub (simulating race between stream & pubsub)
  assert.ok(pubSubHandler);
  pubSubHandler(JSON.stringify({ id: "1001-0", job_id: jobId, stream: "stdout", data: "line 2\n" }));

  // Should NOT be sent again (deduplicated!)
  assert.equal(socket.sent.length, 2);

  // Send a new live event
  pubSubHandler(JSON.stringify({ id: "1002-0", job_id: jobId, stream: "stderr", data: "warning\n" }));
  assert.equal(socket.sent.length, 3);
  assert.equal(JSON.parse(socket.sent[2]).data, "warning\n");

  // Send terminal result event
  pubSubHandler(
    JSON.stringify({
      event: "result",
      id: "terminal",
      job_id: jobId,
      status: "completed",
      exit_code: 0,
    }),
  );

  assert.equal(socket.sent.length, 4);
  const resultEvent = JSON.parse(socket.sent[3]);
  assert.equal(resultEvent.event, "result");
  assert.equal(resultEvent.status, "completed");

  // Socket must be closed with code 1000
  assert.equal(socket.closedWith?.code, 1000);
});

test("WebSocket hub handles mid-run reconnection honoring 'since' query parameter", async () => {
  const jobId = "job-reconnect";

  const streamEntries: StreamEntry[] = [
    {
      id: "100-0",
      message: { event: JSON.stringify({ id: "100-0", job_id: jobId, stream: "stdout", data: "already received\n" }) },
    },
    {
      id: "101-0",
      message: { event: JSON.stringify({ id: "101-0", job_id: jobId, stream: "stdout", data: "missed line\n" }) },
    },
  ];

  let rangeStartQueried = "";
  const mockRedis: WsRedisDependencies = {
    xRange: async (_key, start) => {
      rangeStartQueried = start;
      // return only entries starting from `start`
      return streamEntries.filter((e) => e.id >= start);
    },
    get: async () => null,
    duplicate: () => ({
      connect: async () => {},
      subscribe: async () => {},
      unsubscribe: async () => {},
      quit: async () => {},
      disconnect: () => {},
    }),
  };

  const socket = new MockWebSocket();
  const request = {
    params: { id: jobId },
    query: { since: "100-0" },
  } as any;

  handleJobWebSocket(socket as unknown as WebSocket, request, mockRedis);
  await new Promise((r) => setTimeout(r, 20));

  assert.equal(rangeStartQueried, "100-0");
  // Only entry 101-0 should be sent, skipping 100-0 since it was 'since'
  assert.equal(socket.sent.length, 1);
  assert.equal(JSON.parse(socket.sent[0]).data, "missed line\n");
});

test("WebSocket hub handles late connection race: job already finished before connect", async () => {
  const jobId = "job-finished";

  const streamEntries: StreamEntry[] = [
    {
      id: "50-0",
      message: { event: JSON.stringify({ id: "50-0", job_id: jobId, stream: "stdout", data: "complete output\n" }) },
    },
  ];

  const terminalData = JSON.stringify({
    Status: "completed",
    ExitCode: 0,
    Stdout: "complete output\n",
    Duration: 500000000, // 500ms
  });

  const mockRedis: WsRedisDependencies = {
    xRange: async () => streamEntries,
    get: async (key) => (key.includes("terminal") ? terminalData : null),
    duplicate: () => ({
      connect: async () => {},
      subscribe: async () => {},
      unsubscribe: async () => {},
      quit: async () => {},
      disconnect: () => {},
    }),
  };

  const socket = new MockWebSocket();
  const request = {
    params: { id: jobId },
    query: {},
  } as any;

  handleJobWebSocket(socket as unknown as WebSocket, request, mockRedis);
  await new Promise((r) => setTimeout(r, 20));

  // Should have received replay AND terminal result event
  assert.equal(socket.sent.length, 2);
  assert.equal(JSON.parse(socket.sent[0]).data, "complete output\n");

  const terminalEvent = JSON.parse(socket.sent[1]);
  assert.equal(terminalEvent.event, "result");
  assert.equal(terminalEvent.status, "completed");
  assert.equal(terminalEvent.duration_ms, 500);

  // Closed with code 1000
  assert.equal(socket.closedWith?.code, 1000);
});
