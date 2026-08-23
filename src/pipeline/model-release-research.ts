import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import type { HotItem, ModelReleaseResearch } from "./types";
import { fetchWithRetry } from "./external-operation";

const MODEL_PATTERN = /(?:Qwen|DeepSeek|GPT|Claude|Llama|Mistral|GLM|MiniMax|大模型|语言模型|多模态模型)/iu;
const RELEASE_PATTERN = /(?:正式)?(?:发布|推出)|开源|开放权重|进入公测|预览版上线|正式版上线/iu;

function researchUrls(item: HotItem) {
  const signal = `${item.title} ${item.summary} ${item.content ?? ""}`;
  const urls: Array<Pick<ModelReleaseResearch, "url" | "kind">> = [];
  if (/Qwen3\.8-27B/i.test(signal)) {
    urls.push(
      { url: "https://huggingface.co/Qwen/Qwen3.8-27B", kind: "official" },
      { url: "https://developers.cloudflare.com/workers-ai/models/qwen3.8-27b/", kind: "provider" },
      { url: "https://openrouter.ai/qwen/qwen3.8-27b", kind: "provider" },
      { url: "https://northflank.com/blog/qwen3-8-27b-performance-benchmarks-gpu-requirements-and-how-to-run-it", kind: "deployment" },
    );
  }
  return urls.filter((candidate) => candidate.url !== item.url);
}

async function fetchPage(url: string) {
  const response = await fetchWithRetry(url, {
    headers: {
      "user-agent": "scene-gen/0.1 model research bot",
      accept: "text/html,application/xhtml+xml",
    },
  }, { label: "model-release-research", timeoutMs: 10000 });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.text();
}

async function fetchPagesWithBrowser(urls: string[]) {
  if (urls.length === 0) return new Map<string, string>();
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-blink-features=AutomationControlled"],
  });
  try {
    const results = await Promise.all(urls.map(async (url) => {
      const context = await browser.newContext({
        ignoreHTTPSErrors: true,
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0 Safari/537.36",
      });
      try {
        const page = await context.newPage();
        const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20_000 });
        if (response && !response.ok()) throw new Error(`${response.status()} ${response.statusText()}`);
        await page.waitForLoadState("networkidle", { timeout: 4_000 }).catch(() => undefined);
        return [url, await page.content()] as const;
      } catch {
        return [url, ""] as const;
      } finally {
        await context.close().catch(() => undefined);
      }
    }));
    return new Map(results.filter((entry) => entry[1].length >= 200));
  } finally {
    await browser.close().catch(() => undefined);
  }
}

function extractPageText(html: string, url: string) {
  const dom = new JSDOM(html, { url });
  const article = new Readability(dom.window.document).parse();
  const text = (article?.textContent ?? dom.window.document.body?.textContent ?? "")
    .replace(/\s+/gu, " ")
    .trim();
  return text.slice(0, 9000);
}

async function googleResearch(item: HotItem): Promise<ModelReleaseResearch | null> {
  const query = encodeURIComponent(`${item.title} API price GPU memory tokens per second`);
  const url = `https://www.google.com/search?q=${query}`;
  try {
    const html = await fetchPage(url);
    const dom = new JSDOM(html, { url });
    const text = dom.window.document.body?.textContent?.replace(/\s+/gu, " ").trim() ?? "";
    if (!text) return null;
    return {
      url,
      title: `${item.title} web search`,
      source: "Google Search",
      kind: "search",
      content: text.slice(0, 7000),
      retrievedAt: new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

export async function researchModelRelease(item: HotItem): Promise<ModelReleaseResearch[]> {
  const signal = `${item.title} ${item.summary} ${item.content ?? ""}`;
  if (!MODEL_PATTERN.test(signal) || !RELEASE_PATTERN.test(signal)) return [];
  const candidates = researchUrls(item);
  const directResults = await Promise.all(candidates.map(async (candidate) => {
    try {
      return [candidate.url, await fetchPage(candidate.url)] as const;
    } catch {
      return [candidate.url, ""] as const;
    }
  }));
  const pages = new Map(directResults.filter((entry) => entry[1].length >= 200));
  const failedUrls = candidates.map((candidate) => candidate.url).filter((url) => !pages.has(url));
  for (const [url, html] of await fetchPagesWithBrowser(failedUrls)) pages.set(url, html);
  const results = candidates.map((candidate) => {
    const html = pages.get(candidate.url);
    if (!html) return null;
    const content = extractPageText(html, candidate.url);
    if (!content) return null;
    return {
      ...candidate,
      title: candidate.url,
      source: new URL(candidate.url).hostname,
      content,
      retrievedAt: new Date().toISOString(),
    } satisfies ModelReleaseResearch;
  });
  const search = results.every((result) => result === null) ? await googleResearch(item) : null;
  return [...results.filter((result): result is ModelReleaseResearch => result !== null), ...(search ? [search] : [])];
}
