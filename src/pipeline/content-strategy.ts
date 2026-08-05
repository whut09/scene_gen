import { classifyWebpageContent, contentTypeForItem } from "./content-type";
import type { ContentType, HotItem, StoryPlanVisual, VideoProject } from "./types";

export interface ContentDurationPolicy {
  contentType: ContentType;
  minimumSeconds: number;
  targetSeconds: number;
  maximumSeconds: number;
  hardMaximumSeconds: number;
  sceneCount: 4 | 5;
  visuals: StoryPlanVisual[];
}

const policies: Record<ContentType, ContentDurationPolicy> = {
  news: {
    contentType: "news",
    minimumSeconds: 32,
    targetSeconds: 40,
    maximumSeconds: 45,
    hardMaximumSeconds: 50,
    sceneCount: 4,
    visuals: ["title", "briefing", "flow", "outro"],
  },
  repository: {
    contentType: "repository",
    minimumSeconds: 40,
    targetSeconds: 48,
    maximumSeconds: 55,
    hardMaximumSeconds: 60,
    sceneCount: 4,
    visuals: ["title", "briefing", "flow", "outro"],
  },
  "technical-article": {
    contentType: "technical-article",
    minimumSeconds: 50,
    targetSeconds: 60,
    maximumSeconds: 70,
    hardMaximumSeconds: 75,
    sceneCount: 5,
    visuals: ["title", "briefing", "chart", "flow", "outro"],
  },
};

export function contentDurationPolicy(contentType: ContentType) {
  return policies[contentType];
}

export function contentTypeForProject(project: VideoProject): ContentType {
  const source = project.sources[0];
  return source ? contentTypeForItem(source) : "news";
}

export function contentTypeForUrl(url: string): ContentType {
  if (/github\.com\//i.test(url)) return "repository";
  return classifyWebpageContent(url);
}

export function defaultTargetSecondsForUrl(url: string) {
  return contentDurationPolicy(contentTypeForUrl(url)).targetSeconds;
}

export function resolveContentTargetSeconds(item: HotItem, requestedSeconds?: number) {
  const policy = contentDurationPolicy(contentTypeForItem(item));
  if (requestedSeconds !== undefined && Number.isFinite(requestedSeconds) && requestedSeconds > 0) return requestedSeconds;
  return policy.targetSeconds;
}

export function storyVisualSequence(project: VideoProject) {
  return [...contentDurationPolicy(contentTypeForProject(project)).visuals];
}

export function allocateSceneDurations(targetSeconds: number, visuals: StoryPlanVisual[]) {
  const weights = visuals.map((visual) => visual === "title" ? 0.12 : visual === "outro" ? 0.18 : 1);
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  const minimums = visuals.map((visual) => visual === "title" ? 4 : visual === "outro" ? 6 : 8);
  const minimumTotal = minimums.reduce((sum, duration) => sum + duration, 0);
  const remaining = Math.max(0, Math.round(targetSeconds) - minimumTotal);
  const durations = weights.map((weight, index) => minimums[index] + Math.floor(remaining * weight / totalWeight));
  let delta = Math.round(targetSeconds) - durations.reduce((sum, duration) => sum + duration, 0);
  let index = 1;
  while (delta > 0) {
    durations[index % durations.length] += 1;
    delta -= 1;
    index += 1;
  }
  return durations;
}
