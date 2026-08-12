import type { VideoProject } from "./types";

export const REPOSITORY_HOMEPAGE_PREFIX = "今日开源热点趋势项目推荐";
export const REPOSITORY_TITLE_SEPARATOR = "｜";

export function normalizeRepositoryTitleSummary(value: string) {
  return value
    .replace(/^用途[：:]\s*/u, "")
    .replace(/[；;。！？!?].*$/u, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 28)
    .replace(/[，、：:]$/u, "");
}

export function repositoryHomepageTitle(name: string, summary = "") {
  const normalizedSummary = normalizeRepositoryTitleSummary(summary);
  return `${REPOSITORY_HOMEPAGE_PREFIX}：${name}${normalizedSummary ? `${REPOSITORY_TITLE_SEPARATOR}${normalizedSummary}` : ""}`;
}

export function repositoryNarrationTitle(name: string, summary = "") {
  return repositoryHomepageTitle(name, summary);
}

export function repositoryTitleIdentity(value: string) {
  return value.replace(/[\s，,｜|：:。！？!?]/gu, "").toLowerCase();
}

function repositoryName(project: VideoProject) {
  const source = project.sources[0];
  if (!source || source.kind !== "github") return "";
  if (source.repo) return source.repo.split("/").filter(Boolean).at(-1) ?? "";
  try {
    return new URL(source.url).pathname.split("/").filter(Boolean).at(-1) ?? "";
  } catch {
    return "";
  }
}

export function repositoryProjectUrl(project: VideoProject) {
  const source = project.sources.find((item) => item.kind === "github" || Boolean(item.repo));
  if (!source) return "";
  try {
    const parsed = new URL(source.url);
    if (parsed.hostname.toLowerCase() !== "github.com") return "";
    const parts = parsed.pathname.split("/").filter(Boolean).slice(0, 2);
    return parts.length === 2 ? `github.com/${parts.join("/")}` : "";
  } catch {
    return source.repo ? `github.com/${source.repo.replace(/^\/+|\/+$/g, "")}` : "";
  }
}

export function repositoryNarrationBody(value: string) {
  const match = value.match(/^.*?[。！？!?](?:\s*)/u);
  return match ? value.slice(match[0].length).trim() : value.trim();
}

export function repositoryProjectTitleSummary(project: VideoProject) {
  const firstScene = project.scenes[0];
  if (firstScene?.type === "title") {
    const fromHeadline = firstScene.headline.split(REPOSITORY_TITLE_SEPARATOR).slice(1).join(REPOSITORY_TITLE_SEPARATOR);
    if (fromHeadline) return normalizeRepositoryTitleSummary(fromHeadline);
    const fromSubhead = firstScene.subhead.startsWith("用途：")
      ? normalizeRepositoryTitleSummary(firstScene.subhead)
      : "";
    if (fromSubhead) return fromSubhead;
  }
  return normalizeRepositoryTitleSummary(project.sources[0]?.summary ?? "");
}

export function repositorySynthesisName(name: string) {
  if (name.toLowerCase() === "mirofish") return "米若菲什";
  return name
    .split(/([-_.]+)/)
    .map((part) => /^[A-Za-z0-9]+$/.test(part) ? part.charAt(0).toUpperCase() + part.slice(1) : part)
    .join("")
    .replace(/[-_.]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function repositorySynthesisText(text: string, name: string) {
  const spoken = repositorySynthesisName(name);
  return text.replace(new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), spoken);
}

export function ensureRepositoryProjectIdentity(project: VideoProject): VideoProject {
  const name = repositoryName(project);
  if (!name || !project.narrationSegments?.[0]) return project;

  const first = project.narrationSegments[0];
  const summary = repositoryProjectTitleSummary(project);
  const openingTitle = repositoryNarrationTitle(name, summary);
  const openingBody = repositoryNarrationBody(first.text);
  const opening = `${openingTitle}。${openingBody}`.trim();
  const scenes = project.scenes.map((scene, index) => index === 0 && scene.type === "title"
    ? { ...scene, kicker: REPOSITORY_HOMEPAGE_PREFIX, headline: repositoryHomepageTitle(name, summary) }
    : scene);
  const narrationSegments = project.narrationSegments.map((segment, index) => {
    const text = index === 0 ? opening : segment.text;
    // Rebuild synthesis text from display text on every run. Persisted ttsText may
    // contain an obsolete pronunciation alias from a previous synthesis attempt.
    return {
      ...segment,
      text,
      ttsText: repositorySynthesisText(text, name),
      providerSynthesisText: undefined,
      pronunciationPlan: undefined,
      audioStartSeconds: undefined,
      durationSeconds: undefined,
      speechAlignment: undefined,
    };
  });

  return {
    ...project,
    meta: { ...project.meta, title: name },
    narration: narrationSegments.map((segment) => segment.text).join("\n"),
    narrationSegments,
    scenes,
  };
}

export function repositoryProjectName(project: VideoProject) {
  return repositoryName(project);
}
