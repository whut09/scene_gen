import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { access, copyFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import path from "node:path";
import type { HotItem, ProjectAsset } from "../pipeline/types";
import { ensureDir, fromRoot } from "../pipeline/utils";

const execFileAsync = promisify(execFile);

async function fetchBytes(url: string) {
  try {
    const response = await fetch(url, { headers: { "user-agent": "scene-gen/0.1 asset collector" } });
    if (response.ok) {
      return { bytes: Buffer.from(await response.arrayBuffer()), contentType: response.headers.get("content-type") ?? "" };
    }
  } catch {
    // Windows installations can have a working curl/proxy path when Node fetch cannot resolve GitHub.
  }
  const curl = process.platform === "win32" ? "curl.exe" : "curl";
  const result = await execFileAsync(curl, ["-L", "--fail", "--silent", "--show-error", "--max-time", "45", "-A", "scene-gen/0.1 asset collector", url], {
    encoding: "buffer",
    maxBuffer: 12_000_000,
    windowsHide: true,
  }) as unknown as { stdout: Buffer };
  return { bytes: Buffer.from(result.stdout), contentType: "" };
}

function imageContentType(bytes: Buffer, fallback: string, url: string) {
  if (fallback.startsWith("image/")) return fallback;
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]))) return "image/jpeg";
  if (bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP") return "image/webp";
  if (bytes.subarray(0, 6).toString().startsWith("GIF")) return "image/gif";
  return /\.svg(?:$|[?#])/i.test(url) ? "image/svg+xml" : fallback;
}

function repoParts(item: HotItem) {
  const repo = item.repo ?? "";
  const [owner, name] = repo.split("/");
  return owner && name ? { owner, name } : null;
}

function markdownImages(markdown: string) {
  const markdownAssets = [...markdown.matchAll(/!\[([^\]]*)\]\((?:<([^>]+)>|([^\s)]+))(?:\s+["'][^"']*["'])?\)/g)]
    .map((match) => ({ alt: match[1].trim(), url: (match[2] ?? match[3] ?? "").trim() }));
  const htmlAssets = [...markdown.matchAll(/<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi)]
    .map((match) => ({
      alt: (match[0].match(/\balt=["']([^"']*)["']/i)?.[1] ?? "").trim(),
      url: match[1].trim(),
    }));
  const candidates = [...markdownAssets, ...htmlAssets]
    .filter((asset) => asset.url)
    .filter((asset) => !/badge|shield|build|coverage|license|stars?|forks?|social-preview|repobeats|analytics|deploy(?:\s+with)?|hosting|button|(?:^|[\/_-])(?:logo|icon)(?:[._/-]|$)/i.test(asset.alt + " " + asset.url));
  const score = (asset: { alt: string; url: string }) => {
    const value = `${asset.alt} ${asset.url}`;
    return /screenshot|screen shot|demo|preview|dashboard|interface|ui|workflow|效果|页面|界面|演示/i.test(value) ? 2 : 0;
  };
  return [...new Map(candidates.map((asset) => [asset.url, asset])).values()]
    .sort((left, right) => score(right) - score(left));
}

