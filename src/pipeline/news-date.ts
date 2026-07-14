import type { VideoProject } from "./types";

export function isNewsProject(project: VideoProject) {
  return project.sources[0]?.kind !== "github";
}

export function projectNewsDate(project: VideoProject) {
  if (!isNewsProject(project)) return "";
  const publishedAt = project.sources[0]?.publishedAt;
  if (!publishedAt) return "";
  const date = new Date(publishedAt);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(date);
}

function compact(value: string) {
  return value.replace(/\s+/g, "").replace(/[：:，,。.!！?？_\-]/g, "");
}

export function ensureNewsDateNarration(project: VideoProject): VideoProject {
  const date = projectNewsDate(project);
  const segments = project.narrationSegments;
  if (!date || !segments?.[0]) return project;
  const opening = segments[0].text.trim();
  if (compact(opening).includes(compact(date))) return project;

  const title = project.meta.title.trim().replace(/[。！？!?]+$/, "");
  let body = opening;
  if (compact(opening).startsWith(compact(title))) {
    body = opening.slice(title.length).replace(/^[。！？!?，,：:\s]+/, "").trim();
  }
  const datedOpening = [title ? `${title}。` : "", `新闻日期：${date}。`, body].filter(Boolean).join("");
  const nextSegments = segments.map((segment, index) => index === 0 ? { ...segment, text: datedOpening } : segment);
  return {
    ...project,
    narrationSegments: nextSegments,
    narration: nextSegments.map((segment) => segment.text).join("\n"),
  };
}
