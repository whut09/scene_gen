import type { QualityStage } from "./quality";
import type { StageIssue, SuggestedAction } from "./stage-types";

export interface RepairPlan {
  action: SuggestedAction;
  sceneIndexes: number[];
  retryable: boolean;
  reason: string;
}

const issueActions: Record<string, SuggestedAction> = {
  scene_narration_mismatch: "revise-scenes",
  scene_narration_overloaded: "revise-scenes",
  scene_extra_numbers: "revise-scenes",
  scene_source_number_unverified: "revise-scenes",
  briefing_thin: "revise-scenes",
  chart_thin: "revise-scenes",
  flow_thin: "revise-scenes",
  outro_thin: "revise-scenes",
  qualitative_chart_fake_percentage: "revise-scenes",
  parallel_flow_prompt_mismatch: "revise-scenes",
  github_briefing_template_mismatch: "revise-scenes",
  title_not_spoken_first: "revise-scenes",
  news_date_not_spoken: "revise-scenes",
  news_date_missing: "regenerate-draft",
  title_not_chinese_summary: "regenerate-draft",
  audio_title_opening_missing: "revise-scenes",
  audio_title_incomplete: "revise-scenes",
  duration_out_of_range: "revise-scenes",
  speech_too_fast: "revise-scenes",
  speech_too_slow: "revise-scenes",
  segment_speed_uneven: "revise-scenes",
  segment_speed_variance: "revise-scenes",
  tts_arabic_digits: "revise-scenes",
  audio_missing: "resynthesize-audio",
  segment_timing_missing: "resynthesize-audio",
  audio_scene_drift: "resynthesize-audio",
  asr_verification_failed: "check-environment",
  stream_duration_drift: "remux",
  video_project_duration_drift: "remux",
  blank_frame: "rerender-scenes",
  stream_missing: "rerender-scenes",
  wrong_dimensions: "rerender-scenes",
  scene_motion_too_static: "switch-template",
  video_motion_too_static: "switch-template",
};

export function actionForIssue(issue: StageIssue, stage: QualityStage): SuggestedAction {
  if (issueActions[issue.code]) return issueActions[issue.code];
  if (stage === "draft") return issue.sceneIndex === undefined ? "regenerate-draft" : "revise-scenes";
  if (stage === "audio") return issue.sceneIndex === undefined ? "check-environment" : "revise-scenes";
  if (stage === "video") return "rerender-scenes";
  return "stop";
}

export function withSuggestedActions<T extends StageIssue>(issues: T[], stage: QualityStage) {
  return issues.map((issue) => ({ ...issue, suggestedAction: issue.suggestedAction ?? actionForIssue(issue, stage) }));
}

export function planRepair(stage: QualityStage, issues: StageIssue[]): RepairPlan {
  const errors = withSuggestedActions(issues.filter((issue) => issue.severity === "error"), stage);
  if (errors.length === 0) return { action: "none", sceneIndexes: [], retryable: false, reason: "No blocking issues." };
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
  const action = priority.find((candidate) => errors.some((issue) => issue.suggestedAction === candidate)) ?? "stop";
  const sceneIndexes = [...new Set(errors.filter((issue) => issue.suggestedAction === action).map((issue) => issue.sceneIndex).filter((value): value is number => typeof value === "number"))];
  return {
    action,
    sceneIndexes,
    retryable: !["check-environment", "stop", "switch-template"].includes(action),
    reason: errors.filter((issue) => issue.suggestedAction === action).map((issue) => issue.code).join(", "),
  };
}
