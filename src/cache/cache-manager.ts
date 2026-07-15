import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { mediaCacheMetadataSchema, mediaCachePaths, mediaCacheRoot, readRunCacheReferences, type CacheKind, type MediaCacheMetadata } from "./media-cache";
import { fromRoot, readJson } from "../pipeline/utils";

interface CacheEntry {
  metadata: MediaCacheMetadata;
  metadataPath: string;
  mediaPath: string;
}

async function walkFiles(directory: string): Promise<string[]> {
  const output: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) output.push(...await walkFiles(entryPath));
    else if (entry.isFile()) output.push(entryPath);
  }
  return output;
}

async function readEntries() {
  const metadataRoot = path.join(mediaCacheRoot(), "metadata");
  const files = (await walkFiles(metadataRoot)).filter((filePath) => filePath.endsWith(".json"));
  const entries: CacheEntry[] = [];
  const invalid: string[] = [];
  for (const metadataPath of files) {
    try {
      const metadata = mediaCacheMetadataSchema.parse(await readJson<unknown>(metadataPath));
      const mediaPath = mediaCachePaths(metadata.kind, metadata.cacheKey, metadata.extension).mediaPath;
      const info = await stat(mediaPath);
      if (!info.isFile() || info.size !== metadata.sizeBytes) throw new Error("media size mismatch");
      entries.push({ metadata, metadataPath, mediaPath });
    } catch {
      invalid.push(metadataPath);
    }
  }
  return { entries, invalid };
}

async function activeReferences() {
  const runsRoot = fromRoot("dist", "runs");
  const runDirectories = await readdir(runsRoot, { withFileTypes: true }).catch(() => []);
  const references = new Set<string>();
  const activeRuns: string[] = [];
  for (const entry of runDirectories) {
    if (!entry.isDirectory()) continue;
    const runDir = path.join(runsRoot, entry.name);
    const journal = await readJson<{ status?: string }>(path.join(runDir, "run.json")).catch(() => undefined);
    if (journal?.status !== "running") continue;
    activeRuns.push(entry.name);
    for (const reference of await readRunCacheReferences(runDir)) references.add(`${reference.kind}:${reference.cacheKey}`);
  }
  return { references, activeRuns };
}

function summarize(entries: CacheEntry[]) {
  const byKind = Object.fromEntries((["audio", "video-scene"] as CacheKind[]).map((kind) => {
    const items = entries.filter((entry) => entry.metadata.kind === kind);
    return [kind, { count: items.length, sizeBytes: items.reduce((sum, entry) => sum + entry.metadata.sizeBytes, 0) }];
  }));
  const dates = entries.flatMap((entry) => [entry.metadata.createdAt]);
  return {
    root: mediaCacheRoot(),
    count: entries.length,
    sizeBytes: entries.reduce((sum, entry) => sum + entry.metadata.sizeBytes, 0),
    byKind,
    oldestCreatedAt: dates.sort()[0],
    newestCreatedAt: dates.sort().at(-1),
  };
}

export async function inspectMediaCache() {
  const { entries, invalid } = await readEntries();
  const active = await activeReferences();
  return { ...summarize(entries), invalidMetadata: invalid, activeRuns: active.activeRuns, activeReferenceCount: active.references.size };
}

export async function pruneMediaCache(options: {
  maxAgeDays?: number;
  maxSizeBytes?: number;
  dryRun?: boolean;
}) {
  const { entries, invalid } = await readEntries();
  const active = await activeReferences();
  const now = Date.now();
  const maxAgeMs = options.maxAgeDays === undefined ? undefined : options.maxAgeDays * 86_400_000;
  const sorted = [...entries].sort((left, right) => Date.parse(left.metadata.lastAccessedAt) - Date.parse(right.metadata.lastAccessedAt));
  const selected = new Map<string, CacheEntry>();
  for (const entry of sorted) {
    const id = `${entry.metadata.kind}:${entry.metadata.cacheKey}`;
    if (active.references.has(id)) continue;
    if (maxAgeMs !== undefined && now - Date.parse(entry.metadata.lastAccessedAt) > maxAgeMs) selected.set(id, entry);
  }
  let remainingBytes = entries.reduce((sum, entry) => sum + entry.metadata.sizeBytes, 0)
    - [...selected.values()].reduce((sum, entry) => sum + entry.metadata.sizeBytes, 0);
  if (options.maxSizeBytes !== undefined) {
    for (const entry of sorted) {
      if (remainingBytes <= options.maxSizeBytes) break;
      const id = `${entry.metadata.kind}:${entry.metadata.cacheKey}`;
      if (active.references.has(id) || selected.has(id)) continue;
      selected.set(id, entry);
      remainingBytes -= entry.metadata.sizeBytes;
    }
  }
  if (!options.dryRun) {
    for (const entry of selected.values()) {
      await rm(entry.mediaPath, { force: true });
      await rm(entry.metadataPath, { force: true });
    }
  }
  const deleted = [...selected.values()];
  return {
    dryRun: Boolean(options.dryRun),
    deletedCount: deleted.length,
    freedBytes: deleted.reduce((sum, entry) => sum + entry.metadata.sizeBytes, 0),
    protectedActiveCount: entries.filter((entry) => active.references.has(`${entry.metadata.kind}:${entry.metadata.cacheKey}`)).length,
    invalidMetadata: invalid,
    remainingBytes,
  };
}

export async function clearMediaCache() {
  const active = await activeReferences();
  if (active.activeRuns.length) throw new Error(`Cannot clear cache while runs are active: ${active.activeRuns.join(", ")}.`);
  const before = await inspectMediaCache();
  await rm(mediaCacheRoot(), { recursive: true, force: true });
  return { deletedCount: before.count, freedBytes: before.sizeBytes };
}
