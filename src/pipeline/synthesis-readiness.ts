import type { VideoProject, VideoScene } from "./types";
import { containsForbiddenGithubReference, containsForbiddenPlatformPromotion } from "./story";

export interface SynthesisReadinessIssue {
  code: string;
  message: string;
  sceneIndex?: number;
}

export class ProjectSynthesisReadinessError extends Error {
  constructor(readonly issues: SynthesisReadinessIssue[]) {
    super(`Synthesis blocked by the deterministic project readiness gate: ${issues.map((issue) => issue.code).join(", ")}`);
    this.name = "ProjectSynthesisReadinessError";
  }
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

function sceneNarrationMinimum(scene: VideoScene) {
  if (scene.type === "title") return 55;
  if (scene.type === "briefing_points") return 90;
  if (scene.type === "outro") return 65;
  return 85;
}

function scenePublicText(scene: VideoScene) {
  return JSON.stringify(scene);
}

function compactText(value: string) {
  return value.replace(/\s+/g, "").trim();
}

export function synthesisTargetSeconds(project: VideoProject, requestedSeconds?: number) {
  const repository = Boolean(repositoryName(project));
  const requested = requestedSeconds && Number.isFinite(requestedSeconds) && requestedSeconds > 0
    ? requestedSeconds
    : project.meta.durationSeconds;
  return repository ? Math.max(75, requested) : requested;
}

export function projectSynthesisReadinessIssues(project: VideoProject, targetSeconds: number): SynthesisReadinessIssue[] {
  const repository = repositoryName(project);
  if (!repository) return [];

  const issues: SynthesisReadinessIssue[] = [];
  const segments = project.narrationSegments ?? [];
  if (project.scenes.length !== 5 || segments.length !== project.scenes.length) {
    issues.push({ code: "scene_segment_mismatch", message: "Repository videos require five scenes with five narration segments." });
    return issues;
  }

  const narrationChars = compactText(project.narration).length;
  const minimumChars = Math.ceil(targetSeconds * 4.8);
  if (narrationChars < minimumChars) {
    issues.push({
      code: "narration_short",
      message: `Repository narration has ${narrationChars} characters; ${minimumChars} are required for the ${targetSeconds}-second target.`,
    });
  }

  project.scenes.forEach((scene, sceneIndex) => {
    const actual = compactText(segments[sceneIndex]?.text ?? "").length;
    const minimum = sceneNarrationMinimum(scene);
    if (actual < minimum) {
      issues.push({
        code: "scene_narration_thin",
        sceneIndex,
        message: `Repository scene ${sceneIndex + 1} has ${actual} narration characters; ${minimum} are required.`,
      });
    }
  });

  const firstScene = project.scenes[0];
  if (firstScene?.type !== "title" || firstScene.headline !== `开源项目推荐：${repository}`) {
    issues.push({ code: "repository_recommendation_missing", message: "The first repository scene must show the canonical recommendation banner." });
  }
  if (project.meta.title !== repository) {
    issues.push({ code: "repository_name_not_canonical", message: "Repository video metadata must keep the original project name." });
  }
  if (!compactText(segments[0]?.text ?? "").startsWith(repository)) {
    issues.push({ code: "repository_name_not_spoken_first", sceneIndex: 0, message: "The first narration must begin with the original repository name." });
  }

  const publicText = [project.meta.title, project.narration, ...project.scenes.map(scenePublicText)].join(" ");
  const repositoryAddresses = project.sources.flatMap((source) => [source.url, source.repo].filter((value): value is string => Boolean(value)));
  if (containsForbiddenGithubReference(publicText, repositoryAddresses)) {
    issues.push({ code: "external_platform_reference_exposed", message: "Public repository video text must not expose hosting-platform names or repository addresses." });
  }
  if (containsForbiddenPlatformPromotion(publicText)) {
    issues.push({ code: "external_platform_promotion_exposed", message: "Public repository video text must not contain third-party platform promotion." });
  }
  return issues;
}

export function assertProjectReadyForSynthesis(project: VideoProject, targetSeconds: number) {
  const issues = projectSynthesisReadinessIssues(project, targetSeconds);
  if (issues.length > 0) throw new ProjectSynthesisReadinessError(issues);
}
