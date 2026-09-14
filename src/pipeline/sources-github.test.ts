import assert from "node:assert/strict";
import test from "node:test";
import { collectWebpage, githubStarsFromHtml } from "./sources";

test("GitHub star fallback parses the current repository counter markup", () => {
  assert.equal(githubStarsFromHtml('<span id="repo-stars-counter-star" aria-label="1987 users starred this repository" title="1,987" class="Counter">2k</span>'), 1987);
  assert.equal(githubStarsFromHtml('<a href="/owner/repo/stargazers"><span class="Counter">321</span></a>'), 321);
});

test("GitHub collection falls back to the raw README after API network failures", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (input) => {
    calls += 1;
    const url = String(input);
    if (url.includes("api.github.com")) throw new TypeError("fetch failed");
    assert.match(url, /raw[.]githubusercontent[.]com\/example\/project\/HEAD\/README[.]md/u);
    return new Response("[![build](https://img.shields.io/build.svg)](https://example.com)\n# Project - AI Course\nA practical AI learning course with lessons, exercises, quizzes, and guided labs for beginners.", { status: 200 });
  };
  try {
    const items = await collectWebpage(["https://github.com/example/project"], { rss: [], github: [], hackerNews: { queries: [], weight: 1 }, keywords: ["AI"] });
    assert.equal(items.length, 1);
    assert.equal(items[0].kind, "github");
    assert.equal(items[0].repo, "example/project");
    assert.match(items[0].content ?? "", /learning course/u);
    assert.match(items[0].summary, /^AI Course/u);
    assert.doesNotMatch(items[0].summary, /shields|badge/u);
    assert.equal(calls, 4);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
