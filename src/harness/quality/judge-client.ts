import type { VideoProject } from "../../pipeline/types";
import { qualityJudgeResponseSchema } from "../../pipeline/schemas";
import { fetchWithRetry } from "../../pipeline/external-operation";
import type { RuntimeConfig } from "../../config/runtime-config";
import type { QualityIssueInput, QualityScoreStatus } from "../quality-protocol";

export const expectedJudgeScoreKeys = ["sourceFidelity", "titleHook", "informationDensity", "visualStructure", "sceneAlignment", "ttsReadability"] as const;

export type QualityJudgeAttempt = {
  status: QualityScoreStatus;
  reason?: string;
  scores?: Record<string, number>;
  missingScoreKeys?: string[];
  issues?: QualityIssueInput[];
  revisionNotes?: string[];
};

export async function callQualityJudge(project: VideoProject, feedbackGuidance: string, config: RuntimeConfig, signal?: AbortSignal): Promise<QualityJudgeAttempt> {
  if (!config.llm.quality.enabled) return { status: "not-required", reason: "Quality judge is disabled by runtime config." };
  const apiKey = config.llm.quality.apiKey;
  if (!apiKey) return { status: "unavailable", reason: "Quality judge API key is not configured." };
  const baseUrl = config.llm.quality.baseUrl;
  const model = config.llm.quality.model;
  if (!baseUrl || !model) return { status: "unavailable", reason: "Quality judge base URL or model is not configured." };

  const response = await fetchWithRetry(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      temperature: 0.1,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: [
            "你是程序化新闻视频质量评审 agent。只返回 JSON。",
            "sourceArticle 是唯一事实依据，不得引入外部信息。",
            "分别对 sourceFidelity、titleHook、informationDensity、visualStructure、sceneAlignment、ttsReadability 打 0 到 100 分。",
            "返回字段：scores、issues、revisionNotes。revisionNotes 是字符串数组。",
            "issues 必须是稳定协议对象数组，每项包含 code、stage=draft、severity、可选 sceneIndex、evidence、repairAction、retryable。",
            "evidence 是对象，至少包含 summary；repairAction 只能是 none、regenerate-draft、revise-scenes、retry-stage、check-environment、resynthesize-audio、remux、rerender-scenes、switch-template、stop。",
            "标题应优先保留新闻原题核心卖点，免责声明或边界信息放副标题和正文。",
            "第一段旁白的第一句话必须逐字念完整新闻标题，标题是开场钩子，之后才能进入正文。",
            "逐屏检查旁白是否只复述或总结当前场景可见字段。当前屏没有展示的数据、案例、结论或背景不得出现在该段旁白。",
            "旁白必须与 5 个场景逐段对应，不得出现发布建议、作者站点或无关动画说明。",
          ].join("\n"),
        },
        {
          role: "user",
          content: JSON.stringify({
            sourceArticle: project.sources.map((source) => ({
              title: source.title,
              summary: source.summary,
              content: source.content,
            })),
            project: {
              title: project.meta.title,
              narration: project.narration,
              scenes: project.scenes,
              narrationSegments: project.narrationSegments,
            },
            recentUserFeedback: feedbackGuidance,
          }),
        },
      ],
    }),
  }, { signal, label: "quality-judge", timeoutMs: config.llm.quality.timeoutMs });
  if (!response.ok) throw new Error(`Quality judge failed: ${response.status} ${await response.text()}`);
  const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const content = data.choices?.[0]?.message?.content;
  if (!content) return { status: "unavailable", reason: "Quality judge returned no response content." };
  const parsed = qualityJudgeResponseSchema.parse(JSON.parse(content));
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
    revisionNotes: parsed.revisionNotes,
  };
}
