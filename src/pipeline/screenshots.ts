import { existsSync } from "node:fs";
import { chromium, type Browser } from "playwright";
import type { HotItem, WebScreenshot } from "./types";
import { ensureDir, fromRoot, stableId } from "./utils";

const captureWidth = 1280;
const captureHeight = 1600;
const browserCandidates = [
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
].filter(Boolean) as string[];

function localBrowserExecutable() {
  return browserCandidates.find((candidate) => existsSync(candidate));
}

function isCaptureCandidate(item: HotItem) {
  if (item.kind === "seed") return false;
  try {
    const url = new URL(item.url);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

function captureUrl(item: HotItem) {
  const objectID = item.metrics?.objectID;
  if (item.kind === "hackernews" && typeof objectID === "string") {
    return `https://news.ycombinator.com/item?id=${objectID}`;
  }
  return item.url;
}

function publicPath(fileName: string) {
  return `/generated/screenshots/${fileName}`;
}

async function findHighlight(page: import("playwright").Page) {
  return page.evaluate(() => {
    const selectors = [
      ".titleline",
      "tr.athing",
      ".subtext",
      "main h1",
      "article h1",
      "h1",
      "[role='main']",
      "main",
      "article",
      ".markdown-body",
      ".Box",
    ];
    const minWidth = 120;
    const minHeight = 16;
    for (const selector of selectors) {
      const element = document.querySelector(selector);
      if (!element) continue;
      const rect = element.getBoundingClientRect();
      if (rect.width < minWidth || rect.height < minHeight) continue;
      const x = Math.max(0, rect.x);
      const y = Math.max(0, rect.y);
      return {
        x,
        y,
        width: Math.min(window.innerWidth - x, rect.width),
        height: Math.min(window.innerHeight - y, Math.max(64, rect.height)),
      };
    }
    return {
      x: 96,
      y: 160,
      width: Math.max(420, window.innerWidth - 192),
      height: 220,
    };
  });
}

async function captureOne(browser: Browser, item: HotItem, index: number): Promise<WebScreenshot | null> {
  const page = await browser.newPage({
    viewport: { width: captureWidth, height: captureHeight },
    deviceScaleFactor: 1,
    colorScheme: "dark",
  });
  page.setDefaultTimeout(12000);
  page.setDefaultNavigationTimeout(18000);

  try {
    const url = captureUrl(item);
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle", { timeout: 6000 }).catch(() => undefined);
    await page.evaluate(() => window.scrollTo(0, 0)).catch(() => undefined);
    await page.locator("body").waitFor({ state: "visible", timeout: 4000 }).catch(() => undefined);
    const bodyText = await page.locator("body").innerText({ timeout: 3000 }).catch(() => "");
    if (bodyText.length < 80 || /application error|client-side exception|enable javascript/i.test(bodyText)) {
      throw new Error("page looked blank or errored");
    }

    const highlight = await findHighlight(page);
    const id = stableId("shot", item.id, item.url);
    const fileName = `${String(index + 1).padStart(2, "0")}-${id}.png`;
    const outputPath = fromRoot("public", "generated", "screenshots", fileName);
    await page.screenshot({
      path: outputPath,
      fullPage: false,
      type: "png",
      animations: "disabled",
    });

    return {
      id,
      title: item.title,
      source: item.source,
      url,
      src: publicPath(fileName),
      width: captureWidth,
      height: captureHeight,
      highlight,
    };
  } catch (error) {
    console.warn(`[screenshot] ${item.url} failed: ${(error as Error).message}`);
    return null;
  } finally {
    await page.close().catch(() => undefined);
  }
}

export async function captureWebScreenshots(items: HotItem[], limit = 3) {
  const targets = items.filter(isCaptureCandidate).slice(0, Math.max(limit * 4, limit));
  if (targets.length === 0) return [];

  await ensureDir(fromRoot("public", "generated", "screenshots"));
  let browser: Browser | null = null;
  try {
    const executablePath = localBrowserExecutable();
    browser = await chromium.launch({
      headless: true,
      executablePath,
    });
    const shots: WebScreenshot[] = [];
    for (const [index, item] of targets.entries()) {
      const shot = await captureOne(browser, item, index);
      if (shot) shots.push(shot);
      if (shots.length >= limit) break;
    }
    return shots;
  } catch (error) {
    console.warn(`[screenshot] browser failed: ${(error as Error).message}`);
    return [];
  } finally {
    await browser?.close().catch(() => undefined);
  }
}
