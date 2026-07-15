import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { extractWebpagePublishedAt } from "./sources";

test("extractWebpagePublishedAt prefers article publication metadata", () => {
  const dom = new JSDOM(`
    <meta property="article:published_time" content="2026-07-15T20:59:06+08:00">
    <script type="application/ld+json">{"datePublished":"2026-07-14T10:00:00+08:00"}</script>
  `);
  assert.equal(extractWebpagePublishedAt(dom.window.document), "2026-07-15T12:59:06.000Z");
});

test("extractWebpagePublishedAt falls back to JSON-LD", () => {
  const dom = new JSDOM(`
    <script type="application/ld+json">
      {"@graph":[{"@type":"NewsArticle","datePublished":"2026-07-15T18:38:00+08:00"}]}
    </script>
  `);
  assert.equal(extractWebpagePublishedAt(dom.window.document), "2026-07-15T10:38:00.000Z");
});
