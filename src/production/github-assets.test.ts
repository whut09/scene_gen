import assert from "node:assert/strict";
import test from "node:test";
import type { HotItem } from "../pipeline/types";
import { collectGithubAssets } from "./github-assets";

test("GitHub asset collection tolerates an unavailable remote README", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new TypeError("fetch failed"); };
  const item = {
    id: "repo", kind: "github", contentType: "repository", title: "project", url: "https://github.com/example/project",
    source: "项目资料", summary: "summary", content: "# Project\nNo remote images are required.", score: 1, tags: [], repo: "example/project",
    metrics: { branch: "main" },
  } satisfies HotItem;
  try {
    assert.deepEqual(await collectGithubAssets(item, 3), []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
