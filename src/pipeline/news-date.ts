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
  const chineseDate = publishedAt.match(/^(20\d{2})年(\d{1,2})月(\d{1,2})日$/);
  const date = chineseDate ? new Date(Date.UTC(Number(chineseDate[1]), Number(chineseDate[2]) - 1, Number(chineseDate[3]))) : new Date(publishedAt);
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


function removeRepeatedOpeningTitle(value: string, title: string) {
  const firstIndex = value.indexOf(title);
  if (firstIndex < 0) return value.trim();
  const prefix = value.slice(0, firstIndex + title.length);
  let suffix = value.slice(firstIndex + title.length);
  let repeatedIndex = suffix.indexOf(title);
  while (repeatedIndex >= 0) {
    suffix = suffix.slice(0, repeatedIndex) + suffix.slice(repeatedIndex + title.length);
    repeatedIndex = suffix.indexOf(title);
  }
  return `${prefix}${suffix}`
    .replace(/这条新闻讲的是\s*[：:]\s*[。！？!?]?/g, "")
    .replace(/([。！？!?])\s*([。！？!?])/g, "$1")
    .trim();
}

function normalizeDateString(value: string, technical: boolean) {
  let normalized = value
    .replace(/(20\d{2})-(\d{2})-(\d{2})[T\s]\d{2}:\d{2}:\d{2}(?:[.]\d+)?Z?/g, (_, year, month, day) => `${year}年${Number(month)}月${Number(day)}日`)
    .replace(/(20\d{2})年(\d{1,2})月(\d{1,2})日\s*\d{1,2}[:：]\d{2}(?::\d{2})?/g, '$1年$2月$3日')
    .replace(/(发布于\s*20\d{2}年\d{1,2}月\d{1,2}日)(?:\s*发布于\s*20\d{2}年\d{1,2}月\d{1,2}日)+/g, '$1');
  if (technical) normalized = normalized
    .replace(/新闻日期[:：]\s*20\d{2}年\d{1,2}月\d{1,2}日[。；;，,]?/g, '')
    .replace(/(?:发布于|发表于|发布时间|更新时间)[:：]?\s*20\d{2}年\d{1,2}月\d{1,2}日[。；;，,]?/g, '')
    .replace(/于\s*20\d{2}年\d{1,2}月\d{1,2}日\s*发布/g, '');
  return normalized.replace(/\s{2,}/g, ' ').trim();
}

export function normalizeProjectDatePrecision(project: VideoProject): VideoProject {
  const technical = isTechnicalArticleProject(project);
  const visit = (value: unknown): unknown => {
    if (typeof value === 'string') return normalizeDateString(value, technical);
    if (Array.isArray(value)) return value.map(visit);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, visit(item)]));
    return value;
  };
  return visit(project) as VideoProject;
}

export function ensureTitleSpokenFirst(project: VideoProject): VideoProject {
  const segments = project.narrationSegments;
  const title = project.meta.title.trim().replace(/[\u3002\uff01\uff1f?]+$/u, "");
  if (!title || !segments?.[0]) return project;
  const first = segments[0];
  const spoken = first.ttsText ?? first.text;
  if (compact(first.text).startsWith(compact(title))) {
    const nextSegments = segments.map((segment, index) => index === 0 ? {
      ...segment,
      text: removeRepeatedOpeningTitle(segment.text, title),
      ttsText: removeRepeatedOpeningTitle(segment.text, title),
    } : segment);
    return { ...project, narrationSegments: nextSegments, narration: nextSegments.map((segment) => segment.text).join("\n") };
  }
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
  const nextSegments = segments.map((segment, index) => index === 0 ? {
    ...segment,
    text: removeRepeatedOpeningTitle(datedOpening, title),
    ttsText: removeRepeatedOpeningTitle(segment.text, title),
  } : segment);
  return {
    ...project,
    narrationSegments: nextSegments,
    narration: nextSegments.map((segment) => segment.text).join("\n"),
  };
}
