import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, copyFile, link, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { ensureDir, fromRoot, readJson, writeJsonAtomic } from "../pipeline/utils";

export const cacheKindSchema = z.enum(["audio", "video-scene"]);
export type CacheKind = z.infer<typeof cacheKindSchema>;

export const mediaCacheMetadataSchema = z.object({
  version: z.literal(1),
  kind: cacheKindSchema,
  cacheKey: z.string().length(64),
  extension: z.string().regex(/^\.[a-z0-9]+$/i),
  contentHash: z.string().length(64),
  sizeBytes: z.number().int().positive(),
  createdAt: z.string().datetime(),
  lastAccessedAt: z.string().datetime(),
  identity: z.record(z.string(), z.unknown()),
  details: z.record(z.string(), z.unknown()).default({}),
}).strict();
export type MediaCacheMetadata = z.infer<typeof mediaCacheMetadataSchema>;

const runCacheReferencesSchema = z.object({
  version: z.literal(1),
  updatedAt: z.string().datetime(),
  entries: z.array(z.object({ kind: cacheKindSchema, cacheKey: z.string().length(64) })).default([]),
}).strict();

function kindDirectory(kind: CacheKind) {
  return kind === "audio" ? "audio" : "video-scenes";
}

export function mediaCacheRoot() {
  return path.resolve(process.env.SCENE_GEN_CACHE_DIR ?? fromRoot("dist", "cache"));
}

export function mediaCachePaths(kind: CacheKind, cacheKey: string, extension: string) {
  const prefix = cacheKey.slice(0, 2);
  const root = mediaCacheRoot();
  return {
    mediaPath: path.join(root, kindDirectory(kind), prefix, `${cacheKey}${extension}`),
    metadataPath: path.join(root, "metadata", kindDirectory(kind), prefix, `${cacheKey}.json`),
    lockPath: path.join(root, "metadata", "locks", `${kind}-${cacheKey}.lock`),
  };
}

