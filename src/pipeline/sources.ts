import { XMLParser } from "fast-xml-parser";
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import type { HotItem, SourceConfig } from "./types";
import { compactText, daysAgo, domainFromUrl, stableId } from "./utils";
import { fetchWithRetry } from "./external-operation";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
});

const seedItems: HotItem[] = [
  {
    id: "seed_agent_workflow",
    kind: "seed",
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

function normalizePublishedAt(value: unknown) {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const date = new Date(value.trim());
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
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
      const html = await fetchText(url);
      const dom = new JSDOM(html, { url });
      const article = new Readability(dom.window.document).parse();
      const title = compactText(article?.title ?? dom.window.document.title ?? url, 140);
      const content = compactText(article?.textContent ?? title, 4200);
      const summary = compactText(article?.excerpt ?? content ?? title, 360);
      const joined = `${title} ${summary}`;
      items.push({
        id: stableId("webpage", url, title),
        kind: "webpage",
        title,
        url,
        source: domainFromUrl(url),
        summary,
        content,
        publishedAt: new Date().toISOString(),
        score: scoreItem(joined, new Date().toISOString(), 1, config.keywords),
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
