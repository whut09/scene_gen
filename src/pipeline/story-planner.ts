import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { fetchWithRetry } from "./external-operation";
import { highRiskPredicatesInText } from "./fact-ledger";
import { storyPlanResponseSchema } from "./schemas";
import type { FactLedger, StoryPlanCandidate, StoryPlanRanking, StoryPlanningAudit, VideoProject } from "./types";
import { fromRoot } from "./utils";
import { recordProviderOutcome } from "../production/provider-stats";

const expectedVisuals = ["title", "briefing", "chart", "flow", "outro"] as const;
const historySchema = z.object({ fingerprint: z.string().length(64), succeeded: z.boolean(), scoreDelta: z.number().default(0), createdAt: z.string() });
type HistoryEntry = z.infer<typeof historySchema>;

function clamp(value: number) { return Math.max(0, Math.min(100, Number(value.toFixed(2)))); }
function compact(value: string) { return value.replace(/\s+/g, "").replace(/[，。！？；：、,.!?;:'"“”‘’（）()【】\[\]<>《》]/g, "").toLowerCase(); }

export function resolveStoryPlanCandidateCount(profile = process.env.SCENE_GEN_PROFILE ?? "custom", explicit = process.env.STORY_PLAN_CANDIDATES) {
  if (explicit !== undefined) {
    const parsed = Number(explicit);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 4) throw new Error("STORY_PLAN_CANDIDATES must be an integer from 1 to 4.");
    return parsed;
  }
  if (profile === "fast-preview" || profile === "ci-offline") return 1;
  if (profile === "production") return 4;
  return 2;
}

export function storyPlanFingerprint(candidate: StoryPlanCandidate) {
  return createHash("sha256").update(JSON.stringify({ angle: compact(candidate.angle), visuals: candidate.scenes.map((scene) => scene.visual), focuses: candidate.scenes.map((scene) => compact(scene.focus)) })).digest("hex");
}

function historyScore(fingerprint: string, history: HistoryEntry[]) {
  const matching = history.filter((entry) => entry.fingerprint === fingerprint);
  const successes = matching.filter((entry) => entry.succeeded).length;
  const successRate = (successes + 1) / (matching.length + 2);
  const averageDelta = matching.length ? matching.reduce((sum, entry) => sum + entry.scoreDelta, 0) / matching.length : 0;
  return clamp(successRate * 80 + 20 + averageDelta * 0.5);
}

export function rankStoryPlanCandidates(candidates: StoryPlanCandidate[], ledger: FactLedger, targetSeconds: number, history: HistoryEntry[] = []) {
  const knownClaims = new Map(ledger.claims.map((claim) => [claim.id, claim]));
  return candidates.map((candidate): StoryPlanRanking => {
    const rejectedReasons: string[] = [];
    const allClaimIds = [...candidate.titleClaimIds, ...candidate.scenes.flatMap((scene) => scene.claimIds)];
    const unknownClaims = [...new Set(allClaimIds.filter((claimId) => !knownClaims.has(claimId)))];
    if (unknownClaims.length) rejectedReasons.push(`unknown-claims:${unknownClaims.join(",")}`);
    candidate.scenes.forEach((scene, index) => {
      if (scene.visual !== expectedVisuals[index]) rejectedReasons.push(`scene-${index}-visual-mismatch`);
      if (compact(scene.focus).length < 4 || compact(scene.focus).length > 60) rejectedReasons.push(`scene-${index}-unvisualizable-focus`);
      const evidence = scene.claimIds.map((claimId) => knownClaims.get(claimId)?.evidenceText ?? "").join(" ");
      const unsupportedPredicates = highRiskPredicatesInText(scene.focus).filter((predicate) => !evidence.includes(predicate));
      if (unsupportedPredicates.length) rejectedReasons.push(`scene-${index}-unsupported-predicates:${unsupportedPredicates.join(",")}`);
      const unsupportedNumbers = [...new Set(scene.focus.match(/\d+(?:\.\d+)?%?/g) ?? [])].filter((number) => !evidence.includes(number));
      if (unsupportedNumbers.length) rejectedReasons.push(`scene-${index}-unverified-numbers:${unsupportedNumbers.join(",")}`);
    });
    const focusSet = new Set(candidate.scenes.map((scene) => compact(scene.focus)));
    if (focusSet.size !== candidate.scenes.length) rejectedReasons.push("duplicate-scene-focus");
    if (candidate.estimatedSeconds < targetSeconds * 0.65 || candidate.estimatedSeconds > targetSeconds * 1.45) rejectedReasons.push("estimated-duration-out-of-range");
    const titleEvidence = candidate.titleClaimIds.map((id) => knownClaims.get(id)?.evidenceText ?? "").join(" ");
    const unsupportedTitlePredicates = highRiskPredicatesInText(candidate.title).filter((predicate) => !titleEvidence.includes(predicate));
    if (unsupportedTitlePredicates.length) rejectedReasons.push(`unsupported-title-predicates:${unsupportedTitlePredicates.join(",")}`);

    const usedClaims = new Set(allClaimIds.filter((claimId) => knownClaims.has(claimId)));
    const factCoverage = clamp((usedClaims.size / Math.max(1, Math.min(ledger.claims.length, 12))) * 100);
    const titleLength = compact(candidate.title).length;
    const titleHook = clamp(100 - Math.abs(22 - titleLength) * 4 + (highRiskPredicatesInText(candidate.title).length ? 6 : 0));
    const informationDiversity = clamp((focusSet.size / 5) * 100);
    const visualFeasibility = clamp(100 - candidate.scenes.reduce((sum, scene) => sum + Math.max(0, compact(scene.focus).length - 34), 0) * 2);
    const ttsReadability = clamp(100 - (candidate.title.match(/[A-Z0-9_.+-]{5,}/g)?.length ?? 0) * 12 - Math.max(0, titleLength - 30) * 4);
    const fingerprint = storyPlanFingerprint(candidate);
    const historicalEffect = historyScore(fingerprint, history);
    const total = clamp(factCoverage * 0.3 + titleHook * 0.2 + informationDiversity * 0.16 + visualFeasibility * 0.14 + ttsReadability * 0.1 + historicalEffect * 0.1 - rejectedReasons.length * 25);
    return { candidate, fingerprint, rejectedReasons, scores: { factCoverage, titleHook, informationDiversity, visualFeasibility, ttsReadability, historicalEffect, total } };
  }).sort((left, right) => Number(Boolean(left.rejectedReasons.length)) - Number(Boolean(right.rejectedReasons.length)) || right.scores.total - left.scores.total || left.candidate.id.localeCompare(right.candidate.id));
}

function historyPath() {
  return path.resolve(process.env.STORY_PLAN_HISTORY_FILE ?? fromRoot("data", "story-planning", "outcomes.jsonl"));
}

async function readHistory() {
  try {
    const raw = await readFile(historyPath(), "utf8");
    return raw.split(/\r?\n/).filter(Boolean).flatMap((line) => {
      const parsed = historySchema.safeParse(JSON.parse(line));
      return parsed.success ? [parsed.data] : [];
    }).slice(-500);
  } catch {
    return [];
  }
}

export async function planStoryCandidates(input: {
  project: VideoProject;
  apiKey: string;
  baseUrl: string;
  model: string;
  targetSeconds: number;
  editorialNotes?: string;
  signal?: AbortSignal;
}) {
  if (!input.project.factLedger) throw new Error("Story planning requires factLedger.");
  const profile = process.env.SCENE_GEN_PROFILE ?? "custom";
  const requestedCandidates = resolveStoryPlanCandidateCount(profile);
  const started = Date.now();
  const response = await fetchWithRetry(`${input.baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${input.apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: input.model,
      temperature: requestedCandidates === 1 ? 0.15 : 0.55,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: [
          "你是短视频故事规划器，只返回 JSON，不展开完整旁白。",
          `生成恰好 ${requestedCandidates} 个彼此明显不同的候选，返回 { candidates: [...] }。`,
          "每个候选包含 id、angle、title、titleClaimIds、estimatedSeconds 和 scenes。",
          "scenes 恰好五项，visual 顺序固定为 title、briefing、chart、flow、outro；每项包含 purpose、focus、claimIds。",
          "所有 claimIds 必须来自 factLedger。标题和 focus 不得加入账本外事实，不得省略来源限定词。",
          "候选之间必须改变叙事角度和各屏 focus，禁止仅改写措辞。不要输出 narration、metrics、bars、steps 或 bullets。",
        ].join("\n") },
        { role: "user", content: JSON.stringify({ currentTitle: input.project.meta.title, targetSeconds: input.targetSeconds, factLedger: input.project.factLedger, editorialNotes: input.editorialNotes ?? "" }) },
      ],
    }),
  }, { signal: input.signal, label: "story-planning", timeoutMs: Number(process.env.NEWS_LLM_TIMEOUT_MS ?? 120_000) });
  if (!response.ok) {
    await recordProviderOutcome({ providerId: "news-llm", capability: "llm", operation: "story-planning", success: false, latencyMs: Date.now() - started, timeout: false, retryCount: 0, cost: 0, unitKind: "requests", unitCount: 1, language: "zh-CN", domain: input.project.sources[0]?.domain ?? input.project.sources[0]?.tags?.[0] ?? "general", errorType: `http_${response.status}` }).catch(() => undefined);
    throw new Error(`Story planning failed: ${response.status} ${await response.text()}`);
  }
  try {
    const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }>; usage?: { total_tokens?: number } };
    const content = payload.choices?.[0]?.message?.content;
    if (!content) throw new Error("Story planning returned no content.");
    const candidates = storyPlanResponseSchema.parse(JSON.parse(content)).candidates;
    if (candidates.length !== requestedCandidates) throw new Error(`Story planning returned ${candidates.length}/${requestedCandidates} candidates.`);
    const rankings = rankStoryPlanCandidates(candidates, input.project.factLedger, input.targetSeconds, await readHistory());
    const selected = rankings.find((ranking) => ranking.rejectedReasons.length === 0);
    if (!selected) throw new Error(`Every story plan was deterministically rejected: ${rankings.map((ranking) => `${ranking.candidate.id}[${ranking.rejectedReasons.join(",")}]`).join("; ")}`);
    const tokens = payload.usage?.total_tokens ?? 0;
    const audit: StoryPlanningAudit = {
      profile, requestedCandidates, selectedCandidateId: selected.candidate.id, planningMs: Date.now() - started,
      planningTokens: tokens, expansionTokens: 0, rankings,
    };
    await recordProviderOutcome({ providerId: "news-llm", capability: "llm", operation: "story-planning", success: true, latencyMs: Date.now() - started, timeout: false, retryCount: 0, cost: tokens / 1000 * Number(process.env.NEWS_LLM_COST_PER_1K_TOKENS ?? 0), unitKind: "requests", unitCount: 1, qualityScore: selected.scores.total / 100, language: "zh-CN", domain: input.project.sources[0]?.domain ?? input.project.sources[0]?.tags?.[0] ?? "general" }).catch(() => undefined);
    return { selected: selected.candidate, audit };
  } catch (error) {
    await recordProviderOutcome({ providerId: "news-llm", capability: "llm", operation: "story-planning", success: false, latencyMs: Date.now() - started, timeout: /timeout/i.test((error as Error).message), retryCount: 0, cost: 0, unitKind: "requests", unitCount: 1, language: "zh-CN", domain: input.project.sources[0]?.domain ?? input.project.sources[0]?.tags?.[0] ?? "general", errorType: "invalid_response" }).catch(() => undefined);
    throw error;
  }
}

export async function recordStoryPlanOutcome(project: VideoProject, succeeded: boolean, scoreDelta = 0) {
  const selected = project.storyPlanning?.rankings.find((ranking) => ranking.candidate.id === project.storyPlanning?.selectedCandidateId);
  if (!selected) return;
  const filePath = historyPath();
  await mkdir(path.dirname(filePath), { recursive: true });
  await appendFile(filePath, `${JSON.stringify(historySchema.parse({ fingerprint: selected.fingerprint, succeeded, scoreDelta, createdAt: new Date().toISOString() }))}\n`, "utf8");
}
