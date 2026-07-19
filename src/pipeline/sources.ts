import { XMLParser } from "fast-xml-parser";
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import type { HotItem, SourceConfig } from "./types";
import { compactText, daysAgo, domainFromUrl, stableId } from "./utils";
import { fetchWithRetry } from "./external-operation";
import { classifyWebpageContent } from "./content-type";

export { classifyWebpageContent } from "./content-type";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
});

const seedItems: HotItem[] = [
  {
    id: "seed_agent_workflow",
    kind: "seed",
    contentType: "news",
    title: "Agent 工作流正在从演示走向生产",
    url: "https://example.com/agent-workflow",
    source: "Seed Signal",
    summary: "多步工具调用、浏览器自动化和代码生成正在成为 AI 产品的默认能力，热点非常适合用流程图和 UI 模拟呈现。",
    publishedAt: new Date().toISOString(),
    score: 62,
    tags: ["agent", "tool-call", "workflow"],
    domain: "example.com",
  },
  {
    id: "seed_benchmark",
    kind: "seed",
    contentType: "news",
    title: "模型竞争进入能力细分阶段",
    url: "https://example.com/model-benchmark",
    source: "Seed Signal",
    summary: "代码、推理、长上下文和多模态能力开始拆分成不同榜单，适合用横向柱状图和排名变化动画解释。",
    publishedAt: new Date().toISOString(),
    score: 58,
    tags: ["benchmark", "model", "reasoning"],
    domain: "example.com",
  },
];

async function fetchText(url: string, timeoutMs = 12000) {
  const response = await fetchWithRetry(url, {
    headers: {
      "user-agent": "scene-gen/0.1 video research bot",
      accept: "text/html,application/xml,application/rss+xml,application/json",
    },
  }, { label: "source-fetch", timeoutMs });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return await response.text();
}

async function fetchTextWithBrowser(url: string, timeoutMs = 30000) {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-blink-features=AutomationControlled"],
  });
  try {
    const context = await browser.newContext({
      ignoreHTTPSErrors: true,
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0 Safari/537.36",
    });
    const page = await context.newPage();
    page.setDefaultNavigationTimeout(timeoutMs);
    const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    if (response && !response.ok()) throw new Error(`${response.status()} ${response.statusText()}`);
    await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => undefined);
    const html = await page.content();
    if (html.length < 200) throw new Error("browser returned an empty webpage");
    return html;
  } finally {
    await browser.close().catch(() => undefined);
  }
}

async function fetchWebpageText(url: string) {
  try {
    return await fetchText(url);
  } catch (directError) {
    console.warn(`[webpage] direct fetch failed for ${url}; retrying with Playwright: ${(directError as Error).message}`);
    try {
      return await fetchTextWithBrowser(url);
    } catch (browserError) {
      throw new Error(`direct fetch failed: ${(directError as Error).message}; browser fallback failed: ${(browserError as Error).message}`);
    }
  }
}

