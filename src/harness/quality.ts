import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { buildHtmlVideoContentGraph } from "../html-video/content-graph";
import type { VideoProject, VideoScene } from "../pipeline/types";
import { prepareF5SynthesisText } from "../pipeline/tts";
import { fromRoot } from "../pipeline/utils";
import { getTemplateById } from "../templates/template-registry";
import { buildProductionDecisions } from "../production/visual-planner";
import { qualityJudgeResponseSchema } from "../pipeline/schemas";
import { isNewsProject, projectNewsDate } from "../pipeline/news-date";
import { fetchWithRetry, runExternalProcess } from "../pipeline/external-operation";
import { finalizeQualityEvaluation, type QualityEvaluation, type QualityIssueInput } from "./quality-protocol";
import { canonicalSpeechText } from "./speech-normalization";

export type { QualityEvaluation, QualityIssue, QualityStage } from "./quality-protocol";

const ASR_TRADITIONAL_TO_SIMPLIFIED: Record<string, string> = {
  獎: "奖", 攝: "摄", 銷: "销", 認: "认", 賽: "赛", 獲: "获", 與: "与", 為: "为",
  園: "园", 責: "责", 處: "处", 關: "关", 後: "后", 這: "这", 確: "确", 實: "实",
};
function normalizeText(text: string) {
  return [...text]
    .map((char) => ASR_TRADITIONAL_TO_SIMPLIFIED[char] ?? char)
    .join("")
    .replace(/\s+/g, "")
    .replace(/[：:，,。.!！?？_\-]/g, "")
    .toLowerCase();
}

function sceneVisibleText(scene: VideoScene) {
  switch (scene.type) {
    case "title":
      return [scene.kicker, scene.headline, scene.subhead, ...scene.sources].join(" ");
    case "briefing_points":
      return [scene.headline, scene.title, scene.summary, ...scene.metrics.flatMap((item) => [item.label, item.value]), ...scene.points].join(" ");
    case "signal_chart":
      return [scene.headline, ...scene.bars.flatMap((item) => [item.label, item.detail])].join(" ");
    case "flow":
      return [scene.headline, ...scene.steps.flatMap((item) => [item.label, item.detail])].join(" ");
    case "outro":
      return [scene.headline, ...scene.bullets].join(" ");
  }
  return "";
}

function narrationLimits(scene: VideoScene) {
  if (scene.type === "title") return { min: 55, max: 150 };
  if (scene.type === "briefing_points") return { min: 90, max: 220 };
  if (scene.type === "outro") return { min: 65, max: 170 };
  return { min: 85, max: 210 };
}

function visibleTokenCoverage(visibleText: string, narration: string) {
  const visible = normalizeText(visibleText);
  const spoken = normalizeText(narration);
  const tokens = new Set<string>();
  for (const match of visible.matchAll(/[a-z][a-z0-9.-]+|\d+(?:\.\d+)?%?|[\u4e00-\u9fff]{2,}/gi)) {
    const token = match[0].toLowerCase();
    if (/^[\u4e00-\u9fff]+$/.test(token) && token.length > 3) {
      for (let index = 0; index < token.length - 1; index += 2) tokens.add(token.slice(index, index + 2));
    } else {
      tokens.add(token);
    }
  }
  if (tokens.size === 0) return 1;
  const matched = [...tokens].filter((token) => spoken.includes(token)).length;
  return matched / tokens.size;
}

function extraNarrationNumbers(visibleText: string, narration: string) {
  const visibleNumbers = new Set(visibleText.match(/\d+(?:\.\d+)?%?/g) ?? []);
  return [...new Set(narration.match(/\d+(?:\.\d+)?%?/g) ?? [])].filter((value) => !visibleNumbers.has(value));
}
function sceneShapeIssues(scene: VideoScene, index: number) {
  const issues: QualityIssueInput[] = [];
  if (scene.type === "briefing_points" && (scene.points.length < 3 || scene.metrics.length < 2)) {
    issues.push({ severity: "error", code: "briefing_thin", message: `第 ${index + 1} 屏事实卡信息不足。`, sceneIndex: index });
  }
  if (scene.type === "signal_chart" && scene.bars.length < 3) {
    issues.push({ severity: "error", code: "chart_thin", message: `第 ${index + 1} 屏图表少于 3 个信号。`, sceneIndex: index });
  }
  if (scene.type === "flow" && scene.steps.length < 3) {
    issues.push({ severity: "error", code: "flow_thin", message: `第 ${index + 1} 屏流程少于 3 步。`, sceneIndex: index });
  }
  if (scene.type === "outro" && scene.bullets.length < 2) {
    issues.push({ severity: "error", code: "outro_thin", message: `第 ${index + 1} 屏结论少于 2 条。`, sceneIndex: index });
  }
  return issues;
}

