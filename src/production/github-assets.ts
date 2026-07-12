import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { HotItem, ProjectAsset } from "../pipeline/types";
import { ensureDir, fromRoot } from "../pipeline/utils";

function repoParts(item: HotItem) {
  const repo = item.repo ?? "";
  const [owner, name] = repo.split("/");
  return owner && name ? { owner, name } : null;
}

function markdownImages(markdown: string) {
  return [...markdown.matchAll(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g)]
    .map((match) => ({ alt: match[1].trim(), url: match[2].trim().replace(/^<|>$/g, "") }))
    .filter((asset) => !/badge|shield|build|coverage|license|stars?|forks?/i.test(asset.alt + " " + asset.url));
}

function resolveAssetUrl(raw: string, owner: string, repo: string, branch: string) {
  if (/^https?:\/\//i.test(raw)) return raw;
  const clean = raw.replace(/^\.\//, "").replace(/^\//, "");
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

export async function collectGithubAssets(item: HotItem, limit = 3): Promise<ProjectAsset[]> {
  const target = repoParts(item);
  if (!target || item.kind !== "github" || limit <= 0) return [];
  const branch = String(item.metrics?.branch ?? "main");
  const readmeUrl = "https://raw.githubusercontent.com/" + target.owner + "/" + target.name + "/" + branch + "/README.md";
  const readmeResponse = await fetch(readmeUrl, { headers: { "user-agent": "scene-gen/0.1 asset collector" } });
  if (!readmeResponse.ok) return [];
  const markdown = await readmeResponse.text();
  const candidates = markdownImages(markdown);
  const assets: ProjectAsset[] = [];
  const assetDir = fromRoot("public", "generated", "assets", target.owner + "-" + target.name);
  await ensureDir(assetDir);
  for (const candidate of candidates) {
    if (assets.length >= limit) break;
    try {
      const sourceUrl = resolveAssetUrl(candidate.url, target.owner, target.name, branch);
      const response = await fetch(sourceUrl, { redirect: "follow", headers: { "user-agent": "scene-gen/0.1 asset collector" } });
      if (!response.ok) continue;
      const contentType = response.headers.get("content-type") ?? "";
      if (!contentType.startsWith("image/")) continue;
      const bytes = Buffer.from(await response.arrayBuffer());
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