function resolveAssetUrl(raw: string, owner: string, repo: string, branch: string) {
  if (/^https?:\/\/raw\.githubusercontent\.com\//i.test(raw)) return raw;
  if (/^https?:\/\/github\.com\/[^/]+\/[^/]+\/blob\//i.test(raw)) {
    return raw.replace(/^https?:\/\/github\.com\//i, "https://raw.githubusercontent.com/").replace("/blob/", "/");
  }
  if (/^https?:\/\//i.test(raw)) return raw;
  const clean = raw.replace(/^\.\//, "").replace(/^\//, "").replace(/^\.?\//, "");
  return "https://raw.githubusercontent.com/" + owner + "/" + repo + "/" + branch + "/" + clean;
}

function extension(contentType: string, url: string) {
  if (/png/i.test(contentType)) return ".png";
  if (/webp/i.test(contentType)) return ".webp";
  if (/gif/i.test(contentType)) return ".gif";
  if (/svg/i.test(contentType)) return ".svg";
  if (/jpe?g/i.test(contentType)) return ".jpg";
  return path.extname(new URL(url).pathname).slice(0, 6) || ".img";
}

async function collectLocalGithubAssets(target: { owner: string; name: string }, assetDir: string, limit: number) {
  const localDir = fromRoot("config", "assets", "github", target.owner + "-" + target.name);
  const entries = ["dashboard.png", "dashboard.jpg", "dashboard.webp", "ui.png", "ui.jpg", "ui.webp"];
  const assets: ProjectAsset[] = [];
  for (const entry of entries) {
    if (assets.length >= limit) break;
    const sourcePath = path.join(localDir, entry);
    try {
      await access(sourcePath);
      const destination = path.join(assetDir, entry);
      await copyFile(sourcePath, destination);
      const contentType = imageContentType(Buffer.alloc(0), "image/" + path.extname(sourcePath).slice(1), sourcePath);
      if (!contentType.startsWith("image/")) continue;
      assets.push({
        id: createHash("sha1").update(`${target.owner}/${target.name}/${entry}`).digest("hex").slice(0, 12),
        kind: "image",
        role: assets.length === 0 ? "hero" : "evidence",
        title: target.name.toLowerCase() === "zabbix" ? "Zabbix Global view 监控仪表盘" : `${target.name} 项目界面`,
        sourceUrl: `local://config/assets/github/${target.owner}-${target.name}/${entry}`,
        src: "/generated/assets/" + target.owner + "-" + target.name + "/" + entry,
        contentType,
        license: "user-provided asset",
      });
    } catch {
      continue;
    }
  }
  return assets;
}

export async function collectGithubAssets(item: HotItem, limit = 3): Promise<ProjectAsset[]> {
  const target = repoParts(item);
  if (!target || item.kind !== "github" || limit <= 0) return [];
  const branch = String(item.metrics?.branch ?? "main");
  const readmeUrl = "https://raw.githubusercontent.com/" + target.owner + "/" + target.name + "/" + branch + "/README.md";
  let markdown = item.content ?? "";
  try {
    const readmeResponse = await fetchBytes(readmeUrl);
    if (readmeResponse.bytes.length > 0) markdown = readmeResponse.bytes.toString("utf8");
  } catch (error) {
    console.warn("[assets] README unavailable; continuing without remote assets: " + (error as Error).message);
  }
  const candidates = markdown ? markdownImages(markdown) : [];
  const assets: ProjectAsset[] = [];
  const assetDir = fromRoot("public", "generated", "assets", target.owner + "-" + target.name);
  await ensureDir(assetDir);
  assets.push(...await collectLocalGithubAssets(target, assetDir, limit));
  for (const candidate of candidates) {
    if (assets.length >= limit) break;
    try {
      const sourceUrl = resolveAssetUrl(candidate.url, target.owner, target.name, branch);
      const response = await fetchBytes(sourceUrl);
      const bytes = response.bytes;
      const contentType = imageContentType(bytes, response.contentType, sourceUrl);
      if (!contentType.startsWith("image/")) continue;
      if (bytes.length < 4_000 || bytes.length > 8_000_000) continue;
      const id = createHash("sha1").update(sourceUrl).digest("hex").slice(0, 12);
      const ext = extension(contentType, sourceUrl);
      const fileName = id + ext;
      await writeFile(path.join(assetDir, fileName), bytes);
      assets.push({
        id,
        kind: "image",
        role: assets.length === 0 ? "hero" : "evidence",
        title: candidate.alt || target.name,
        sourceUrl,
        src: "/generated/assets/" + target.owner + "-" + target.name + "/" + fileName,
        contentType,
        license: "repository-provided; verify upstream project license",
      });
    } catch (error) {
      console.warn("[assets] skipped " + candidate.url + ": " + (error as Error).message);
    }
  }
  return assets;
}
