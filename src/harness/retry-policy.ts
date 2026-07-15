import type { QualityIssue, QualityIssueInput, QualityProfile, QualityStage } from "./quality-protocol";
import { normalizeQualityIssue } from "./quality-protocol";
import type { SuggestedAction } from "./stage-types";
import { dirtyPlanFromIssues, emptyDirtyPlan, mergeDirtyPlans, type DirtyPlan } from "./dirty-plan";

export interface RepairPlan {
  action: SuggestedAction;
  sceneIndexes: number[];
  audioSceneIndexes: number[];
  videoSceneIndexes: number[];
  muxRequired: boolean;
  forceAudioRebuild: boolean;
  forceVideoRebuild: boolean;
  retryable: boolean;
  reason: string;
  dirtyPlan: DirtyPlan;
}

export function withSuggestedActions(issues: QualityIssueInput[], stage: QualityStage) {
  return issues.map((issue) => normalizeQualityIssue(stage, issue));
}

export function planRepair(stage: QualityStage, issues: Array<QualityIssue | QualityIssueInput>, profile?: QualityProfile, sceneCount?: number, attempt = 1): RepairPlan {
  const errors = withSuggestedActions(issues.filter((issue) => issue.severity === "error"
    || (issue.severity === "warning" && Boolean(profile && (profile.blockWarnings || profile.blockingWarningCodes.includes(issue.code))))), stage);
  if (errors.length === 0) return {
    action: "none",
    sceneIndexes: [],
    audioSceneIndexes: [],
    videoSceneIndexes: [],
    muxRequired: false,
    forceAudioRebuild: false,
    forceVideoRebuild: false,
    retryable: false,
    reason: "No blocking issues.",
    dirtyPlan: emptyDirtyPlan(),
  };
  const priority: SuggestedAction[] = [
    "check-environment",
    "remux",
    "rerender-scenes",
    "resynthesize-audio",
    "revise-scenes",
    "regenerate-draft",
    "switch-template",
    "stop",
  ];
  let action = priority.find((candidate) => errors.some((issue) => issue.repairAction === candidate)) ?? "stop";
  const inferredSceneCount = sceneCount ?? Math.max(0, ...errors.map((issue) => (issue.sceneIndex ?? -1) + 1));
  let dirtyPlan = dirtyPlanFromIssues(errors, inferredSceneCount);
  if (stage === "video" && attempt > 1 && errors.some((issue) => issue.code === "video_project_duration_drift")) {
    action = "rerender-scenes";
    dirtyPlan = mergeDirtyPlans(dirtyPlan, {
      audioSceneIndexes: [],
      videoSceneIndexes: Array.from({ length: inferredSceneCount }, (_, index) => index),
      concatAudio: false,
      concatVideo: true,
      remux: true,
      fullRebuild: false,
      reasons: [{ code: "video_project_duration_drift_escalated", stage: "video", detail: `attempt:${attempt}` }],
    });
  }
  const sceneIndexes = action === "rerender-scenes" && attempt > 1
    ? dirtyPlan.videoSceneIndexes
    : [...new Set(errors.filter((issue) => issue.repairAction === action).map((issue) => issue.sceneIndex).filter((value): value is number => typeof value === "number"))];
  const audioSceneIndexes = dirtyPlan.audioSceneIndexes;
  const videoSceneIndexes = dirtyPlan.videoSceneIndexes;
  const forceAudioRebuild = dirtyPlan.concatAudio;
  const forceVideoRebuild = dirtyPlan.concatVideo;
  return {
    action,
    sceneIndexes,
    audioSceneIndexes,
    videoSceneIndexes,
    muxRequired: dirtyPlan.remux,
    forceAudioRebuild,
    forceVideoRebuild,
    retryable: !["check-environment", "stop", "switch-template"].includes(action),
    reason: errors.filter((issue) => issue.repairAction === action).map((issue) => issue.code).join(", ")
      || dirtyPlan.reasons.at(-1)?.code
      || "repair-required",
    dirtyPlan,
  };
}
