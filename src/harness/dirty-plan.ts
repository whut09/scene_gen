import { z } from "zod";
import type { JsonPatchOperation } from "./loop-engineering";
import type { QualityIssue, QualityIssueInput } from "./quality-protocol";

export const dirtyPlanReasonSchema = z.object({
  code: z.string().min(1),
  stage: z.enum(["draft", "audio", "video"]),
  sceneIndex: z.number().int().nonnegative().optional(),
  detail: z.string().optional(),
}).strict();

export const dirtyPlanSchema = z.object({
  audioSceneIndexes: z.array(z.number().int().nonnegative()),
  videoSceneIndexes: z.array(z.number().int().nonnegative()),
  concatAudio: z.boolean(),
  concatVideo: z.boolean(),
  remux: z.boolean(),
  fullRebuild: z.boolean(),
  reasons: z.array(dirtyPlanReasonSchema),
}).strict();

export type DirtyPlan = z.infer<typeof dirtyPlanSchema>;

export function emptyDirtyPlan(): DirtyPlan {
  return { audioSceneIndexes: [], videoSceneIndexes: [], concatAudio: false, concatVideo: false, remux: false, fullRebuild: false, reasons: [] };
}

function uniqueIndexes(values: number[]) {
  return [...new Set(values)].sort((left, right) => left - right);
}

export function mergeDirtyPlans(...plans: DirtyPlan[]): DirtyPlan {
  return dirtyPlanSchema.parse({
    audioSceneIndexes: uniqueIndexes(plans.flatMap((plan) => plan.audioSceneIndexes)),
    videoSceneIndexes: uniqueIndexes(plans.flatMap((plan) => plan.videoSceneIndexes)),
    concatAudio: plans.some((plan) => plan.concatAudio),
    concatVideo: plans.some((plan) => plan.concatVideo),
    remux: plans.some((plan) => plan.remux),
    fullRebuild: plans.some((plan) => plan.fullRebuild),
    reasons: plans.flatMap((plan) => plan.reasons).filter((reason, index, values) => values.findIndex((item) => JSON.stringify(item) === JSON.stringify(reason)) === index),
  });
}

function issuePlan(issue: QualityIssue | QualityIssueInput, sceneCount: number): DirtyPlan {
  const plan = emptyDirtyPlan();
  plan.reasons.push({
    code: issue.code,
    stage: issue.stage ?? "draft",
    ...(issue.sceneIndex === undefined ? {} : { sceneIndex: issue.sceneIndex }),
  });
  const sceneIndex = issue.sceneIndex;
  if (["audio_pronunciation_mismatch", "audio_scene_drift"].includes(issue.code)) {
    if (sceneIndex !== undefined) plan.audioSceneIndexes.push(sceneIndex);
    else plan.audioSceneIndexes.push(...Array.from({ length: sceneCount }, (_, index) => index));
    plan.concatAudio = true;
    plan.remux = true;
  } else if (["blank_frame", "scene_motion_too_static"].includes(issue.code)) {
    if (sceneIndex !== undefined) plan.videoSceneIndexes.push(sceneIndex);
    plan.concatVideo = true;
    plan.remux = true;
  } else if (["stream_duration_drift", "video_project_duration_drift"].includes(issue.code)) {
    plan.remux = true;
  } else if (issue.code === "wrong_dimensions") {
    plan.videoSceneIndexes.push(...Array.from({ length: sceneCount }, (_, index) => index));
    plan.concatVideo = true;
    plan.remux = true;
  } else if (issue.repairAction === "resynthesize-audio") {
    plan.audioSceneIndexes.push(...sceneIndex === undefined ? Array.from({ length: sceneCount }, (_, index) => index) : [sceneIndex]);
    plan.concatAudio = true;
    plan.remux = true;
  } else if (issue.repairAction === "rerender-scenes" || issue.repairAction === "switch-template") {
    plan.videoSceneIndexes.push(...sceneIndex === undefined ? Array.from({ length: sceneCount }, (_, index) => index) : [sceneIndex]);
    plan.concatVideo = true;
    plan.remux = true;
  } else if (issue.repairAction === "regenerate-draft") {
    plan.fullRebuild = true;
  }
  return plan;
}

export function dirtyPlanFromIssues(issues: Array<QualityIssue | QualityIssueInput>, sceneCount: number) {
  return mergeDirtyPlans(...issues.map((issue) => issuePlan(issue, sceneCount)), emptyDirtyPlan());
}

export function dirtyPlanFromPatch(patch: JsonPatchOperation[], sceneCount: number): DirtyPlan {
  const plan = emptyDirtyPlan();
  for (const operation of patch) {
    const sceneMatch = operation.path.match(/^\/scenes\/(\d+)(?:\/(.*))?$/);
    const narrationMatch = operation.path.match(/^\/narrationSegments\/(\d+)(?:\/(.*))?$/);
    if (sceneMatch) {
      const sceneIndex = Number(sceneMatch[1]);
      const field = sceneMatch[2] ?? "";
      if (!field || operation.op === "add" || operation.op === "remove") plan.fullRebuild = true;
      else if (field === "duration") {
        plan.videoSceneIndexes.push(sceneIndex);
        plan.concatVideo = true;
        plan.remux = true;
      } else {
        plan.videoSceneIndexes.push(sceneIndex);
        plan.concatVideo = true;
        plan.remux = true;
      }
      plan.reasons.push({ code: "scene_content_changed", stage: "draft", sceneIndex, detail: operation.path });
    } else if (narrationMatch) {
      const sceneIndex = Number(narrationMatch[1]);
      const field = narrationMatch[2] ?? "";
      if (!field || ["text", "ttsText"].includes(field)) plan.audioSceneIndexes.push(sceneIndex);
      if (field === "durationSeconds" || field === "audioStartSeconds") plan.videoSceneIndexes.push(sceneIndex);
      plan.concatAudio = true;
      plan.remux = true;
      plan.reasons.push({ code: "narration_content_changed", stage: "draft", sceneIndex, detail: operation.path });
    } else if (operation.path === "/narration") {
      plan.audioSceneIndexes.push(...Array.from({ length: sceneCount }, (_, index) => index));
      plan.concatAudio = true;
      plan.remux = true;
      plan.reasons.push({ code: "narration_changed", stage: "draft", detail: operation.path });
    } else if (/^\/meta\/(width|height|fps)/.test(operation.path)) {
      plan.videoSceneIndexes.push(...Array.from({ length: sceneCount }, (_, index) => index));
      plan.concatVideo = true;
      plan.remux = true;
      plan.reasons.push({ code: "video_format_changed", stage: "draft", detail: operation.path });
    }
  }
  return mergeDirtyPlans(plan);
}