async function callQualityJudge(project: VideoProject, feedbackGuidance: string, signal?: AbortSignal) {
  if (process.env.QUALITY_LLM_DISABLED === "1") return null;
  const apiKey =
    process.env.QUALITY_LLM_API_KEY ?? process.env.NEWS_LLM_API_KEY ?? process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  const baseUrl =
    process.env.QUALITY_LLM_BASE_URL ?? process.env.NEWS_LLM_BASE_URL ?? process.env.OPENAI_BASE_URL;
  const model = process.env.QUALITY_LLM_MODEL ?? process.env.NEWS_LLM_MODEL ?? process.env.OPENAI_MODEL;
  if (!baseUrl || !model) return null;

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
  }, { signal, label: "quality-judge", timeoutMs: Number(process.env.QUALITY_LLM_TIMEOUT_MS ?? 90_000) });
  if (!response.ok) throw new Error(`Quality judge failed: ${response.status} ${await response.text()}`);
  const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const content = data.choices?.[0]?.message?.content;
  if (!content) return null;
  return qualityJudgeResponseSchema.parse(JSON.parse(content));
}

export async function evaluateDraft(
  project: VideoProject,
  targetSeconds: number,
  feedbackGuidance: string,
  signal?: AbortSignal,
): Promise<QualityEvaluation> {
  const issues: QualityIssueInput[] = [];
  const revisionNotes: string[] = [];
  const source = project.sources[0];
  const narrationChars = project.narration.replace(/\s+/g, "").length;
  const naturalDuration = (process.env.TTS_DURATION_POLICY ?? "natural").trim().toLowerCase() === "natural";
  const minimumChars = Math.round(targetSeconds * (naturalDuration ? 4.8 : 6));
  const maximumChars = Math.round(targetSeconds * 11);
  const templateGraph = buildHtmlVideoContentGraph(project);
  const productionDecisions = buildProductionDecisions(project);
  const visualSourceCount = new Set(productionDecisions.map((decision) => decision.visualPlan.source)).size;
  if (project.scenes.length >= 5 && visualSourceCount < 2) {
    issues.push({ severity: "warning", code: "visual_source_low_diversity", message: "整条视频只使用一种视觉来源，建议为适合的场景增加真实 UI、网页证据或视频素材。" });
  }
  for (const decision of productionDecisions) {
    if (decision.syncCues.length < 2) issues.push({ severity: "warning", code: "sync_cues_sparse", message: `第 ${decision.sceneIndex + 1} 屏可同步强调的旁白关键词不足。`, sceneIndex: decision.sceneIndex });
  }
  const templateIds = templateGraph.nodes.map((node) => node.templateId);
  const compositionIds = templateGraph.nodes.map((node) => node.templateId + ":" + node.variantId);
  const uniqueTemplateCount = new Set(templateIds).size;
  const adjacentTemplateRepeats = templateIds.filter((id, index) => index > 0 && id === templateIds[index - 1]).length;
  const templateCategoryCount = new Set(templateIds.map((id) => getTemplateById(id)?.category).filter(Boolean)).size;
  const averageTemplateScore = templateGraph.nodes.length
    ? templateGraph.nodes.reduce((sum, node) => sum + node.templateScore, 0) / templateGraph.nodes.length
    : 0;

  if (project.scenes.length >= 5 && uniqueTemplateCount < 3) {
    issues.push({ severity: "error", code: "template_diversity_low", message: `五屏视频只使用了 ${uniqueTemplateCount} 种模板，至少需要 3 种构图。` });
  }
  if (adjacentTemplateRepeats > 0) {
    issues.push({ severity: "error", code: "template_adjacent_repeat", message: `存在 ${adjacentTemplateRepeats} 处相邻场景重复模板。` });
  }
  for (const node of templateGraph.nodes) {
    const selectedScene = project.scenes[node.sceneIndex];
    if (node.sourceEvidence.unmatchedNumbers.length > 0) {
      issues.push({ severity: "error", code: "scene_source_number_unverified", message: `第 ${node.sceneIndex + 1} 屏出现来源正文无法核验的数字：${node.sourceEvidence.unmatchedNumbers.join("、")}。`, sceneIndex: node.sceneIndex });
    }
    if (selectedScene?.type === "signal_chart" && Array.isArray(selectedScene.bars) && selectedScene.bars.length > 1 && selectedScene.bars.every((bar) => bar.value === selectedScene.bars[0].value) && node.variantId !== "category-cards") {
      issues.push({ severity: "error", code: "qualitative_chart_fake_percentage", message: `第 ${node.sceneIndex + 1} 屏是定性能力分类，不得使用显示百分比的 ${node.variantId} 模板。`, sceneIndex: node.sceneIndex });
    }
    if (selectedScene?.type === "flow" && /并列|分流/.test(selectedScene.headline) && node.variantId === "agent-lanes") {
      issues.push({ severity: "error", code: "parallel_flow_prompt_mismatch", message: `第 ${node.sceneIndex + 1} 屏是并列分流，不得使用带 PROMPT 中心节点的 Agent 流程模板。`, sceneIndex: node.sceneIndex });
    }
    if (selectedScene?.type === "briefing_points" && selectedScene.metrics.length > 0 && selectedScene.points.length > 0 && node.templateId === "investment-research") {
      issues.push({ severity: "error", code: "github_briefing_template_mismatch", message: `第 ${node.sceneIndex + 1} 屏必须分开展示指标和功能要点，不能把指标标签与要点错误配对。`, sceneIndex: node.sceneIndex });
    }
    const template = getTemplateById(node.templateId);
    if (!template?.supportedScenes.includes(node.sceneType)) {
      issues.push({ severity: "error", code: "template_scene_mismatch", message: `模板 ${node.templateId} 不支持 ${node.sceneType} 场景。`, sceneIndex: node.sceneIndex });
    }
  }

  if (project.scenes.length !== 5 || project.narrationSegments?.length !== project.scenes.length) {
    issues.push({ severity: "error", code: "scene_segment_mismatch", message: "必须是 5 个场景和 5 段对应旁白。" });
  }
  if (narrationChars < minimumChars) {
    issues.push({ severity: "error", code: "narration_short", message: `旁白仅 ${narrationChars} 字，目标至少 ${minimumChars} 字。` });
    revisionNotes.push(`将总旁白扩充到 ${minimumChars} 到 ${maximumChars} 字。`);
  }
  if (narrationChars > maximumChars) {
    issues.push({ severity: "warning", code: "narration_long", message: `旁白 ${narrationChars} 字，可能超过目标时长。` });
    revisionNotes.push(`将总旁白压缩到 ${maximumChars} 字以内。`);
  }
  const firstNarration = project.narrationSegments?.[0]?.text ?? "";
  if (!normalizeText(firstNarration).startsWith(normalizeText(project.meta.title))) {
    issues.push({ severity: "error", code: "title_not_spoken_first", message: "第一段旁白没有先完整播报新闻标题。", sceneIndex: 0 });
    revisionNotes.push("将新闻标题逐字放在第一段旁白的第一句话，念完标题后再进入正文。 ");
  }
  const publicationDate = projectNewsDate(project);
  if (isNewsProject(project) && !publicationDate) {
    issues.push({ severity: "error", code: "news_date_missing", message: "新闻项目缺少可展示的发布日期。" });
    revisionNotes.push("为新闻来源补充 publishedAt，并在首页显著展示新闻日期。 ");
  } else if (publicationDate && !normalizeText(firstNarration).includes(normalizeText(publicationDate))) {
    issues.push({ severity: "error", code: "news_date_not_spoken", message: "第一段旁白没有播报首页展示的新闻日期。", sceneIndex: 0 });
    revisionNotes.push("标题播报完成后，紧接着播报新闻日期。 ");
  }
  const titleChineseCount = (project.meta.title.match(/[\u4e00-\u9fff]/g) ?? []).length;
  if (titleChineseCount < 6) {
    issues.push({ severity: "error", code: "title_not_chinese_summary", message: "视频主标题没有形成清晰的中文总结。" });
    revisionNotes.push("将主标题改写为14到30个汉字的中文事实总结，英文仅保留必要专有名。 ");
  }
  const sourceText = `${source?.title ?? ""} ${source?.summary ?? ""} ${source?.content ?? ""}`;
  if (/正式发布|正式推出|即日起.{0,80}开放/.test(sourceText) && !/正式发布|正式推出|即日起.{0,80}开放/.test(project.narration)) {
    issues.push({ severity: "error", code: "release_status_weakened", message: "原文的正式发布或开放状态被弱化。" });
    revisionNotes.push("首段直接复述原文的正式发布状态、开放渠道和用户范围。 ");
  }
  const forbidden = /太乙真人|万人敬仰|新闻怎么跟进|发布角度|适合做视频|作者\s*[：:]|编辑\s*[：:]|量子位|腾讯新闻|新浪财经|36氪|钛媒体/;
  if (forbidden.test(project.narration)) {
    issues.push({ severity: "error", code: "forbidden_content", message: "旁白包含参考音频污染、站点署名或无关制作建议。" });
  }
  const alignmentScores: number[] = [];
  project.scenes.forEach((scene, index) => {
    issues.push(...sceneShapeIssues(scene, index));
    const segment = project.narrationSegments?.[index];
    if (!segment) return;
    const narrationLength = segment.text.replace(/\s+/g, "").length;
    const limits = narrationLimits(scene);
    if (narrationLength > limits.max) {
      issues.push({ severity: "error", code: "scene_narration_overloaded", message: `第 ${index + 1} 屏旁白 ${narrationLength} 字，超过当前画面建议上限 ${limits.max} 字。`, sceneIndex: index });
      revisionNotes.push(`压缩第 ${index + 1} 屏旁白，只复述该屏可见字段，不要扩展屏幕外内容。`);
    } else if (narrationLength < limits.min) {
      issues.push({ severity: "warning", code: "scene_narration_thin", message: `第 ${index + 1} 屏旁白仅 ${narrationLength} 字。`, sceneIndex: index });
    }
    const visibleText = `${project.meta.title} ${sceneVisibleText(scene)} ${index === 0 ? projectNewsDate(project) : ""}`;
    const coverage = visibleTokenCoverage(visibleText, segment.text);
    alignmentScores.push(coverage);
    if (coverage < 0.25) {
      issues.push({ severity: "error", code: "scene_narration_mismatch", message: `第 ${index + 1} 屏旁白与画面字段重合度过低。`, sceneIndex: index });
      revisionNotes.push(`重写第 ${index + 1} 屏旁白，按画面上的标题、卡片、数据或步骤逐项讲解。`);
    }
    const extraNumbers = extraNarrationNumbers(visibleText, segment.text);
    if (extraNumbers.length > 0) {
      issues.push({ severity: "error", code: "scene_extra_numbers", message: `第 ${index + 1} 屏旁白出现画面未展示的数字：${extraNumbers.join("、")}。`, sceneIndex: index });
      revisionNotes.push(`将第 ${index + 1} 屏旁白中的数字同步到画面，或从旁白删除。`);
    }
  });

  let scores: Record<string, number> | undefined;
  try {
    const judged = await callQualityJudge(project, feedbackGuidance, signal);
    if (judged?.scores) {
      scores = Object.fromEntries(
        Object.entries(judged.scores).map(([key, value]) => [key, Math.max(0, Math.min(100, Number(value) || 0))]),
      );
      issues.push(...(judged.issues ?? []));
      revisionNotes.push(...(judged.revisionNotes ?? []));
    }
  } catch (error) {
    issues.push({ severity: "warning", code: "judge_unavailable", message: (error as Error).message });
  }

  const scoreValues = scores ? Object.values(scores) : [];
  const scoreAverage = scoreValues.length
    ? scoreValues.reduce((sum, value) => sum + value, 0) / scoreValues.length
    : 100;
  const scoreMinimum = scoreValues.length ? Math.min(...scoreValues) : 100;
  const passed = !issues.some((issue) => issue.severity === "error");
  if (scores && (scoreAverage < 78 || scoreMinimum < 70)) {
    issues.push({
      severity: "warning",
      code: "llm_score_below_target",
      message: `LLM 质量评分未达建议值（平均 ${scoreAverage.toFixed(1)}，最低 ${scoreMinimum}），已保留改进建议。`,
    });
  }

  return finalizeQualityEvaluation({
    stage: "draft",
    issues,
    revisionNotes: [...new Set(revisionNotes.filter(Boolean))],
    scores,
    metrics: {
      narrationChars,
      targetSeconds,
      scoreAverage: Number(scoreAverage.toFixed(1)),
      scoreMinimum,
      sceneCount: project.scenes.length,
      sceneAlignmentAverage: alignmentScores.length
        ? Number((alignmentScores.reduce((sum, value) => sum + value, 0) / alignmentScores.length).toFixed(3))
        : 0,
      sceneAlignmentMinimum: alignmentScores.length
        ? Number(Math.min(...alignmentScores).toFixed(3))
        : 0,
      feedbackItemsApplied: feedbackGuidance ? feedbackGuidance.split("\n").length : 0,
      uniqueTemplateCount,
      templateCategoryCount,
      adjacentTemplateRepeats,
      averageTemplateScore: Number(averageTemplateScore.toFixed(2)),
      templatePlan: compositionIds.join(" -> "),
    },
  });
}

