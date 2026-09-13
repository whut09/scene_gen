import type { VideoProject } from "../../pipeline/types";
import { qualityJudgeIssueSchema, qualityJudgeResponseSchema } from "../../pipeline/schemas";
import { fetchWithRetry } from "../../pipeline/external-operation";
import type { RuntimeConfig } from "../../config/runtime-config";
import type { QualityIssueInput, QualityScoreStatus } from "../quality-protocol";
import { chatCompletionCompatibility } from "../../pipeline/utils";
import { z } from "zod";

export const expectedJudgeScoreKeys = ["sourceFidelity", "titleHook", "informationDensity", "visualStructure", "sceneAlignment", "ttsReadability"] as const;

export type QualityJudgeAttempt = {
  status: QualityScoreStatus;
  reason?: string;
  scores?: Record<string, number>;
  missingScoreKeys?: string[];
  issues?: QualityIssueInput[];
  revisionNotes?: string[];
};

const tolerantJudgeEnvelopeSchema = z.object({
  scores: z.unknown().optional(),
  issues: z.unknown().optional(),
  revisionNotes: z.unknown().optional(),
});

function parseJudgeEnvelope(content: string) {
  const jsonText = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  const raw = JSON.parse(jsonText) as unknown;
  const strict = qualityJudgeResponseSchema.safeParse(raw);
  if (strict.success) return { ...strict.data, malformedIssueCount: 0 };

  const envelope = tolerantJudgeEnvelopeSchema.safeParse(raw);
  if (!envelope.success) return { scores: undefined, issues: [], revisionNotes: [], malformedIssueCount: 0 };

  const scores = typeof envelope.data.scores === "object" && envelope.data.scores !== null && !Array.isArray(envelope.data.scores)
    ? Object.fromEntries(Object.entries(envelope.data.scores as Record<string, unknown>).flatMap(([key, value]) => typeof value === "number" && Number.isFinite(value) ? [[key, value]] : []))
    : undefined;
  const rawIssues = Array.isArray(envelope.data.issues) ? envelope.data.issues : [];
  const issues = rawIssues.flatMap((issue) => {
    const parsed = qualityJudgeIssueSchema.safeParse(issue);
    return parsed.success ? [parsed.data] : [];
  });
  const revisionNotes = Array.isArray(envelope.data.revisionNotes)
    ? envelope.data.revisionNotes.filter((note): note is string => typeof note === "string")
    : [];
  return { scores, issues, revisionNotes, malformedIssueCount: rawIssues.length - issues.length };
}

function compactJudgeText(value: string | undefined, maximumCharacters: number) {
  const normalized = (value ?? "").replace(/\s+/g, " ").trim();
  return normalized.length > maximumCharacters ? `${normalized.slice(0, maximumCharacters - 1)}…` : normalized;
}

function judgeProjectPayload(project: VideoProject, feedbackGuidance: string, compact: boolean) {
  return {
    sourceArticle: project.sources.map((source) => ({
      title: source.title,
      summary: compactJudgeText(source.summary, compact ? 1200 : 2400),
      content: compactJudgeText(source.content, compact ? 3000 : 7000),
    })),
    project: {
      title: project.meta.title,
      narration: compactJudgeText(project.narration, compact ? 4000 : 8000),
      scenes: project.scenes,
      narrationSegments: project.narrationSegments?.map((segment) => ({
        sceneIndex: segment.sceneIndex,
        text: segment.text,
        ttsText: segment.ttsText,
        providerSynthesisText: segment.providerSynthesisText,
      })),
    },
    recentUserFeedback: compactJudgeText(feedbackGuidance, compact ? 1800 : 4000),
  };
}