export async function hashFileContent(filePath: string) {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

async function exists(filePath: string) {
  try { await access(filePath, constants.F_OK); return true; } catch { return false; }
}

async function validateEntry(kind: CacheKind, cacheKey: string, extension: string) {
  const paths = mediaCachePaths(kind, cacheKey, extension);
  if (!await exists(paths.mediaPath) || !await exists(paths.metadataPath)) return undefined;
  try {
    const metadata = mediaCacheMetadataSchema.parse(await readJson<unknown>(paths.metadataPath));
    if (metadata.kind !== kind || metadata.cacheKey !== cacheKey || metadata.extension !== extension) return undefined;
    const info = await stat(paths.mediaPath);
    if (!info.isFile() || info.size !== metadata.sizeBytes || info.size <= 0) return undefined;
    if (await hashFileContent(paths.mediaPath) !== metadata.contentHash) return undefined;
    return { ...paths, metadata };
  } catch { return undefined; }
}

async function materialize(sourcePath: string, targetPath: string) {
  await ensureDir(path.dirname(targetPath));
  const tempPath = `${targetPath}.${randomUUID()}.tmp`;
  await rm(tempPath, { force: true }).catch(() => undefined);
  try {
    await link(sourcePath, tempPath).catch(async () => copyFile(sourcePath, tempPath));
    await rename(tempPath, targetPath).catch(async () => {
      await rm(targetPath, { force: true }).catch(() => undefined);
      await rename(tempPath, targetPath);
    });
  } finally {
    await rm(tempPath, { force: true }).catch(() => undefined);
  }
}

function runDirectoryFor(targetPath: string) {
  const relative = path.relative(fromRoot("dist", "runs"), path.resolve(targetPath));
  if (relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
  const [runId] = relative.split(path.sep);
  return runId ? path.join(fromRoot("dist", "runs"), runId) : undefined;
}

export async function registerRunCacheReference(targetPath: string, kind: CacheKind, cacheKey: string) {
  const runDir = runDirectoryFor(targetPath);
  if (!runDir) return;
  const filePath = path.join(runDir, "cache-refs.json");
  const release = await acquireLock(`${filePath}.lock`);
  try {
    const fallback = { version: 1 as const, updatedAt: new Date(0).toISOString(), entries: [] };
    const current = await readJson<unknown>(filePath)
      .then((value) => runCacheReferencesSchema.parse(value))
      .catch(() => fallback);
    const entryId = `${kind}:${cacheKey}`;
    const entries = [...current.entries.filter((entry) => `${entry.kind}:${entry.cacheKey}` !== entryId), { kind, cacheKey }];
    await writeJsonAtomic(filePath, runCacheReferencesSchema.parse({
      version: 1,
      updatedAt: new Date().toISOString(),
      entries,
    }));
  } finally {
    await release();
  }
}

export async function restoreMediaCache(input: {
  kind: CacheKind;
  cacheKey: string;
  extension: string;
  targetPath: string;
}) {
  const entry = await validateEntry(input.kind, input.cacheKey, input.extension);
  if (!entry) return undefined;
  await materialize(entry.mediaPath, input.targetPath);
  const updated = mediaCacheMetadataSchema.parse({ ...entry.metadata, lastAccessedAt: new Date().toISOString() });
  await writeJsonAtomic(entry.metadataPath, updated);
  await registerRunCacheReference(input.targetPath, input.kind, input.cacheKey);
  return updated;
}

async function acquireLock(lockPath: string, signal?: AbortSignal) {
  await mkdir(path.dirname(lockPath), { recursive: true });
  const timeoutMs = Math.max(5_000, Number(process.env.MEDIA_CACHE_LOCK_TIMEOUT_MS ?? 600_000));
  const staleMs = Math.max(timeoutMs, Number(process.env.MEDIA_CACHE_STALE_LOCK_MS ?? 900_000));
  const startedAt = Date.now();
  while (true) {
    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Cache wait aborted.");
    try {
      const handle = await open(lockPath, "wx");
      await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
      return async () => {
        await handle.close().catch(() => undefined);
        await rm(lockPath, { force: true }).catch(() => undefined);
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const lockInfo = await stat(lockPath).catch(() => undefined);
      if (lockInfo && Date.now() - lockInfo.mtimeMs > staleMs) {
        await rm(lockPath, { force: true }).catch(() => undefined);
        continue;
      }
      if (Date.now() - startedAt > timeoutMs) {
        throw new Error(`Timed out waiting for cache lock ${path.basename(lockPath)}.`);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

interface CacheFlightResult {
  metadata: MediaCacheMetadata;
  generated: boolean;
}

const inFlight = new Map<string, Promise<CacheFlightResult>>();

export async function getOrCreateMediaCache(input: {
  kind: CacheKind;
  cacheKey: string;
  extension: string;
  targetPath: string;
  identity: Record<string, unknown>;
  details?: Record<string, unknown>;
  force?: boolean;
  signal?: AbortSignal;
  generate: (outputPath: string) => Promise<Record<string, unknown> | void>;
}) {
  if (!input.force) {
    const restored = await restoreMediaCache(input);
    if (restored) return { metadata: restored, generated: false };
  }
  const flightKey = `${input.kind}:${input.cacheKey}`;
  let flight = inFlight.get(flightKey);
  const joinedFlight = Boolean(flight);
  if (!flight) {
    flight = (async () => {
      const paths = mediaCachePaths(input.kind, input.cacheKey, input.extension);
      const release = await acquireLock(paths.lockPath, input.signal);
      try {
        if (!input.force) {
          const existing = await validateEntry(input.kind, input.cacheKey, input.extension);
          if (existing) return { metadata: existing.metadata, generated: false };
        }
        await ensureDir(path.dirname(paths.mediaPath));
        await ensureDir(path.dirname(paths.metadataPath));
        const tempMediaPath = `${paths.mediaPath}.${randomUUID()}.tmp${input.extension}`;
        try {
          const generatedDetails = await input.generate(tempMediaPath);
          const info = await stat(tempMediaPath);
          if (!info.isFile() || info.size <= 0) throw new Error(`Generated ${input.kind} cache entry is empty.`);
          const contentHash = await hashFileContent(tempMediaPath);
          await rename(tempMediaPath, paths.mediaPath).catch(async () => {
            await rm(paths.mediaPath, { force: true }).catch(() => undefined);
            await rename(tempMediaPath, paths.mediaPath);
          });
          const timestamp = new Date().toISOString();
          const metadata = mediaCacheMetadataSchema.parse({
            version: 1,
            kind: input.kind,
            cacheKey: input.cacheKey,
            extension: input.extension,
            contentHash,
            sizeBytes: info.size,
            createdAt: timestamp,
            lastAccessedAt: timestamp,
            identity: input.identity,
            details: { ...(input.details ?? {}), ...(generatedDetails ?? {}) },
          });
          await writeJsonAtomic(paths.metadataPath, metadata);
          return { metadata, generated: true };
        } finally {
          await rm(tempMediaPath, { force: true }).catch(() => undefined);
        }
      } finally {
        await release();
      }
    })();
    inFlight.set(flightKey, flight);
    flight.finally(() => inFlight.delete(flightKey)).catch(() => undefined);
  }
  const result = await flight;
  await materialize(mediaCachePaths(input.kind, input.cacheKey, input.extension).mediaPath, input.targetPath);
  await registerRunCacheReference(input.targetPath, input.kind, input.cacheKey);
  return { metadata: result.metadata, generated: result.generated && !joinedFlight };
}

export async function readRunCacheReferences(runDir: string) {
  return readJson<unknown>(path.join(runDir, "cache-refs.json"))
    .then((value) => runCacheReferencesSchema.parse(value).entries)
    .catch(() => []);
}