function bigramRecall(expected: string, actual: string) {
  if (expected.length < 2) return actual.includes(expected) ? 1 : 0;
  const bigrams = Array.from({ length: expected.length - 1 }, (_, index) => expected.slice(index, index + 2));
  return bigrams.filter((token) => actual.includes(token)).length / bigrams.length;
}

async function transcribeOpening(project: VideoProject, signal?: AbortSignal) {
  if (process.env.ASR_DISABLED === "1" || !project.audio?.src) return null;
  const audioPath = project.audio.src.startsWith("/generated/")
    ? fromRoot("public", ...project.audio.src.replace(/^\/+/, "").split("/"))
    : path.resolve(project.audio.src);
  const openingSeconds = Math.min(30, (project.narrationSegments?.[0]?.durationSeconds ?? 24) + 0.5);
  const workDir = await mkdtemp(path.join(tmpdir(), "scene-gen-asr-"));
  const openingPath = path.join(workDir, "opening.wav");
  const python = process.env.ASR_PYTHON ?? path.join(
    process.env.F5_TTS_VENV ?? "F:\\codex\\.venvs\\scene_gen_f5_py39",
    "Scripts",
    "python.exe",
  );
  try {
    await runCapture("ffmpeg", ["-y", "-i", audioPath, "-t", openingSeconds.toFixed(3), "-ar", "16000", "-ac", "1", openingPath], signal);
    const result = await runCapture(python, [
      fromRoot("scripts", "transcribe-audio.py"),
      "--audio", openingPath,
      "--model", process.env.ASR_MODEL ?? "openai/whisper-tiny",
      "--language", process.env.ASR_LANGUAGE ?? "chinese",
    ], signal);
    const lines = result.stdout.trim().split(/\r?\n/).filter(Boolean);
    const parsed = JSON.parse(lines[lines.length - 1] ?? "{}") as { text?: string };
    return parsed.text?.trim() ?? "";
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}
export async function evaluateAudio(project: VideoProject, targetSeconds: number, signal?: AbortSignal): Promise<QualityEvaluation> {
  const issues: QualityIssueInput[] = [];
  const segments = project.narrationSegments ?? [];
  const duration = project.audio?.durationSeconds ?? 0;
  const minimumDuration = targetSeconds * Number(process.env.QUALITY_MIN_DURATION_FACTOR ?? 0.7);
  const maximumDuration = targetSeconds * Number(process.env.QUALITY_MAX_DURATION_FACTOR ?? 1.65);
  const narrationChars = project.narration.replace(/\s+/g, "").length;
  const charsPerSecond = duration > 0 ? narrationChars / duration : 0;
  const minimumCharsPerSecond = Number(process.env.QUALITY_MIN_CHARS_PER_SECOND ?? 6.3);
  const maximumCharsPerSecond = Number(process.env.QUALITY_MAX_CHARS_PER_SECOND ?? 11.5);
  const segmentRates = segments
    .map((segment) => {
      const segmentDuration = segment.durationSeconds ?? 0;
      const chars = segment.text.replace(/\s+/g, "").length;
      return segmentDuration > 0 ? chars / segmentDuration : 0;
    })
    .filter((value) => value > 0);
  const sortedRates = [...segmentRates].sort((left, right) => left - right);
  const medianSegmentRate = sortedRates.length
    ? sortedRates.length % 2
      ? sortedRates[Math.floor(sortedRates.length / 2)]
      : (sortedRates[sortedRates.length / 2 - 1] + sortedRates[sortedRates.length / 2]) / 2
    : 0;
  const minimumSegmentRate = sortedRates[0] ?? 0;
  const maximumSegmentRate = sortedRates[sortedRates.length - 1] ?? 0;
  const segmentSpeedRatio = minimumSegmentRate > 0 ? maximumSegmentRate / minimumSegmentRate : 0;
  const meanSegmentRate = segmentRates.length ? segmentRates.reduce((sum, value) => sum + value, 0) / segmentRates.length : 0;
  const segmentSpeedCv = meanSegmentRate > 0
    ? Math.sqrt(segmentRates.reduce((sum, value) => sum + (value - meanSegmentRate) ** 2, 0) / segmentRates.length) / meanSegmentRate
    : 0;
  const firstToMedianSpeed = medianSegmentRate > 0 && segmentRates.length ? segmentRates[0] / medianSegmentRate : 0;
  const maximumSegmentSpeedRatio = Number(process.env.QUALITY_MAX_SEGMENT_SPEED_RATIO ?? 1.35);
  const maximumSegmentSpeedCv = Number(process.env.QUALITY_MAX_SEGMENT_SPEED_CV ?? 0.16);
  const ttsNumericResidue = segments.reduce((count, segment) => {
    const prepared = prepareF5SynthesisText(segment.text);
    return count + (prepared.match(/\d/g)?.length ?? 0);
  }, 0);
  if (ttsNumericResidue > 0) {
    issues.push({ severity: "error", code: "tts_arabic_digits", message: `TTS 合成文本仍包含 ${ttsNumericResidue} 个阿拉伯数字，数字必须转换为中文播报。` });
  }
  if (!project.audio || project.audio.provider === "silent") {
    issues.push({ severity: "error", code: "audio_missing", message: "没有生成有效旁白音频。" });
  }
  if (duration < minimumDuration || duration > maximumDuration) {
    issues.push({ severity: "error", code: "duration_out_of_range", message: `音频 ${duration.toFixed(1)} 秒，建议范围 ${minimumDuration.toFixed(0)} 到 ${maximumDuration.toFixed(0)} 秒。` });
  }
  if (charsPerSecond > maximumCharsPerSecond) {
    issues.push({ severity: "error", code: "speech_too_fast", message: `旁白密度 ${charsPerSecond.toFixed(1)} 字/秒，超过自然播报上限 ${maximumCharsPerSecond} 字/秒。` });
  }
  if (charsPerSecond > 0 && charsPerSecond < minimumCharsPerSecond) {
    issues.push({ severity: "error", code: "speech_too_slow", message: `旁白密度 ${charsPerSecond.toFixed(1)} 字/秒，低于资讯播报下限 ${minimumCharsPerSecond} 字/秒。` });
  }
  if (segmentRates.length >= 2 && segmentSpeedRatio > maximumSegmentSpeedRatio) {
    issues.push({ severity: "error", code: "segment_speed_uneven", message: `逐屏语速最大相差 ${segmentSpeedRatio.toFixed(2)} 倍，超过 ${maximumSegmentSpeedRatio.toFixed(2)} 倍。` });
  }
  if (segmentRates.length >= 3 && segmentSpeedCv > maximumSegmentSpeedCv) {
    issues.push({ severity: "error", code: "segment_speed_variance", message: `逐屏语速离散度 ${(segmentSpeedCv * 100).toFixed(1)}%，超过 ${(maximumSegmentSpeedCv * 100).toFixed(0)}%。` });
  }
  let titleTranscript = "";
  let titleAudioCoverage = 0;
  try {
    const transcript = await transcribeOpening(project, signal);
    if (transcript !== null) {
      titleTranscript = transcript;
      const expectedTitle = canonicalSpeechText(project.meta.title);
      const actualTitle = canonicalSpeechText(transcript);
      const hookSource = project.meta.title.split(/[：:]/)[0] ?? project.meta.title;
      const expectedHook = canonicalSpeechText(hookSource).slice(0, 24);
      titleAudioCoverage = bigramRecall(expectedTitle, actualTitle);
      if (!actualTitle.startsWith(expectedHook)) {
        issues.push({ severity: "error", code: "audio_title_opening_missing", message: `实际语音没有从标题开头播报。ASR：${transcript}`, sceneIndex: 0 });
      }
      const minimumCoverage = Number(process.env.ASR_TITLE_COVERAGE_MIN ?? 0.58);
      if (titleAudioCoverage < minimumCoverage) {
        issues.push({ severity: "error", code: "audio_title_incomplete", message: `标题语音覆盖率 ${(titleAudioCoverage * 100).toFixed(1)}%，低于 ${(minimumCoverage * 100).toFixed(0)}%。`, sceneIndex: 0 });
      }
    }
  } catch (error) {
    issues.push({ severity: "error", code: "asr_verification_failed", message: `无法验证实际语音标题：${(error as Error).message}` });
  }
  let cursor = 0;
  for (const [index, scene] of project.scenes.entries()) {
    const segment = segments[index];
    if (!segment || segment.audioStartSeconds === undefined || segment.durationSeconds === undefined) {
      issues.push({ severity: "error", code: "segment_timing_missing", message: `第 ${index + 1} 屏缺少音频时间信息。`, sceneIndex: index });
      continue;
    }
    const frameTolerance = 1 / project.meta.fps + 0.002;
    if (Math.abs(cursor - segment.audioStartSeconds) > frameTolerance || Math.abs(scene.duration - segment.durationSeconds) > frameTolerance) {
      issues.push({ severity: "error", code: "audio_scene_drift", message: `第 ${index + 1} 屏音画边界不一致。`, sceneIndex: index });
    }
    cursor += scene.duration;
  }
  return finalizeQualityEvaluation({
    stage: "audio",
    issues,
    revisionNotes: issues.some((issue) => issue.code === "duration_out_of_range")
      ? [duration < minimumDuration ? "允许视频自然缩短，不要用无关内容填充；必要时补充当前画面已展示的信息。" : "压缩旁白字数或允许视频自然延长，不要继续加快语速。"]
      : [],
    metrics: {
      targetSeconds,
      audioDuration: duration,
      sceneDuration: cursor,
      alignmentDelta: Math.abs(cursor - duration),
      charsPerSecond: Number(charsPerSecond.toFixed(2)),
      segmentCharsPerSecond: segmentRates.map((value) => Number(value.toFixed(2))).join(", "),
      segmentSpeedRatio: Number(segmentSpeedRatio.toFixed(3)),
      segmentSpeedCv: Number(segmentSpeedCv.toFixed(3)),
      firstToMedianSpeed: Number(firstToMedianSpeed.toFixed(3)),
      maximumSegmentSpeedRatio,
      maximumSegmentSpeedCv,
      ttsNumericResidue,
      minimumDuration,
      maximumDuration,
      titleTranscript,
      titleAudioCoverage: Number(titleAudioCoverage.toFixed(3)),
    },
  });
}

function runCapture(command: string, args: string[], signal?: AbortSignal) {
  return runExternalProcess(command, args, {
    signal,
    retries: 1,
    retryOnExit: true,
    timeoutMs: Number(process.env.QUALITY_PROCESS_TIMEOUT_MS ?? 300_000),
  });
}


async function sampleMotionMetrics(videoPath: string, sceneDurations: number[] = [], signal?: AbortSignal) {
  const capture = await runCapture("ffmpeg", [
    "-v", "error", "-i", videoPath, "-map", "0:v:0", "-an",
    "-vf", "fps=2,scale=64:64,select='gte(scene,0)',metadata=print:file=-", "-f", "null", "-",
  ], signal);
  const scores = [...capture.stdout.matchAll(/lavfi\.scene_score=([0-9.]+)/g)].map((match) => Number(match[1]));
  const threshold = Number(process.env.MOTION_SCENE_THRESHOLD ?? 0.0005);
  function summarize(values: number[]) {
    if (values.length < 2) return { activeMotionRatio: 1, meanSceneChange: 0, longestStaticRun: 0 };
    let currentStatic = 0;
    let longestStatic = 0;
    let active = 0;
    for (const score of values.slice(1)) {
      if (score >= threshold) { active += 1; currentStatic = 0; }
      else { currentStatic += 1; longestStatic = Math.max(longestStatic, currentStatic); }
    }
    return {
      activeMotionRatio: Number((active / Math.max(1, values.length - 1)).toFixed(3)),
      meanSceneChange: Number((values.reduce((sum, score) => sum + score, 0) / values.length).toFixed(6)),
      longestStaticRun: Number((longestStatic / 2).toFixed(2)),
    };
  }
  const global = summarize(scores);
  const boundaries = sceneDurations.reduce<number[]>((items, value) => [...items, (items.at(-1) ?? 0) + value], []);
  const sceneMotion = sceneDurations.map((_, sceneIndex) => {
    const start = sceneIndex === 0 ? 0 : boundaries[sceneIndex - 1];
    const end = boundaries[sceneIndex];
    const values = scores.filter((__, frameIndex) => frameIndex / 2 >= start && frameIndex / 2 < end);
    return { sceneIndex, ...summarize(values) };
  });
  return { sampledFrames: scores.length, ...global, sceneMotion };
}

export async function evaluateVideo(
  videoPath: string,
  reportDir: string,
  expectedDuration?: number,
  sceneDurations: number[] = [],
  signal?: AbortSignal,
): Promise<QualityEvaluation> {
  const issues: QualityIssueInput[] = [];
  const probe = await runCapture("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration,size",
    "-show_entries",
    "stream=codec_type,duration,width,height",
    "-of",
    "json",
    videoPath,
  ], signal);
  const data = JSON.parse(probe.stdout) as {
    format?: { duration?: string; size?: string };
    streams?: Array<{ codec_type?: string; duration?: string; width?: number; height?: number }>;
  };
  const video = data.streams?.find((stream) => stream.codec_type === "video");
  const audio = data.streams?.find((stream) => stream.codec_type === "audio");
  const duration = Number(data.format?.duration ?? 0);
  if (!video || !audio) issues.push({ severity: "error", code: "stream_missing", message: "成片缺少视频流或音频流。" });
  if (video?.width !== 1080 || video?.height !== 1920) {
    issues.push({ severity: "error", code: "wrong_dimensions", message: `成片尺寸不是 1080x1920。` });
  }
  if (expectedDuration && Math.abs(duration - expectedDuration) > 0.25) {
    issues.push({
      severity: "error",
      code: "video_project_duration_drift",
      message: `视频 ${duration.toFixed(3)} 秒，与项目音频 ${expectedDuration.toFixed(3)} 秒不一致。`,
    });
  }
  const streamDelta = Math.abs(Number(video?.duration ?? duration) - Number(audio?.duration ?? duration));
  if (streamDelta > 0.2) issues.push({ severity: "error", code: "stream_duration_drift", message: `音视频流相差 ${streamDelta.toFixed(3)} 秒。` });

  const motion = await sampleMotionMetrics(videoPath, sceneDurations, signal);
  if (motion.longestStaticRun >= 6 || motion.activeMotionRatio < 0.22) {
    issues.push({ severity: "warning", code: "video_motion_too_static", message: `画面连续静止约 ${motion.longestStaticRun.toFixed(1)} 秒，建议增加与旁白相关的元素运动或素材镜头。` });
  }
  for (const scene of motion.sceneMotion) {
    if (scene.longestStaticRun >= 6 || scene.activeMotionRatio < 0.18) {
      issues.push({ severity: "warning", code: "scene_motion_too_static", message: `第 ${scene.sceneIndex + 1} 屏有效运动比例 ${scene.activeMotionRatio}，最长低运动 ${scene.longestStaticRun.toFixed(1)} 秒。`, sceneIndex: scene.sceneIndex });
    }
  }

  await mkdir(reportDir, { recursive: true });
  const sampleTimes = [Math.min(4, duration / 4), duration / 2, Math.max(1, duration - 5)];
  const sceneBoundaries = sceneDurations.reduce<number[]>((items, value) => [...items, (items.at(-1) ?? 0) + value], []);
  const frameSizes: number[] = [];
  for (const [index, sampleTime] of sampleTimes.entries()) {
    const framePath = path.join(reportDir, `frame-${index + 1}.jpg`);
    await runCapture("ffmpeg", [
      "-y",
      "-ss",
      sampleTime.toFixed(3),
      "-i",
      videoPath,
      "-frames:v",
      "1",
      "-q:v",
      "2",
      framePath,
    ], signal);
    const size = await stat(framePath).then((value) => value.size).catch(() => 0);
    frameSizes.push(size);
    if (size < 20_000) {
      const sceneIndex = sceneBoundaries.findIndex((boundary) => sampleTime < boundary);
      issues.push({ severity: "error", code: "blank_frame", message: `抽帧 ${index + 1} 可能为空白。`, ...(sceneIndex >= 0 ? { sceneIndex } : {}) });
    }
  }

  return finalizeQualityEvaluation({
    stage: "video",
    issues,
    revisionNotes: [],
    metrics: {
      duration,
      fileSize: Number(data.format?.size ?? 0),
      width: video?.width ?? 0,
      height: video?.height ?? 0,
      streamDelta,
      expectedDuration: expectedDuration ?? 0,
      projectDurationDelta: expectedDuration ? Math.abs(duration - expectedDuration) : 0,
      minimumFrameSize: Math.min(...frameSizes),
      sampledMotionFrames: motion.sampledFrames,
      activeMotionRatio: motion.activeMotionRatio,
      meanSceneChange: motion.meanSceneChange,
      longestStaticRun: motion.longestStaticRun,
      sceneMotionRatios: motion.sceneMotion.map((scene) => scene.activeMotionRatio.toFixed(3)).join(", "),
      sceneLongestStaticRuns: motion.sceneMotion.map((scene) => scene.longestStaticRun.toFixed(1)).join(", "),
    },
  });
}