function normalizePublishedAt(value: unknown) {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const date = new Date(value.trim());
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function fallbackArticleText(document: Document) {
  const clone = document.cloneNode(true) as Document;
  clone.querySelectorAll("script,style,noscript,svg,nav,footer").forEach((node) => node.remove());
  return clone.querySelector("article,main,[role='main'],.article-content,.content")?.textContent
    ?? clone.body?.textContent
    ?? "";
}

export function createWebpageDom(html: string, url: string) {
  try {
    return new JSDOM(html, { url });
  } catch (error) {
    console.warn(`[webpage] DOM parse failed for ${url}; retrying without page styles: ${(error as Error).message}`);
    const sanitized = html
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
      .replace(/\sstyle=(?:"[^"]*"|'[^']*')/gi, "");
    return new JSDOM(sanitized, { url });
  }
}

export function extractReadableWebpage(document: Document, url: string) {
  let article: ReturnType<Readability["parse"]> = null;
  try {
    article = new Readability(document.cloneNode(true) as Document).parse();
  } catch (error) {
    console.warn(`[webpage] readability failed for ${url}; using DOM fallback: ${(error as Error).message}`);
  }
  const rawTitle = compactText(article?.title ?? document.title ?? url, 140);
  const title = /cloud\.tencent\.com\/developer\/article\//i.test(url)
    ? rawTitle.replace(/[-_|]\s*\u817e\u8baf\u4e91\u5f00\u53d1\u8005\u793e\u533a\s*[-_|]\s*\u817e\u8baf\u4e91\s*$/u, "").trim()
    : rawTitle;
  const content = compactText(article?.textContent ?? fallbackArticleText(document) ?? title, 4200);
  const summary = compactText(article?.excerpt ?? content ?? title, 360);
  return { title, content, summary };
}

function findJsonLdPublishedAt(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const publishedAt = findJsonLdPublishedAt(item);
      if (publishedAt) return publishedAt;
    }
    return undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const direct = normalizePublishedAt(record.datePublished ?? record.dateCreated ?? record.uploadDate);
  if (direct) return direct;
  for (const child of Object.values(record)) {
    const publishedAt = findJsonLdPublishedAt(child);
    if (publishedAt) return publishedAt;
  }
  return undefined;
}

export function extractWebpagePublishedAt(document: Document) {
  const selectors = [
    'meta[property="article:published_time"]',
    'meta[name="article:published_time"]',
    'meta[name="date"]',
    'meta[name="pubdate"]',
    'meta[name="publishdate"]',
    'meta[itemprop="datePublished"]',
    'time[datetime]',
  ];
  for (const selector of selectors) {
    const element = document.querySelector(selector);
    const publishedAt = normalizePublishedAt(
      element?.getAttribute("content") ?? element?.getAttribute("datetime"),
    );
    if (publishedAt) return publishedAt;
  }
  for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const publishedAt = findJsonLdPublishedAt(JSON.parse(script.textContent ?? ""));
      if (publishedAt) return publishedAt;
    } catch {
      // Ignore malformed third-party structured data and continue with other blocks.
    }
  }
  return undefined;
}

function normalizeTags(text: string, keywords: string[]) {
  const lower = text.toLowerCase();
  return keywords.filter((keyword) => lower.includes(keyword.toLowerCase())).slice(0, 5);
}

function scoreItem(text: string, publishedAt: string | undefined, weight: number, keywords: string[]) {
  const lower = text.toLowerCase();
  const keywordScore = keywords.reduce(
    (sum, keyword) => sum + (lower.includes(keyword.toLowerCase()) ? 8 : 0),
    0,
  );
  const recencyScore = Math.max(0, 34 - daysAgo(publishedAt) * 3.2);
  return Math.round((20 + keywordScore + recencyScore) * weight);
}

export async function collectRss(config: SourceConfig): Promise<HotItem[]> {
  const items: HotItem[] = [];
  await Promise.all(
    config.rss.map(async (feed) => {
      try {
        const xml = await fetchText(feed.url);
        const data = parser.parse(xml);
        const rawItems = data?.rss?.channel?.item ?? data?.feed?.entry ?? [];
        const list = Array.isArray(rawItems) ? rawItems : [rawItems];
        for (const raw of list.slice(0, 8)) {
          const title = compactText(raw.title?.["#text"] ?? raw.title ?? "Untitled", 120);
          const url = raw.link?.href ?? raw.link ?? raw.guid ?? feed.url;
          const summary = compactText(raw.description ?? raw.summary ?? raw.content ?? title, 260);
          const publishedAt = raw.pubDate ?? raw.published ?? raw.updated;
          const joined = `${title} ${summary}`;
          items.push({
            id: stableId(feed.name, title, url),
            kind: "rss",
            contentType: "news",
            title,
            url,
            source: feed.name,
            summary,
            publishedAt: publishedAt ? new Date(publishedAt).toISOString() : undefined,
            score: scoreItem(joined, publishedAt, feed.weight, config.keywords),
            tags: normalizeTags(joined, config.keywords),
            domain: domainFromUrl(url),
          });
        }
      } catch (error) {
        console.warn(`[rss] ${feed.name} failed: ${(error as Error).message}`);
      }
    }),
  );
  return items;
}

