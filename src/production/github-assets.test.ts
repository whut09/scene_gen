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

test("GitHub asset collection prefers demo images and resolves HTML and blob URLs", async () => {
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    requests.push(url);
    if (url.endsWith("/README.md")) {
      return new Response([
        "<img alt=\"build\" src=\"badge.svg\">",
        "<img alt=\"Deploy with Zenith\" src=\"https://cdn.zenith.hosting/buttons/deploy-with-zenith.svg\">",
        "![Dashboard screenshot](docs/dashboard.png)",
        "<img alt=\"Demo UI\" src=\"https://github.com/example/project/blob/main/docs/demo.png\">",
      ].join("\n"), { status: 200, headers: { "content-type": "text/markdown" } });
    }
    return new Response(new Uint8Array(5000), { status: 200, headers: { "content-type": "image/png" } });
  };
  const item = {
    id: "repo", kind: "github", contentType: "repository", title: "project", url: "https://github.com/example/project",
    source: "项目资料", summary: "summary", content: "# Project", score: 1, tags: [], repo: "example/project",
    metrics: { branch: "main" },
  } satisfies HotItem;
  try {
    const assets = await collectGithubAssets(item, 2);
    assert.equal(assets.length, 2);
    assert.equal(assets[0]?.role, "hero");
    assert.match(assets[0]?.sourceUrl ?? "", /dashboard|demo/);
    assert.ok(requests.some((url) => url.includes("raw.githubusercontent.com/example/project/main/docs/")));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("GitHub asset collection includes the configured Zabbix dashboard evidence", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new TypeError("network unavailable"); };
  const item = {
    id: "zabbix", kind: "github", contentType: "repository", title: "zabbix", url: "https://github.com/zabbix/zabbix",
    source: "项目资料", summary: "监控平台", content: "", score: 1, tags: [], repo: "zabbix/zabbix",
    metrics: { branch: "main" },
  } satisfies HotItem;
  try {
    const assets = await collectGithubAssets(item, 3);
    assert.equal(assets[0]?.title, "Zabbix Global view 监控仪表盘");
    assert.equal(assets[0]?.src, "/generated/assets/zabbix-zabbix/dashboard.png");
    assert.equal(assets[0]?.license, "user-provided asset");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
