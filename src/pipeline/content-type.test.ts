import assert from "node:assert/strict";
import test from "node:test";
import { classifyWebpageContent } from "./content-type";
import { createWebpageDom, extractReadableWebpage } from "./sources";

test("developer article URLs are classified as technical articles", () => {
  assert.equal(classifyWebpageContent("https://cloud.tencent.com/developer/article/2710377"), "technical-article");
  assert.equal(classifyWebpageContent("https://juejin.cn/post/123"), "technical-article");
});

test("ordinary reports remain news", () => {
  assert.equal(classifyWebpageContent("https://example.com/news/launch", "Company launches product", "The company announced a product today."), "news");
});

test("webpage extraction survives malformed inline styles", () => {
  const dom = createWebpageDom('<html><head><title>Technical Example</title><style>.x{border-width:inherit 1px}</style></head><body><article style="border-width:inherit 1px">Useful technical content.</article></body></html>', "https://example.com/article");
  const result = extractReadableWebpage(dom.window.document, "https://example.com/article");
  assert.equal(result.title.includes("Technical Example"), true);
  assert.equal(result.content.includes("Useful technical content"), true);
});

test("Tencent Cloud article extraction removes the site title suffix", () => {
  const dom = createWebpageDom('<html><head><title>Article title-\u817e\u8baf\u4e91\u5f00\u53d1\u8005\u793e\u533a-\u817e\u8baf\u4e91</title></head><body><article>Technical body.</article></body></html>', "https://cloud.tencent.com/developer/article/2710377");
  const result = extractReadableWebpage(dom.window.document, "https://cloud.tencent.com/developer/article/2710377");
  assert.equal(result.title, "Article title");
});