export async function collectGitHub(config: SourceConfig): Promise<HotItem[]> {
  const items: HotItem[] = [];
  await Promise.all(
    config.github.map(async (target) => {
      try {
        const releaseUrl = `https://api.github.com/repos/${target.repo}/releases?per_page=3`;
        const releaseText = await fetchText(releaseUrl);
        const releases = JSON.parse(releaseText) as Array<{
          name?: string;
          tag_name: string;
          html_url: string;
          body?: string;
          published_at?: string;
        }>;
        for (const release of releases) {
          const title = `${target.repo} ${release.name ?? release.tag_name}`;
          const summary = compactText(release.body ?? "New release published on GitHub.", 260);
          const joined = `${title} ${summary}`;
          items.push({
            id: stableId("github", target.repo, release.tag_name),
            kind: "github",
            contentType: "repository",
            title,
            url: release.html_url,
            source: "GitHub Release",
            summary,
            publishedAt: release.published_at,
            score: scoreItem(joined, release.published_at, target.weight, config.keywords),
            tags: normalizeTags(joined, config.keywords),
            domain: "github.com",
            repo: target.repo,
            metrics: { tag: release.tag_name },
          });
        }
      } catch (error) {
        console.warn(`[github] ${target.repo} failed: ${(error as Error).message}`);
      }
    }),
  );
  return items;
}

export async function collectHackerNews(config: SourceConfig): Promise<HotItem[]> {
  const items: HotItem[] = [];
  const since = Math.floor((Date.now() - 5 * 86_400_000) / 1000);
  await Promise.all(
    config.hackerNews.queries.map(async (query) => {
      try {
        const url = `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(
          query,
        )}&tags=story&numericFilters=created_at_i>${since}`;
        const data = JSON.parse(await fetchText(url)) as {
          hits: Array<{
            objectID: string;
            title?: string;
            url?: string;
            points?: number;
            num_comments?: number;
            created_at?: string;
          }>;
        };
        for (const hit of data.hits.slice(0, 4)) {
          if (!hit.title) continue;
          const score = Math.round(
            (hit.points ?? 0) * 0.35 + (hit.num_comments ?? 0) * 0.55 + 24 * config.hackerNews.weight,
          );
          const title = compactText(hit.title, 130);
          items.push({
            id: stableId("hn", hit.objectID),
            kind: "hackernews",
            contentType: "news",
            title,
            url: hit.url ?? `https://news.ycombinator.com/item?id=${hit.objectID}`,
            source: "Hacker News",
            summary: `社区讨论热度：${hit.points ?? 0} points，${hit.num_comments ?? 0} comments。`,
            publishedAt: hit.created_at,
            score,
            tags: normalizeTags(title, config.keywords),
            domain: domainFromUrl(hit.url ?? "https://news.ycombinator.com"),
            metrics: {
              objectID: hit.objectID,
              points: hit.points ?? 0,
              comments: hit.num_comments ?? 0,
            },
          });
        }
      } catch (error) {
        console.warn(`[hn] ${query} failed: ${(error as Error).message}`);
      }
    }),
  );
  return items;
}

function githubRepoFromUrl(url: string) {
  try {
    const parsed = new URL(url);
    if (parsed.hostname.toLowerCase() !== "github.com") return null;
    const parts = parsed.pathname.split("/").filter(Boolean);
    if (parts.length < 2) return null;
    return { owner: parts[0], repo: parts[1].replace(/\.git$/i, ""), fullName: parts[0] + "/" + parts[1].replace(/\.git$/i, "") };
  } catch {
    return null;
  }
}


