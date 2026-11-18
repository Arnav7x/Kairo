import test from "node:test";
import assert from "node:assert/strict";
import { validateJobSubmission } from "./validation.js";

test("Fuzzing validateJobSubmission with arbitrary, malformed, and adversarial payloads", () => {
  const fuzzInputs: unknown[] = [
    null,
    undefined,
    12345,
    true,
    false,
    "",
    [],
    {},
    { language: null, source_code: null },
    { language: "python", source_code: "" },
    { language: 123, source_code: "print(1)" },
    { language: "python", source_code: "a".repeat(1024 * 1024) }, // oversize
    { language: "python", source_code: "print(1)", limits: "invalid" },
    { language: "python", source_code: "print(1)", limits: { timeout_ms: -99999 } },
    { language: "python", source_code: "print(1)", limits: { timeout_ms: Infinity } },
    { language: "python", source_code: "print(1)", limits: { timeout_ms: NaN } },
    { language: "python", source_code: "print(1)", limits: { memory_mb: 1e9 } },
    { language: "../../etc/passwd", source_code: "print(1)" }, // path traversal
    { language: "python\x00malicious", source_code: "print(1)" }, // null byte
    { language: "python", source_code: "print(1)", args: "not-an-array" },
    { language: "python", source_code: "print(1)", args: [123, null, {}] },
    { language: "python", source_code: "print(1)", stdin: 42 },
  ];

  for (const input of fuzzInputs) {
    // Must never throw an uncaught exception
    assert.doesNotThrow(() => {
      const result = validateJobSubmission(input);
      if (result.success) {
        // If it succeeded, it must satisfy all sanitization and clamping invariants
        assert.ok(typeof result.job.id === "string");
        assert.ok(result.job.source_code.length > 0);
        assert.ok(result.job.limits.timeout_ms >= 1000);
        assert.ok(result.job.limits.memory_mb >= 32);
      } else {
        assert.ok(result.statusCode === 400 || result.statusCode === 413);
        assert.ok(typeof result.error === "string");
      }
    });
  }
});
