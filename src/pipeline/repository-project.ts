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
  return value.replace(/[^\p{L}\p{N}]/gu, "").toLowerCase();
}

function isRepositoryOpeningSentence(value: string, name: string) {
  const identity = repositoryTitleIdentity(value);
  const nameIdentity = repositoryTitleIdentity(name);
  const recommendationIdentity = repositoryTitleIdentity(REPOSITORY_HOMEPAGE_PREFIX);
  const shortRecommendationIdentity = repositoryTitleIdentity("开源项目推荐");
  return Boolean(
    nameIdentity
    && identity.includes(nameIdentity)
    && (identity.includes(recommendationIdentity) || identity.includes(shortRecommendationIdentity)),
  );
}

export function repositoryOpeningTitleCount(value: string, name: string) {
  return value
    .split(/[。！？!?\n]+/u)
    .filter((sentence) => isRepositoryOpeningSentence(sentence, name))
    .length;
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

export function repositoryNarrationBody(value: string, name?: string) {
  let body = value.trim();
  if (!name) {
    const match = body.match(/^.*?[。！？!?](?:\s*)/u);
    return match ? body.slice(match[0].length).trim() : body;
  }
  for (let index = 0; index < 4; index += 1) {
    const match = body.match(/^(.*?)[。！？!?](?:\s*)/u);
    if (!match || !isRepositoryOpeningSentence(match[1], name)) break;
    body = body.slice(match[0].length).trim();
  }
  return body;
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
  if (name.toLowerCase() === "ai-job-search") return "A-I Job Search";
  if (name.toLowerCase() === "ai-memory") return "AI Memory";
  if (name.toLowerCase() === "awesome-llm-apps") return "Awesome L-L-M Apps";
  if (name.toLowerCase() === "scientific-agent-skills") return "Scientific Agent Skills";
  if (name.toLowerCase() === "openhuman") return "Open Human";
  if (name.toLowerCase() === "openmaic") return "Open M A I C";
  if (name.toLowerCase() === "open-seo") return "Open S E O";
  if (name.toLowerCase() === "ods") return "O D S";
  if (name.toLowerCase() === "mirofish") return "米若菲什";
  if (name.toLowerCase() === "tooljet") return "图杰特";
  if (name.toLowerCase() === "free-for-dev") return "Free for developers";
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
  const openingBody = repositoryNarrationBody(first.text, name);
  const opening = openingBody ? `${openingTitle}。${openingBody}` : `${openingTitle}。`;
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
