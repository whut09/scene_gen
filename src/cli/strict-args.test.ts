import assert from "node:assert/strict";
import test from "node:test";
import { parseStrictArgs } from "./strict-args";

const definition = {
  summary: "test",
  options: {
    url: { type: "string" as const, required: true, description: "url" },
    count: { type: "number" as const, description: "count" },
    dry: { type: "boolean" as const, description: "dry" },
  },
  mutuallyExclusive: [["dry", "other"]],
};

test("strict args reject typos and validate values", () => {
  assert.deepEqual(parseStrictArgs(["--url", "https://example.com", "--count=2", "--dry"], definition).options, { url: "https://example.com", count: 2, dry: true });
  assert.throws(() => parseStrictArgs(["--url", "x", "--cout", "2"], definition), /Unknown option '--cout'/);
  assert.throws(() => parseStrictArgs(["--url", "x", "--count", "many"], definition), /must be a number/);
});
