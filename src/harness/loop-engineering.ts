import { createHash } from "node:crypto";
import type { VideoProject } from "../pipeline/types";
import type { QualityEvaluation, QualityIssue } from "./quality-protocol";

export interface JsonPatchOperation {
  op: "add" | "remove" | "replace";
  path: string;
  value?: unknown;
}

export interface LoopCost {
  durationMs: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface LoopAudit {
  iteration: number;
  stage: "draft" | "audio";
  beforeHash: string;
  afterHash: string;
  issueSignatureBefore: string;
  issueSignatureAfter?: string;
  scoreBefore: number;
  scoreAfter?: number;
  reasons: Array<{ code: string; sceneIndex?: number; repairAction: string }>;
  patch: JsonPatchOperation[];
  resolvedIssues: string[];
  newIssues: string[];
  cost: LoopCost;
  progress: "pending" | "improved" | "unchanged" | "regressed";
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, stableValue(child)]));
  }
  return value;
}

export function contentHash(value: unknown) {
  return createHash("sha256").update(JSON.stringify(stableValue(value))).digest("hex");
}

export function projectLoopHash(project: VideoProject) {
  return contentHash({ meta: project.meta, scenes: project.scenes, narration: project.narration, narrationSegments: project.narrationSegments });
}

export function issueKey(issue: Pick<QualityIssue, "code" | "sceneIndex">) {
  return `${issue.code}:${issue.sceneIndex ?? "global"}`;
}

export function issueSignature(issues: Array<Pick<QualityIssue, "code" | "sceneIndex" | "severity">>) {
  return [...new Set(issues.map((issue) => `${issue.severity}:${issueKey(issue)}`))].sort().join("|");
}

export function evaluationScore(evaluation: Pick<QualityEvaluation, "scores" | "metrics">) {
  if (typeof evaluation.metrics.scoreAverage === "number") return evaluation.metrics.scoreAverage;
  const values = Object.values(evaluation.scores ?? {});
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 100;
}

function escapePath(value: string) {
  return value.replace(/~/g, "~0").replace(/\//g, "~1");
}

export function createJsonPatch(before: unknown, after: unknown, basePath = ""): JsonPatchOperation[] {
  if (Object.is(before, after)) return [];
  if (Array.isArray(before) && Array.isArray(after)) {
    const operations: JsonPatchOperation[] = [];
    const common = Math.min(before.length, after.length);
    for (let index = 0; index < common; index += 1) operations.push(...createJsonPatch(before[index], after[index], `${basePath}/${index}`));
    for (let index = before.length - 1; index >= after.length; index -= 1) operations.push({ op: "remove", path: `${basePath}/${index}` });
    for (let index = common; index < after.length; index += 1) operations.push({ op: "add", path: `${basePath}/-`, value: after[index] });
    return operations;
  }
  if (before && after && typeof before === "object" && typeof after === "object") {
    const operations: JsonPatchOperation[] = [];
    const beforeRecord = before as Record<string, unknown>;
    const afterRecord = after as Record<string, unknown>;
    for (const key of Object.keys(beforeRecord).filter((key) => !(key in afterRecord)).sort()) operations.push({ op: "remove", path: `${basePath}/${escapePath(key)}` });
    for (const key of Object.keys(afterRecord).sort()) {
      const childPath = `${basePath}/${escapePath(key)}`;
      if (!(key in beforeRecord)) operations.push({ op: "add", path: childPath, value: afterRecord[key] });
      else operations.push(...createJsonPatch(beforeRecord[key], afterRecord[key], childPath));
    }
    return operations;
  }
  return [{ op: basePath ? "replace" : "add", path: basePath || "/", value: after }];
}

export function createLoopAudit(input: {
  iteration: number;
  stage: "draft" | "audio";
  before: VideoProject;
  after: VideoProject;
  evaluation: QualityEvaluation;
  durationMs: number;
  usage?: Partial<Omit<LoopCost, "durationMs">>;
}): LoopAudit {
  return {
    iteration: input.iteration,
    stage: input.stage,
    beforeHash: projectLoopHash(input.before),
    afterHash: projectLoopHash(input.after),
    issueSignatureBefore: issueSignature(input.evaluation.issues),
    scoreBefore: evaluationScore(input.evaluation),
    reasons: input.evaluation.issues.map((issue) => ({ code: issue.code, sceneIndex: issue.sceneIndex, repairAction: issue.repairAction })),
    patch: createJsonPatch({ scenes: input.before.scenes, narration: input.before.narration, narrationSegments: input.before.narrationSegments }, { scenes: input.after.scenes, narration: input.after.narration, narrationSegments: input.after.narrationSegments }),
    resolvedIssues: [],
    newIssues: [],
    cost: {
      durationMs: input.durationMs,
      promptTokens: input.usage?.promptTokens ?? 0,
      completionTokens: input.usage?.completionTokens ?? 0,
      totalTokens: input.usage?.totalTokens ?? 0,
    },
    progress: "pending",
  };
}

export function finalizeLoopAudit(audit: LoopAudit, evaluation: QualityEvaluation) {
  const before = new Set(audit.issueSignatureBefore.split("|").filter(Boolean));
  const after = new Set(issueSignature(evaluation.issues).split("|").filter(Boolean));
  const scoreAfter = evaluationScore(evaluation);
  const resolvedIssues = [...before].filter((item) => !after.has(item));
  const newIssues = [...after].filter((item) => !before.has(item));
  const unchanged = audit.afterHash === audit.beforeHash || (resolvedIssues.length === 0 && newIssues.length === 0 && Math.abs(scoreAfter - audit.scoreBefore) < 0.5);
  return {
    ...audit,
    issueSignatureAfter: [...after].sort().join("|"),
    scoreAfter,
    resolvedIssues,
    newIssues,
    progress: unchanged ? "unchanged" : newIssues.length > resolvedIssues.length || scoreAfter < audit.scoreBefore - 0.5 ? "regressed" : "improved",
  } satisfies LoopAudit;
}

export function hasRepeatedNoProgress(items: Array<{ projectHash?: string; evaluation: QualityEvaluation }>) {
  if (items.length < 2) return false;
  const [previous, current] = items.slice(-2);
  return Boolean(previous.projectHash && previous.projectHash === current.projectHash
    && issueSignature(previous.evaluation.issues) === issueSignature(current.evaluation.issues)
    && Math.abs(evaluationScore(previous.evaluation) - evaluationScore(current.evaluation)) < 0.5);
}
