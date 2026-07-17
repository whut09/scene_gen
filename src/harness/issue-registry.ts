import { z } from "zod";
import { issueEvidenceSchema, type IssueClass, type RepairAction } from "./protocol-primitives";

export { issueClassSchema, issueEvidenceSchema, issueSeveritySchema, qualityStageSchema } from "./protocol-primitives";
export type { IssueClass, IssueEvidence, IssueSeverity, QualityStage, RepairAction } from "./protocol-primitives";

interface IssueDefinition {
  issueClass: IssueClass;
  repairAction: RepairAction;
  retryable: boolean;
  evidenceSchema: z.ZodType<Record<string, string | number | boolean | string[]>>;
}

const genericEvidence = issueEvidenceSchema;
const pronunciationEvidence = issueEvidenceSchema.and(z.object({
  phrase: z.string().optional(),
  expected: z.string().optional(),
  expectedPinyin: z.string().optional(),
  actualPinyin: z.string().optional(),
  transcript: z.string().optional(),
  asrConfidence: z.number().optional(),
}).passthrough());

function define(issueClass: IssueClass, repairAction: RepairAction, retryable: boolean, evidenceSchema: z.ZodType<Record<string, string | number | boolean | string[]>> = genericEvidence): IssueDefinition {
  return { issueClass, repairAction, retryable, evidenceSchema };
}

export const issueRegistry = {
  scene_narration_mismatch: define("hard", "revise-scenes", true),
  scene_narration_overloaded: define("hard", "revise-scenes", true),
  scene_narration_thin: define("hard", "revise-scenes", true),
  scene_segment_mismatch: define("hard", "revise-scenes", true),
  scene_extra_numbers: define("hard", "revise-scenes", true),
  scene_source_number_unverified: define("hard", "revise-scenes", true),
  scene_fact_claims_missing: define("hard", "revise-scenes", true),
  scene_fact_qualifier_dropped: define("hard", "revise-scenes", true),
  scene_high_risk_predicate_unverified: define("hard", "revise-scenes", true),
  briefing_thin: define("hard", "revise-scenes", true),
  chart_thin: define("hard", "revise-scenes", true),
  flow_thin: define("hard", "revise-scenes", true),
  outro_thin: define("hard", "revise-scenes", true),
  qualitative_chart_fake_percentage: define("hard", "revise-scenes", true),
  parallel_flow_prompt_mismatch: define("hard", "revise-scenes", true),
  github_briefing_template_mismatch: define("hard", "revise-scenes", true),
  title_not_spoken_first: define("hard", "revise-scenes", true),
  news_date_not_spoken: define("hard", "revise-scenes", true),
  news_date_missing: define("hard", "regenerate-draft", true),
  title_not_chinese_summary: define("hard", "regenerate-draft", true),
  title_fact_claims_missing: define("hard", "regenerate-draft", true),
  narration_fact_claims_missing: define("hard", "regenerate-draft", true),
  source_fact_conflict: define("hard", "regenerate-draft", true),
  release_status_weakened: define("hard", "regenerate-draft", true),
  forbidden_content: define("hard", "regenerate-draft", true),
  narration_short: define("hard", "regenerate-draft", true),
  narration_long: define("hard", "regenerate-draft", true),
  audio_title_opening_missing: define("hard", "revise-scenes", true),
  audio_title_incomplete: define("hard", "revise-scenes", true),
  duration_out_of_range: define("hard", "revise-scenes", true),
  speech_too_fast: define("hard", "revise-scenes", true),
  speech_too_slow: define("hard", "revise-scenes", true),
  segment_speed_uneven: define("hard", "revise-scenes", true),
  segment_speed_variance: define("hard", "revise-scenes", true),
  tts_arabic_digits: define("hard", "revise-scenes", true),
  audio_missing: define("hard", "resynthesize-audio", true),
  segment_timing_missing: define("hard", "resynthesize-audio", true),
  audio_scene_drift: define("hard", "resynthesize-audio", true),
  audio_format_invalid: define("hard", "resynthesize-audio", true),
  audio_silence_excessive: define("hard", "resynthesize-audio", true),
  audio_clipping: define("hard", "resynthesize-audio", true),
  audio_pronunciation_mismatch: define("hard", "resynthesize-audio", true, pronunciationEvidence),
  audio_entity_mismatch: define("environment", "retry-stage", true),
  audio_number_mismatch: define("environment", "retry-stage", true),
  audio_semantic_mismatch: define("environment", "retry-stage", true),
  audio_segment_cross_talk: define("environment", "retry-stage", true),
  verification_inconclusive: define("environment", "retry-stage", true),
  asr_verification_failed: define("environment", "check-environment", false),
  judge_unavailable: define("environment", "check-environment", false),
  judge_partially_measured: define("soft", "none", false),
  judge_unstable: define("environment", "check-environment", false),
  llm_score_below_target: define("hard", "revise-scenes", true),
  stream_duration_drift: define("hard", "remux", true),
  video_project_duration_drift: define("hard", "remux", true),
  blank_frame: define("hard", "rerender-scenes", true),
  stream_missing: define("hard", "rerender-scenes", true),
  wrong_dimensions: define("hard", "rerender-scenes", true),
  scene_motion_too_static: define("soft", "switch-template", false),
  video_motion_too_static: define("soft", "switch-template", false),
  dom_element_out_of_bounds: define("hard", "switch-template", false),
  text_unsafe_zone: define("hard", "switch-template", false),
  text_contrast_low: define("hard", "switch-template", false),
  text_too_small: define("hard", "switch-template", false),
  text_line_too_long: define("hard", "switch-template", false),
  content_clipped: define("hard", "switch-template", false),
  element_overlap: define("hard", "switch-template", false),
  key_text_not_visible: define("hard", "switch-template", false),
  key_text_ocr_missing: define("hard", "switch-template", false),
  image_subject_crop_risk: define("soft", "switch-template", false),
  conclusion_hold_too_short: define("soft", "switch-template", false),
  sync_cue_visual_late: define("soft", "switch-template", false),
  frame_low_visual_complexity: define("soft", "switch-template", false),
  visual_audit_unavailable: define("environment", "check-environment", false),
  ocr_verification_unavailable: define("environment", "check-environment", false),
  template_adjacent_repeat: define("soft", "switch-template", false),
  template_diversity_low: define("soft", "switch-template", false),
  template_scene_mismatch: define("hard", "switch-template", false),
  sync_cues_sparse: define("soft", "switch-template", false),
  visual_source_low_diversity: define("soft", "switch-template", false),
  stage_timeout_or_cancelled: define("environment", "retry-stage", true),
  stage_execution_failed: define("hard", "retry-stage", true),
  unregistered_issue: define("hard", "stop", false),
} as const satisfies Record<string, IssueDefinition>;

const issueCodes = Object.keys(issueRegistry) as [keyof typeof issueRegistry, ...(keyof typeof issueRegistry)[]];
export const issueCodeSchema = z.enum(issueCodes);
export type IssueCode = z.infer<typeof issueCodeSchema>;

export function issueDefinition(code: IssueCode) {
  return issueRegistry[code];
}

export function normalizeIssueCode(code: string) {
  return issueCodeSchema.safeParse(code).success ? code as IssueCode : "unregistered_issue";
}
