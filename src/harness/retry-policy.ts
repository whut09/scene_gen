import type { QualityIssue, QualityIssueInput, QualityProfile, QualityStage } from "./quality-protocol";
import { normalizeQualityIssue } from "./quality-protocol";
import type { SuggestedAction } from "./stage-types";

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
}

export function withSuggestedActions(issues: QualityIssueInput[], stage: QualityStage) {
  return issues.map((issue) => normalizeQualityIssue(stage, issue));
}

export function planRepair(stage: QualityStage, issues: Array<QualityIssue | QualityIssueInput>, profile?: QualityProfile): RepairPlan {
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
  const action = priority.find((candidate) => errors.some((issue) => issue.repairAction === candidate)) ?? "stop";
  const sceneIndexes = [...new Set(errors.filter((issue) => issue.repairAction === action).map((issue) => issue.sceneIndex).filter((value): value is number => typeof value === "number"))];
  const audioSceneIndexes = [...new Set(errors.filter((issue) => issue.repairAction === "resynthesize-audio").map((issue) => issue.sceneIndex).filter((value): value is number => typeof value === "number"))];
  const videoSceneIndexes = [...new Set(errors.filter((issue) => issue.repairAction === "rerender-scenes" || issue.repairAction === "switch-template").map((issue) => issue.sceneIndex).filter((value): value is number => typeof value === "number"))];
  const forceAudioRebuild = errors.some((issue) => issue.repairAction === "resynthesize-audio");
  const forceVideoRebuild = errors.some((issue) => issue.repairAction === "rerender-scenes" || issue.repairAction === "switch-template");
  return {
    action,
    sceneIndexes,
    audioSceneIndexes,
    videoSceneIndexes,
    muxRequired: forceAudioRebuild || errors.some((issue) => issue.repairAction === "remux"),
    forceAudioRebuild,
    forceVideoRebuild,
    retryable: !["check-environment", "stop", "switch-template"].includes(action),
    reason: errors.filter((issue) => issue.repairAction === action).map((issue) => issue.code).join(", "),
  };
}
