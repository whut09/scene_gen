import assert from "node:assert/strict";
import test from "node:test";
import {
  generatedContentMatches,
  normalizeLineEndings,
} from "../../scripts/generate-f5-worker-protocol.mjs";

test("protocol freshness checks ignore checkout line endings", () => {
  const generated = "first\nsecond\n";
  const windowsCheckout = "first\r\nsecond\r\n";

  assert.equal(normalizeLineEndings(windowsCheckout), generated);
  assert.equal(generatedContentMatches(windowsCheckout, generated), true);
});

test("protocol freshness checks still reject content changes", () => {
  assert.equal(generatedContentMatches("first\r\nchanged\r\n", "first\nsecond\n"), false);
});
