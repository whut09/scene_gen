import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import path from "node:path";
import type { ProjectAsset } from "./types";
import { ensureDir, fromRoot } from "./utils";

const execFileAsync = promisify(execFile);
const watermarkPattern = /水印|版权|版权所有|来源|copyright|watermark|logo|二维码|qr.?code|data-?vmark|vmark/i;
const ignoredImagePattern = /avatar|author|favicon|emoji|badge|shield|icon|logo|qr.?code|二维码|share|赞|评论|收藏/i;

export interface ArticleImageCandidate {
  alt: string;
  url: string;
  watermarkHint?: string;
}

function imageUrlFromElement(element: Element) {
  const values = [
    element.getAttribute("data-src"),
    element.getAttribute("data-original"),
    element.getAttribute("data-lazy-src"),
    element.getAttribute("data-url"),
    element.getAttribute("src"),
  ].filter((value): value is string => Boolean(value?.trim()));
  const srcset = element.getAttribute("srcset") ?? element.getAttribute("data-srcset");
  if (srcset) {
    const last = srcset.split(",").map((value) => value.trim().split(/\s+/u)[0]).filter(Boolean).at(-1);
    if (last) values.unshift(last);
  }
  return values[0] ?? "";
}

export function extractArticleImageCandidates(document: Document, pageUrl: string): ArticleImageCandidate[] {
  const roots = [...document.querySelectorAll("article img, main img, [role='main'] img, .article-content img, .content img")];
  const candidates = roots.map((element): ArticleImageCandidate | null => {
    const rawUrl = imageUrlFromElement(element);
    const alt = [element.getAttribute("alt"), element.getAttribute("title"), element.getAttribute("class")]
      .filter(Boolean).join(" ").trim();
    try {
      return {
        alt,
        url: new URL(rawUrl, pageUrl).toString(),
        watermarkHint: [element.getAttribute("data-watermark"), element.getAttribute("data-vmark")]
          .filter(Boolean).join(" "),
      };
    } catch {
      return null;
    }
  }).filter((candidate): candidate is ArticleImageCandidate => candidate !== null && Boolean(candidate.url));
  const unique = new Map<string, ArticleImageCandidate>();
  for (const candidate of candidates) {
    if (ignoredImagePattern.test(candidate.alt) || unique.has(candidate.url)) continue;
    unique.set(candidate.url, candidate);
  }
  return [...unique.values()];
}

function imageContentType(bytes: Buffer, fallback: string, url: string) {
  if (fallback.startsWith("image/")) return fallback.split(";")[0];
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]))) return "image/jpeg";
  if (bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP") return "image/webp";
  if (bytes.subarray(0, 6).toString().startsWith("GIF")) return "image/gif";
  return /\.svg(?:$|[?#])/i.test(url) ? "image/svg+xml" : fallback;
}

function extension(contentType: string, url: string) {
  if (/png/i.test(contentType)) return ".png";
  if (/webp/i.test(contentType)) return ".webp";
  if (/gif/i.test(contentType)) return ".gif";
  if (/svg/i.test(contentType)) return ".svg";
  if (/jpe?g/i.test(contentType)) return ".jpg";
  return path.extname(new URL(url).pathname).slice(0, 6) || ".img";
}

function parseDimensions(bytes: Buffer, contentType: string) {
  if (contentType === "image/png" && bytes.length >= 24) return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  if (contentType === "image/gif" && bytes.length >= 10) return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
  if (contentType === "image/webp" && bytes.length >= 30 && bytes.subarray(12, 16).toString() === "VP8X") return { width: 1 + bytes.readUIntLE(24, 3), height: 1 + bytes.readUIntLE(27, 3) };
  if (contentType === "image/jpeg") {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) { offset += 1; continue; }
      const marker = bytes[offset + 1];
      const length = bytes.readUInt16BE(offset + 2);
      if (marker >= 0xc0 && marker <= 0xc3 && offset + 8 < bytes.length) return { width: bytes.readUInt16BE(offset + 7), height: bytes.readUInt16BE(offset + 5) };
      offset += Math.max(2, length + 2);
    }
  }
  return { width: 0, height: 0 };
}

async function fetchImageBytes(url: string) {
  try {
    const response = await fetch(url, { headers: { "user-agent": "scene-gen/0.1 article asset collector" } });
    if (response.ok) return { bytes: Buffer.from(await response.arrayBuffer()), contentType: response.headers.get("content-type") ?? "" };
  } catch {
    // Some Windows environments reject CDN certificates in Node; curl may still work.
  }
  const curl = process.platform === "win32" ? "curl.exe" : "curl";
  const args = ["--location", "--fail", "--silent", "--show-error", "--max-time", "45", "--user-agent", "Mozilla/5.0"];
  if (process.platform === "win32") args.push("--ssl-no-revoke");
  args.push(url);
  const result = await execFileAsync(curl, args, { timeout: 50_000, windowsHide: true, maxBuffer: 14_000_000, encoding: "buffer" }) as { stdout: Buffer | string };
  return { bytes: Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout), contentType: "" };
}

async function optionalOcr(filePath: string) {
  const command = process.env.TESSERACT_CMD || "tesseract";
  try {
    const result = await execFileAsync(command, [filePath, "stdout", "-l", process.env.TESSERACT_LANG || "eng+chi_sim", "--psm", "11"], {
      timeout: 12_000,
      windowsHide: true,
      maxBuffer: 100_000,
    });
    return result.stdout;
  } catch {
    return "";
  }
}

export function hasWatermarkSignal(value: string) {
  return watermarkPattern.test(value);
}

function candidateSignals(candidate: ArticleImageCandidate) {
  const url = new URL(candidate.url);
  return `${candidate.alt} ${candidate.watermarkHint ?? ""} ${url.pathname} ${url.search}`;
}

export async function collectArticleImages(input: {
  document: Document;
  pageUrl: string;
  articleId: string;
  limit?: number;
}): Promise<ProjectAsset[]> {
  const candidates = extractArticleImageCandidates(input.document, input.pageUrl);
  const limit = Math.max(0, input.limit ?? 3);
  if (limit === 0 || candidates.length === 0) return [];
  const assetDir = fromRoot("public", "generated", "article-assets", input.articleId);
  await ensureDir(assetDir);
  const assets: ProjectAsset[] = [];
  for (const candidate of candidates) {
    if (assets.length >= limit) break;
    if (hasWatermarkSignal(candidateSignals(candidate))) continue;
    try {
      const { bytes, contentType: responseContentType } = await fetchImageBytes(candidate.url);
      if (bytes.length < 8 || bytes.length > 12_000_000) continue;
      const contentType = imageContentType(bytes, responseContentType, candidate.url);
      if (!contentType.startsWith("image/")) continue;
      const dimensions = parseDimensions(bytes, contentType);
      if ((dimensions.width && dimensions.width < 320) || (dimensions.height && dimensions.height < 180)) continue;
      const id = createHash("sha1").update(candidate.url).digest("hex").slice(0, 12);
      const fileName = id + extension(contentType, candidate.url);
      const filePath = path.join(assetDir, fileName);
      await writeFile(filePath, bytes);
      const ocrText = await optionalOcr(filePath);
      if (hasWatermarkSignal(ocrText)) continue;
      assets.push({
        id,
        kind: "image",
        role: assets.length === 0 ? "hero" : "evidence",
        title: candidate.alt || "报道配图",
        sourceUrl: candidate.url,
        src: `/generated/article-assets/${input.articleId}/${fileName}`,
        contentType,
        license: "article-provided; watermark screen passed",
      });
    } catch {
      continue;
    }
  }
  return assets;
}
