import assert from "node:assert/strict";
import test from "node:test";

import { clampLimits, validateJobSubmission } from "./validation.js";

test("clampLimits applies floors, ceilings, and defaults", () => {
  // Empty limits gets all defaults
  const defaults = clampLimits(undefined);
  assert.equal(defaults.timeout_ms, 10000);
  assert.equal(defaults.memory_mb, 256);
  assert.equal(defaults.output_bytes, 1048576);
  assert.equal(defaults.cpu_nano_cores, 500_000_000);
  assert.equal(defaults.pids_limit, 64);

  // Values below floor are clamped up to min
  const tooLow = clampLimits({
    timeout_ms: 100, // min 1000
    memory_mb: 10,   // min 32
    output_bytes: 50,// min 1024
    cpu_nano_cores: 1000, // min 100_000_000
    pids_limit: 2,   // min 16
  });
  assert.equal(tooLow.timeout_ms, 1000);
  assert.equal(tooLow.memory_mb, 32);
  assert.equal(tooLow.output_bytes, 1024);
  assert.equal(tooLow.cpu_nano_cores, 100_000_000);
  assert.equal(tooLow.pids_limit, 16);

  // Values above ceiling are clamped down to max
  const tooHigh = clampLimits({
    timeout_ms: 999999,      // max 30000
    memory_mb: 8192,         // max 1024
    output_bytes: 50_000_000,// max 1048576
    cpu_nano_cores: 8_000_000_000, // max 2_000_000_000
    pids_limit: 1000,        // max 256
  });
  assert.equal(tooHigh.timeout_ms, 30000);
  assert.equal(tooHigh.memory_mb, 1024);
  assert.equal(tooHigh.output_bytes, 1048576);
  assert.equal(tooHigh.cpu_nano_cores, 2_000_000_000);
  assert.equal(tooHigh.pids_limit, 256);

  // Supports camelCase inputs
  const camelCase = clampLimits({
    timeoutMs: 5000,
    memoryMb: 512,
    outputBytes: 2048,
    cpuNanoCores: 800_000_000,
    pidsLimit: 128,
  });
  assert.equal(camelCase.timeout_ms, 5000);
  assert.equal(camelCase.memory_mb, 512);
  assert.equal(camelCase.output_bytes, 2048);
  assert.equal(camelCase.cpu_nano_cores, 800_000_000);
  assert.equal(camelCase.pids_limit, 128);
});

test("validateJobSubmission rejects disallowed languages", () => {
  const result = validateJobSubmission({
    language: "fortran",
    source_code: "PROGRAM HELLO",
  });
  assert.equal(result.success, false);
  if (!result.success) {
    assert.equal(result.statusCode, 400);
    assert.match(result.error, /Unsupported language: 'fortran'/);
  }
});

test("validateJobSubmission enforces source code non-empty and size caps", () => {
  // Missing or empty source code
  const emptyResult = validateJobSubmission({
    language: "python",
    source_code: "",
  });
  assert.equal(emptyResult.success, false);
  if (!emptyResult.success) {
    assert.equal(emptyResult.statusCode, 400);
  }

  // Oversized source code (> 256 KB)
  const hugeCode = "a".repeat(262145);
  const oversizedResult = validateJobSubmission({
    language: "python",
    source_code: hugeCode,
  });
  assert.equal(oversizedResult.success, false);
  if (!oversizedResult.success) {
    assert.equal(oversizedResult.statusCode, 413);
    assert.match(oversizedResult.error, /exceeds maximum allowed limit/);
  }
});

test("validateJobSubmission succeeds with valid input and clamped limits", () => {
  const result = validateJobSubmission({
    language: "python",
    source_code: "print('hello')",
    stdin: "input string",
    args: ["--verbose"],
    limits: {
      timeout_ms: 15000,
      memory_mb: 512,
    },
  });

  assert.equal(result.success, true);
  if (result.success) {
    assert.ok(result.job.id);
    assert.equal(result.job.language, "python");
    assert.equal(result.job.source_code, "print('hello')");
    assert.equal(result.job.stdin, "input string");
    assert.deepEqual(result.job.args, ["--verbose"]);
    assert.equal(result.job.limits.timeout_ms, 15000);
    assert.equal(result.job.limits.memory_mb, 512);
    assert.equal(result.job.limits.output_bytes, 1048576);
  }
});
