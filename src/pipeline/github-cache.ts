import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { StoryManifestItem } from "./story-manifest";
import type { VideoProject } from "./types";
import { videoProjectSchema } from "./schemas";

export interface CompletedGithubCacheHit {
  projectPath: string;
  project: VideoProject;
  outputPath: string;
  manifestItem?: StoryManifestItem;
}

export function githubRepositoryKey(url: string) {
  try {
    const parsed = new URL(url);
    if (parsed.hostname.toLowerCase() !== "github.com") return "";
    const parts = parsed.pathname.split("/").filter(Boolean).slice(0, 2);
    return parts.length === 2 ? parts.join("/").toLowerCase() : "";
  } catch {
    return "";
  }
}

async function readProject(projectPath: string) {
  try {
    const project = JSON.parse(await readFile(projectPath, "utf8")) as unknown;
    return videoProjectSchema.parse(project);
  } catch {
    return null;
  }
}

async function isFile(filePath: string) {
  try {
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
}

async function readJson(filePath: string) {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as Record<string, any>;
  } catch {
    return null;
  }
}

export async function findCompletedGithubCache(input: {
  url: string;
  storiesDir: string;
  manifest?: StoryManifestItem[];
  runsDir: string;
}) {
  const key = githubRepositoryKey(input.url);
  if (!key) return null;
  const candidates: CompletedGithubCacheHit[] = [];
  const seenProjects = new Set<string>();
  const addCandidate = async (projectPath: string, outputPath: string, manifestItem?: StoryManifestItem) => {
    const absoluteProjectPath = path.resolve(projectPath);
    const absoluteOutputPath = path.resolve(outputPath);
    if (seenProjects.has(absoluteProjectPath) || !await isFile(absoluteOutputPath)) return;
    const project = await readProject(absoluteProjectPath);
    if (!project || githubRepositoryKey(project.sources[0]?.url ?? "") !== key) return;
    seenProjects.add(absoluteProjectPath);
    candidates.push({ projectPath: absoluteProjectPath, project, outputPath: absoluteOutputPath, manifestItem });
  };

  for (const item of input.manifest ?? []) {
    if (githubRepositoryKey(item.sourceUrl ?? "") !== key || !item.outputPath) continue;
    await addCandidate(item.projectPath, item.outputPath, item);
  }
  for (const name of (await readdir(input.storiesDir).catch(() => [])).filter((value) => value.endsWith(".json") && value !== "manifest.json")) {
    const projectPath = path.join(input.storiesDir, name);
    const project = await readProject(projectPath);
    const sourceUrl = project?.sources[0]?.url ?? "";
    if (githubRepositoryKey(sourceUrl) !== key) continue;
    const manifestItem = (input.manifest ?? []).find((item) => path.resolve(item.projectPath) === path.resolve(projectPath));
    const outputPath = manifestItem?.outputPath;
    if (outputPath) await addCandidate(projectPath, outputPath, manifestItem);
  }

  for (const runName of await readdir(input.runsDir).catch(() => [])) {
    const runDir = path.join(input.runsDir, runName);
    const journal = await readJson(path.join(runDir, "run.json"));
    if (!journal || journal.status !== "succeeded") continue;
    const outputPath = journal.artifacts?.outputPath;
    const projectPath = journal.artifacts?.projectPath;
    if (typeof outputPath !== "string" || typeof projectPath !== "string") continue;
    await addCandidate(projectPath, outputPath);
  }
  if (candidates.length === 0) return null;
  const ranked = await Promise.all(candidates.map(async (candidate) => ({
    candidate,
    modifiedAt: (await stat(candidate.outputPath)).mtimeMs,
  })));
  ranked.sort((left, right) => right.modifiedAt - left.modifiedAt);
  return ranked[0].candidate;
}