export async function callQualityJudge(project: VideoProject, feedbackGuidance: string, config: RuntimeConfig, signal?: AbortSignal): Promise<QualityJudgeAttempt> {
  if (!config.llm.quality.enabled) return { status: "not-required", reason: "Quality judge is disabled by runtime config." };
  const apiKey = config.llm.quality.apiKey;
  if (!apiKey) return { status: "unavailable", reason: "Quality judge API key is not configured." };
  const baseUrl = config.llm.quality.baseUrl;
  const model = config.llm.quality.model;
  if (!baseUrl || !model) return { status: "unavailable", reason: "Quality judge base URL or model is not configured." };
  const judgeModel = model;

  const endpoint = `${baseUrl.replace(/\/$/, "")}/chat/completions`;
  const systemContent = [
    "你是程序化新闻视频质量评审 agent。只返回 JSON。",
    "sourceArticle 是唯一事实依据，不得引入外部信息。",
    "分别对 sourceFidelity、titleHook、informationDensity、visualStructure、sceneAlignment、ttsReadability 打 0 到 100 分。",
    "返回字段：scores、issues、revisionNotes。revisionNotes 是字符串数组。",
    "issues 必须是稳定协议对象数组，每项包含 code、stage=draft、severity、可选 sceneIndex、evidence、repairAction、retryable。",
    "evidence 是对象，至少包含 summary；repairAction 只能是 none、regenerate-draft、revise-scenes、retry-stage、check-environment、resynthesize-audio、remux、rerender-scenes、switch-template、stop。",
    "只返回必要结果：issues 最多 4 项，evidence.summary 每项不超过 80 个字符，revisionNotes 最多 4 项；不要复制 sourceArticle、完整旁白或完整场景。",
    "标题应优先保留新闻原题核心卖点，免责声明或边界信息放副标题和正文。",
    "第一段旁白的第一句话必须逐字念完整新闻标题，标题是开场钩子，之后才能进入正文。",
    "逐屏检查旁白是否只复述或总结当前场景可见字段。当前屏没有展示的数据、案例、结论或背景不得出现在该段旁白。",
    `旁白必须与 ${project.scenes.length} 个场景逐段对应。首个核心价值应在 6 秒内出现，前半段覆盖主要事实，结尾提供边界或选择建议。`,
    "检查场景是否重复、是否缺少真实截图或结果证据、是否连续超过 8 秒只有抽象描述。不得出现发布建议、作者站点或无关动画说明。",
  ].join("\n");

  async function requestJudge(compact: boolean) {
    const response = await fetchWithRetry(endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: judgeModel,
        ...chatCompletionCompatibility(judgeModel),
        temperature: 0.1,
        max_tokens: compact ? 1400 : 2200,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: systemContent },
          { role: "user", content: JSON.stringify(judgeProjectPayload(project, feedbackGuidance, compact)) },
        ],
      }),
    }, { signal, label: "quality-judge", timeoutMs: config.llm.quality.timeoutMs, retries: 0 });
    if (!response.ok) throw new Error(`Quality judge failed: ${response.status} ${await response.text()}`);
    const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = data.choices?.[0]?.message?.content?.trim();
    if (!content) throw new Error("Quality judge returned no response content.");
    return parseJudgeEnvelope(content);
  }

  let parsed: ReturnType<typeof parseJudgeEnvelope>;
  try {
    parsed = await requestJudge(false);
  } catch (firstError) {
    if (signal?.aborted) throw firstError;
    try {
      parsed = await requestJudge(true);
    } catch (secondError) {
      throw new Error(`Quality judge failed: ${(secondError as Error).message}`);
    }
  }
  const scores = Object.fromEntries(Object.entries(parsed.scores ?? {})
    .filter(([, value]) => Number.isFinite(value))
    .map(([key, value]) => [key, Math.max(0, Math.min(100, value))]));
  const measuredKeys = expectedJudgeScoreKeys.filter((key) => scores[key] !== undefined);
  if (measuredKeys.length === 0) {
    return { status: "unavailable", reason: "Quality judge returned no recognized scores." };
  }
  const missingScoreKeys = expectedJudgeScoreKeys.filter((key) => scores[key] === undefined);
  return {
    status: missingScoreKeys.length > 0 ? "partially-measured" : "measured",
    scores,
    missingScoreKeys,
    issues: parsed.issues,
    revisionNotes: [
      ...(parsed.revisionNotes ?? []),
      ...(parsed.malformedIssueCount > 0 ? [`Quality judge returned ${parsed.malformedIssueCount} malformed issue(s); valid scores were retained and malformed issue(s) were ignored.`] : []),
    ],
  };
}
