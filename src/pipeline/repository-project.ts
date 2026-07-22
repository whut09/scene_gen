import type { VideoProject } from "./types";

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

function narrationBody(value: string) {
  const match = value.match(/^.*?[。！？!?](?:\s*)/u);
  return match ? value.slice(match[0].length).trim() : value.trim();
}

export function ensureRepositoryProjectIdentity(project: VideoProject): VideoProject {
  const name = repositoryName(project);
  if (!name || !project.narrationSegments?.[0]) return project;

  const first = project.narrationSegments[0];
  const opening = `${name}，开源项目推荐。${narrationBody(first.text)}`.trim();
  const scenes = project.scenes.map((scene, index) => index === 0 && scene.type === "title"
    ? { ...scene, kicker: "开源项目推荐", headline: `开源项目推荐：${name}` }
    : scene);
  const narrationSegments = project.narrationSegments.map((segment, index) => index === 0
    ? { ...segment, text: opening, ttsText: undefined, providerSynthesisText: undefined, pronunciationPlan: undefined, audioStartSeconds: undefined, durationSeconds: undefined, speechAlignment: undefined }
    : segment);

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
