import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const workspaceRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

export const fromRoot = (...parts: string[]) => path.join(workspaceRoot, ...parts);

export async function ensureDir(dir: string) {
  await mkdir(dir, { recursive: true });
}

export async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, "utf8")) as T;
}

export async function writeJson(filePath: string, value: unknown) {
  await ensureDir(path.dirname(filePath));
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export async function writeJsonAtomic(filePath: string, value: unknown) {
  await ensureDir(path.dirname(filePath));
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  try {
    await rename(temporaryPath, filePath);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export function loadDotEnv() {
  const externalKeys = new Set(Object.keys(process.env));
  const loadedKeys = new Set<string>();

  function setEnv(key: string, value: string, overrideLocal: boolean) {
    const normalized = value.replace(/^['"]|['"]$/g, "");
    if (!normalized || normalized === "xxx") return;
    if (externalKeys.has(key) && !loadedKeys.has(key)) return;
    if (!overrideLocal && process.env[key]) return;
    process.env[key] = normalized;
    loadedKeys.add(key);
  }

  for (const envPath of [fromRoot(".env"), fromRoot(".env.local")]) {
    if (!existsSync(envPath)) continue;
    const raw = readFileSync(envPath, "utf8").replace(/^\uFEFF/, "");
    const overrideLocal = envPath.endsWith(".local");
    for (const line of raw.split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!match) continue;
      setEnv(match[1], match[2], overrideLocal);
    }
  }

  for (const configPath of [
    fromRoot("config", "llm.example.json"),
    fromRoot("config", "llm.local.json"),
    fromRoot("config", "news-llm.example.json"),
    fromRoot("config", "news-llm.local.json"),
  ]) {
    if (!existsSync(configPath)) continue;
    const overrideLocal = configPath.endsWith(".local.json");
    const config = JSON.parse(readFileSync(configPath, "utf8").replace(/^\uFEFF/, "")) as Record<
      string,
      string
    >;
    for (const [key, value] of Object.entries(config)) {
      setEnv(key, value, overrideLocal);
    }
  }
}

export function compactText(input: string, max = 220) {
  const text = input.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}...` : text;
}

export function domainFromUrl(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "unknown";
  }
}

export function stableId(...parts: string[]) {
  let hash = 2166136261;
  for (const char of parts.join("|")) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `i_${(hash >>> 0).toString(36)}`;
}

export function slugify(input: string, fallback = "story") {
  const slug = input
    .toLowerCase()
    .replace(/https?:\/\//g, "")
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72);
  return slug || fallback;
}

export function daysAgo(date?: string) {
  if (!date) return 30;
  const time = new Date(date).getTime();
  if (Number.isNaN(time)) return 30;
  return Math.max(0, (Date.now() - time) / 86_400_000);
}

export function parseArgs(argv: string[]) {
  const args: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}
