import type { VideoProject } from "./types";
import { contentTypeForItem } from "./content-type";

export function isNewsProject(project: VideoProject) {
  const source = project.sources[0];
  return source ? contentTypeForItem(source) === "news" : false;
}

export function isTechnicalArticleProject(project: VideoProject) {
  const source = project.sources[0];
  return source ? contentTypeForItem(source) === "technical-article" : false;
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

export function ensureTitleSpokenFirst(project: VideoProject): VideoProject {
  const segments = project.narrationSegments;
  const title = project.meta.title.trim().replace(/[\u3002\uff01\uff1f?]+$/u, "");
  if (!title || !segments?.[0]) return project;
  const first = segments[0];
  const spoken = first.ttsText ?? first.text;
  if (compact(spoken).startsWith(compact(title))) return project;
  const stripRepeatedTitle = (value: string) => {
    const titleIndex = value.indexOf(title);
    if (titleIndex < 0 || titleIndex > 36) return value.trim();
    return value.slice(titleIndex + title.length).replace(/^[\u3002\uff01\uff1f?\uff1a:\uff0c,\s]+/u, "").trim();
  };
  const textBody = stripRepeatedTitle(first.text);
  const spokenBody = stripRepeatedTitle(spoken) || textBody;
  const nextSegments = segments.map((segment, index) => index === 0 ? {
    ...segment,
    text: `${title}\u3002${textBody}`,
    ttsText: `${title}\u3002${spokenBody}`,
  } : segment);
  return { ...project, narrationSegments: nextSegments, narration: nextSegments.map((segment) => segment.text).join("\n") };
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