function cleanGithubDescription(value: string, repoName: string) {
  const firstLanguage = value.split(/[|｜]/, 1)[0] ?? value;
  const withoutRepo = firstLanguage
    .replace(new RegExp(`^${repoName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*[:：-]?\\s*`, "i"), "")
    .replace(/\s+/g, " ")
    .trim();
  return compactText(withoutRepo || repoName, 96);
}
async function collectGithubRepository(url: string, config: SourceConfig): Promise<HotItem | null> {
  const target = githubRepoFromUrl(url);
  if (!target) return null;
  const headers = { "user-agent": "scene-gen/0.1 video research bot", accept: "application/vnd.github+json" };
  const repoResponse = await fetchWithRetry("https://api.github.com/repos/" + target.fullName, { headers }, { label: "github-repository" });
  if (!repoResponse.ok && [403, 429].includes(repoResponse.status)) {
    const readmeResponse = await fetchWithRetry(`https://raw.githubusercontent.com/${target.fullName}/HEAD/README.md`, { headers: { "user-agent": headers["user-agent"] } }, { label: "github-readme-fallback" });
    if (!readmeResponse.ok) throw new Error("Repository README fallback " + readmeResponse.status + " " + readmeResponse.statusText);
    const readme = await readmeResponse.text();
    const description = cleanGithubDescription(compactText(readme.replace(/[#*`<>!\[\]()]/g, " "), 260), target.repo);
    const joined = [description, readme].join(" ");
    return {
      id: stableId("github", url, target.fullName), kind: "github", contentType: "repository",
      title: `${target.repo}：${description}`, url, source: "项目资料", summary: description,
      content: compactText(readme, 12000), publishedAt: new Date().toISOString(),
      score: scoreItem(joined, undefined, 1, config.keywords), tags: normalizeTags(joined, config.keywords).slice(0, 8),
      repo: target.fullName, metrics: { stars: 0, forks: 0, issues: 0, language: "Unknown", license: "Unknown", branch: "HEAD" },
    };
  }
  if (!repoResponse.ok) throw new Error("GitHub API " + repoResponse.status + " " + repoResponse.statusText);
  const repo = await repoResponse.json() as {
    full_name?: string; name?: string; description?: string; stargazers_count?: number; forks_count?: number;
    open_issues_count?: number; language?: string; license?: { spdx_id?: string }; pushed_at?: string; topics?: string[];
    default_branch?: string;
  };
  const readmeResponse = await fetchWithRetry("https://api.github.com/repos/" + target.fullName + "/readme", {
    headers: { ...headers, accept: "application/vnd.github.raw+json" },
  }, { label: "github-readme" });
  const readme = readmeResponse.ok ? await readmeResponse.text() : "";
  const rawDescription = compactText(repo.description || target.fullName, 260);
  const description = cleanGithubDescription(rawDescription, repo.name || target.repo);
  const content = compactText([
    description,
    "Repository: " + (repo.full_name || target.fullName),
    "Stars: " + (repo.stargazers_count ?? 0),
    "Forks: " + (repo.forks_count ?? 0),
    "Language: " + (repo.language || "Unknown"),
    "License: " + (repo.license?.spdx_id || "Unknown"),
    readme,
  ].join("\n"), 12000);
  const joined = [description, ...(repo.topics ?? []), readme].join(" ");
  return {
    id: stableId("github", url, repo.full_name || target.fullName),
    kind: "github",
    contentType: "repository",
    title: (repo.name || target.repo) + "：" + description,
    url,
    source: "GitHub",
    summary: description,
    content,
    publishedAt: repo.pushed_at || new Date().toISOString(),
    score: scoreItem(joined, repo.pushed_at, 1, config.keywords),
    tags: [...new Set([...(repo.topics ?? []), ...normalizeTags(joined, config.keywords)])].slice(0, 8),
    domain: "github.com",
    repo: repo.full_name || target.fullName,
    metrics: {
      stars: repo.stargazers_count ?? 0,
      forks: repo.forks_count ?? 0,
      issues: repo.open_issues_count ?? 0,
      language: repo.language || "Unknown",
      license: repo.license?.spdx_id || "Unknown",
      branch: repo.default_branch || "main",
    },
  };
}

export async function collectWebpage(urls: string[], config: SourceConfig): Promise<HotItem[]> {
  const items: HotItem[] = [];
  for (const url of urls) {
    try {
      const githubItem = await collectGithubRepository(url, config);
      if (githubItem) {
        items.push(githubItem);
        continue;
      }
      const html = await fetchWebpageText(url);
      const dom = createWebpageDom(html, url);
      const { title, content, summary } = extractReadableWebpage(dom.window.document, url);
      const joined = `${title} ${summary}`;
      const publishedAt = extractWebpagePublishedAt(dom.window.document) ?? new Date().toISOString();
      items.push({
        id: stableId("webpage", url, title),
        kind: "webpage",
        contentType: classifyWebpageContent(url, title, content),
        title,
        url,
        source: domainFromUrl(url),
        summary,
        content,
        publishedAt,
        score: scoreItem(joined, publishedAt, 1, config.keywords),
        tags: normalizeTags(joined, config.keywords),
        domain: domainFromUrl(url),
      });
    } catch (error) {
      console.warn(`[webpage] ${url} failed: ${(error as Error).message}`);
    }
  }
  return items;
}

export async function collectHotItems(config: SourceConfig, webpageUrls: string[]) {
  const [rss, github, hn, webpages] = await Promise.all([
    collectRss(config),
    collectGitHub(config),
    collectHackerNews(config),
    collectWebpage(webpageUrls, config),
  ]);
  const byId = new Map<string, HotItem>();
  for (const item of [...rss, ...github, ...hn, ...webpages, ...seedItems]) {
    byId.set(item.id, item);
  }
  return [...byId.values()].sort((a, b) => b.score - a.score).slice(0, 16);
}
