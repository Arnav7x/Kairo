import test from "node:test";
import assert from "node:assert/strict";
import { formatBytes, formatMs } from "./stream.js";
import { monacoFor, labelFor, STARTERS } from "./templates.js";

test("formatBytes formats correctly across orders of magnitude", () => {
  assert.equal(formatBytes(0), "—");
  assert.equal(formatBytes(null), "—");
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(1024), "1.0 KB");
  assert.equal(formatBytes(1536), "1.5 KB");
  assert.equal(formatBytes(1048576), "1.0 MB");
  assert.equal(formatBytes(20971520), "20.0 MB");
});

test("formatMs formats milliseconds and seconds", () => {
  assert.equal(formatMs(null), "—");
  assert.equal(formatMs(0), "0 ms");
  assert.equal(formatMs(450), "450 ms");
  assert.equal(formatMs(1000), "1.00 s");
  assert.equal(formatMs(2500), "2.50 s");
});

test("templates cover all supported runners", () => {
  const languages = ["python", "cpp", "c", "go", "node", "rust", "java", "bash"];
  for (const lang of languages) {
    assert.ok(STARTERS[lang], `missing starter template for ${lang}`);
    assert.ok(STARTERS[lang].source.length > 0, `template for ${lang} is empty`);
    assert.ok(labelFor(lang), `label for ${lang} is missing`);
    assert.ok(monacoFor(lang), `monaco mapping for ${lang} is missing`);
  }
});
