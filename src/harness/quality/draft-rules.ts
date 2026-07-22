import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { buildHtmlVideoContentGraph, readHtmlVideoContentGraphFile, type HtmlVideoContentGraph } from "../../html-video/content-graph";
import type { VideoProject, VideoScene } from "../../pipeline/types";
import { prepareF5SynthesisText } from "../../pipeline/tts";
import { getTemplateById } from "../../templates/template-registry";
import { buildProductionDecisions } from "../../production/visual-planner";
import { isNewsProject, projectNewsDate } from "../../pipeline/news-date";
import { repositoryProjectName } from "../../pipeline/repository-project";
import { containsForbiddenGithubReference, containsForbiddenPlatformPromotion, containsForbiddenSourceAttribution } from "../../pipeline/story";
import { runExternalProcess } from "../../pipeline/external-operation";
import { finalizeQualityEvaluation, type QualityEvaluation, type QualityIssueInput, type QualityProfile, type QualityScoreStatus } from "../quality-protocol";
import { getRuntimeConfig, type RuntimeConfig } from "../../config/runtime-config";
import { canonicalSpeechText } from "../speech-normalization";
import { findFactConflicts, highRiskPredicatesInText, sceneFactText } from "../../pipeline/fact-ledger";
import { storedNarrationSceneTranscripts, transcribeNarrationScenes, verifySceneTranscripts } from "../scene-audio-verification";
import { analyzeFrameVisual } from "../frame-visual-analysis";
import { readVisualAuditFile } from "../../html-video/visual-audit";
import { callQualityJudge, expectedJudgeScoreKeys, type QualityJudgeAttempt } from "./judge-client";

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
    case "web_screenshot_zoom":
      return [scene.headline, ...scene.shots.map((shot) => shot.title)].join(" ");
    case "news_stack":
      return [scene.headline, ...scene.items.flatMap((item) => [item.title, item.summary])].join(" ");
    case "timeline":
      return [scene.headline, ...scene.events.flatMap((event) => [event.date, event.title])].join(" ");
    case "github_pulse":
      return [scene.headline, ...scene.repos.flatMap((repo) => [repo.repo, repo.title, repo.summary])].join(" ");
  }
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

function standaloneNumbers(text: string) {
  return text.match(/(?<![A-Za-z])\d+(?:\.\d+)?%?(?![A-Za-z])/g) ?? [];
}

export function extraNarrationNumbers(visibleText: string, narration: string) {
  const visibleNumbers = new Set(standaloneNumbers(visibleText));
  return [...new Set(standaloneNumbers(narration))].filter((value) => !visibleNumbers.has(value));
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

export async function evaluateDraft(
  project: VideoProject,
  targetSeconds: number,
  feedbackGuidance: string,
  signal?: AbortSignal,
  config: RuntimeConfig = getRuntimeConfig(),
): Promise<QualityEvaluation> {
  const issues: QualityIssueInput[] = [];
  const revisionNotes: string[] = [];
  const source = project.sources[0];
  const narrationChars = project.narration.replace(/\s+/g, "").length;
  const naturalDuration = config.tts.durationPolicy === "natural";
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
  const uniqueCompositionCount = new Set(compositionIds).size;
  const adjacentTemplateRepeats = templateIds.filter((id, index) => index > 0 && id === templateIds[index - 1]).length;
  const templateCategoryCount = new Set(templateIds.map((id) => getTemplateById(id)?.category).filter(Boolean)).size;
  const averageTemplateScore = templateGraph.nodes.length
    ? templateGraph.nodes.reduce((sum, node) => sum + node.templateScore, 0) / templateGraph.nodes.length
    : 0;
  if (project.factLedger) {
    if (!project.titleClaimIds?.length) {
      issues.push({ severity: "error", code: "title_fact_claims_missing", message: "项目标题没有引用声明级事实。" });
    }
    for (const conflict of findFactConflicts(project.factLedger)) {
      issues.push({
        severity: "warning", code: "source_fact_conflict",
        message: `多个来源对 ${conflict[0].predicate} 给出冲突值，发布前需要明确取值范围。`,
        evidence: { claimIds: conflict.map((claim) => claim.id), sourceIds: conflict.map((claim) => claim.sourceId), values: conflict.map((claim) => claim.value) },
      });
    }
  }

  if (project.scenes.length >= 5 && uniqueTemplateCount < 3 && uniqueCompositionCount < 3) {
    issues.push({ severity: "error", code: "template_diversity_low", message: `五屏视频只使用了 ${uniqueTemplateCount} 种模板，至少需要 3 种构图。` });
  }
  if (adjacentTemplateRepeats > 0) {
    issues.push({ severity: "error", code: "template_adjacent_repeat", message: `存在 ${adjacentTemplateRepeats} 处相邻场景重复模板。` });
  }
  for (const node of templateGraph.nodes) {
    const selectedScene = project.scenes[node.sceneIndex];
    const segment = project.narrationSegments?.[node.sceneIndex];
    if (project.factLedger && node.sourceEvidence.claimIds.length === 0) {
      issues.push({ severity: "error", code: "scene_fact_claims_missing", message: `第 ${node.sceneIndex + 1} 屏没有可核验的事实引用。`, sceneIndex: node.sceneIndex });
    }
    if (project.factLedger && !segment?.claimIds?.length) {
      issues.push({ severity: "error", code: "narration_fact_claims_missing", message: `第 ${node.sceneIndex + 1} 屏旁白没有事实引用。`, sceneIndex: node.sceneIndex });
    }
    if (node.sourceEvidence.unmatchedNumbers.length > 0) {
      issues.push({ severity: "error", code: "scene_source_number_unverified", message: `第 ${node.sceneIndex + 1} 屏出现来源正文无法核验的数字：${node.sourceEvidence.unmatchedNumbers.join("、")}。`, sceneIndex: node.sceneIndex });
    }
    if (node.sourceEvidence.unsupportedPredicates.length > 0) {
      issues.push({
        severity: "error", code: "scene_high_risk_predicate_unverified",
        message: `第 ${node.sceneIndex + 1} 屏的高风险表述缺少直接来源证据：${node.sourceEvidence.unsupportedPredicates.join("、")}。`, sceneIndex: node.sceneIndex,
        evidence: { predicates: node.sourceEvidence.unsupportedPredicates, claimIds: node.sourceEvidence.claimIds },
      });
    }
    if (selectedScene && highRiskPredicatesInText(sceneFactText(selectedScene)).length > 0 && node.sourceEvidence.missingQualifiers.length > 0) {
      issues.push({
        severity: "error", code: "scene_fact_qualifier_dropped",
        message: `第 ${node.sceneIndex + 1} 屏省略了来源限定词：${node.sourceEvidence.missingQualifiers.join("、")}。`, sceneIndex: node.sceneIndex,
        evidence: { qualifiers: node.sourceEvidence.missingQualifiers, claimIds: node.sourceEvidence.claimIds },
      });
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
  const publicProjectText = [project.meta.title, project.narration, ...project.scenes.map(sceneVisibleText)].join(" ");
  if (isNewsProject(project) && containsForbiddenSourceAttribution(publicProjectText)) {
    issues.push({ severity: "error", code: "source_attribution_exposed", message: "新闻画面或旁白不得出现网站、媒体或文章来源署名。" });
    revisionNotes.push("删除 IT之家、量子位、36氪、TechWeb 等网站来源文字，只保留事实内容。 ");
  }
  if (containsForbiddenPlatformPromotion(publicProjectText)) {
    issues.push({ severity: "error", code: "external_platform_promotion_exposed", message: "视频不得出现第三方平台上线、体验中心、链接或引导访问表述。" });
    revisionNotes.push("删除第三方平台名称、上线渠道和链接引导，只保留产品功能与事实结果。");
  }
  const normalizedTitle = normalizeText(project.meta.title);
  const normalizedOpening = normalizeText(firstNarration);
  const narrationPunctuationBalance = [
    ["(", ")"], ["（", "）"], ["[", "]"], ["【", "】"], ["“", "”"], ["‘", "’"],
  ].filter(([open, close]) => (project.narration.split(open).length - 1) !== (project.narration.split(close).length - 1));
  if (narrationPunctuationBalance.length > 0) {
    issues.push({ severity: "error", code: "narration_punctuation_unbalanced", message: "Narration contains unmatched brackets or quotation marks that may produce TTS artifacts." });
    revisionNotes.push("Remove unmatched brackets and quotation marks before synthesis.");
  }
  if (normalizedTitle.length >= 4 && normalizedOpening.split(normalizedTitle).length - 1 > 1) {
    issues.push({ severity: "error", code: "title_spoken_repeated", message: "首屏旁白重复播报主标题，只允许完整播报一次。", sceneIndex: 0 });
    revisionNotes.push("首屏只播报一次完整标题，删除后续重复标题。");
  }
  const repositoryAddresses = project.sources.map((source) => source.repo).filter((repo): repo is string => Boolean(repo));
  const repositoryName = repositoryProjectName(project);
  if (repositoryName) {
    const firstScene = project.scenes[0];
    const firstVisibleText = firstScene ? sceneVisibleText(firstScene) : "";
    if (!firstVisibleText.includes("开源项目推荐") || !firstVisibleText.includes(repositoryName)) {
      issues.push({ severity: "error", code: "repository_recommendation_missing", message: `首屏必须包含“开源项目推荐：${repositoryName}”。`, sceneIndex: 0 });
      revisionNotes.push(`首屏添加“开源项目推荐：${repositoryName}”，并保留项目原名。`);
    }
    if (project.meta.title !== repositoryName) {
      issues.push({ severity: "error", code: "repository_name_not_canonical", message: `开源项目标题必须使用项目原名 ${repositoryName}。` });
      revisionNotes.push(`将视频标题恢复为项目原名 ${repositoryName}，不要翻译或改写。`);
    }
    if (!normalizeText(firstNarration).startsWith(normalizeText(repositoryName))) {
      issues.push({ severity: "error", code: "repository_name_not_spoken_first", message: `首屏旁白必须先播报项目原名 ${repositoryName}。`, sceneIndex: 0 });
      revisionNotes.push(`首句先播报项目原名 ${repositoryName}，再说明这是开源项目推荐。`);
    }
  }
  if (project.sources.some((source) => source.kind === "github") && containsForbiddenGithubReference(publicProjectText, repositoryAddresses)) {
    issues.push({ severity: "error", code: "external_platform_reference_exposed", message: "开源项目视频不得展示或播报第三方代码托管平台名称、域名或仓库地址。" });
    revisionNotes.push("删除平台名称、平台域名和 owner/repository 地址，只保留项目名称与功能事实。 ");
  }
  if (!normalizeText(firstNarration).startsWith(normalizeText(project.meta.title))) {
    issues.push({ severity: "error", code: "title_not_spoken_first", message: "第一段旁白没有先完整播报新闻标题。", sceneIndex: 0 });
    revisionNotes.push("将新闻标题逐字放在第一段旁白的第一句话，念完标题后再进入正文。 ");
  }
  const publicationDate = projectNewsDate(project);
  if (isNewsProject(project) && !publicationDate) {
    issues.push({ severity: "error", code: "news_date_missing", message: "新闻项目缺少可展示的发布日期。" });
    revisionNotes.push("为新闻来源补充 publishedAt，并在首页显著展示新闻日期。 ");
  } else if (isNewsProject(project) && publicationDate && !normalizeText(firstNarration).includes(normalizeText(publicationDate))) {
    issues.push({ severity: "error", code: "news_date_not_spoken", message: "第一段旁白没有播报首页展示的新闻日期。", sceneIndex: 0 });
    revisionNotes.push("标题播报完成后，紧接着播报新闻日期。 ");
  }
  const titleChineseCount = (project.meta.title.match(/[\u4e00-\u9fff]/g) ?? []).length;
  if (!repositoryProjectName(project) && titleChineseCount < 6) {
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

  const qualityProfile: QualityProfile = { name: config.quality.profile, blockWarnings: config.quality.profile === "strict", blockingWarningCodes: [...config.quality.blockingWarningCodes] };
  const requestedJudgeSamples = config.llm.quality.samples;
  const judgeAttempts: QualityJudgeAttempt[] = [];
  let scoreStatus: QualityScoreStatus = "unavailable";
  let judgeReason = "";
  for (let sampleIndex = 0; sampleIndex < requestedJudgeSamples; sampleIndex += 1) {
    let attempt: QualityJudgeAttempt;
    try {
      attempt = await callQualityJudge(project, feedbackGuidance, config, signal);
    } catch (error) {
      attempt = { status: "unavailable", reason: (error as Error).message };
    }
    if (attempt.status === "not-required") {
      scoreStatus = "not-required";
      judgeReason = attempt.reason ?? "Quality judge is not required.";
      break;
    }
    if (attempt.status === "unavailable") {
      judgeReason = attempt.reason ?? "Quality judge is unavailable.";
      issues.push({
        severity: qualityProfile.name === "strict" ? "error" : "warning",
        code: "judge_unavailable",
        issueClass: "environment",
        message: judgeReason,
        evidence: { sample: sampleIndex + 1, requestedSamples: requestedJudgeSamples, reason: judgeReason },
        repairAction: "check-environment",
        retryable: false,
      });
      scoreStatus = judgeAttempts.length > 0 ? "partially-measured" : "unavailable";
      break;
    }
    judgeAttempts.push(attempt);
    if (sampleIndex === 0) {
      issues.push(...(attempt.issues ?? []));
      revisionNotes.push(...(attempt.revisionNotes ?? []));
    }
  }

  let scores: Record<string, number> | undefined;
  let judgeMaxDelta = 0;
  if (judgeAttempts.length > 0) {
    scores = Object.fromEntries(expectedJudgeScoreKeys.flatMap((key) => {
      const values = judgeAttempts.flatMap((attempt) => attempt.scores?.[key] === undefined ? [] : [attempt.scores[key]]);
      return values.length > 0 ? [[key, Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(2))]] : [];
    }));
    const missingScoreKeys = expectedJudgeScoreKeys.filter((key) => scores?.[key] === undefined);
    const incompleteAttempt = judgeAttempts.some((attempt) => attempt.status === "partially-measured");
    scoreStatus = missingScoreKeys.length > 0 || incompleteAttempt || judgeAttempts.length < requestedJudgeSamples ? "partially-measured" : "measured";
    if (scoreStatus === "partially-measured") {
      issues.push({
        severity: "warning",
        code: "judge_partially_measured",
        issueClass: "soft",
        message: "Quality judge measured only part of the required score set: " + (missingScoreKeys.join(", ") || "consistency sample unavailable") + ".",
        evidence: { missingScoreKeys, completedSamples: judgeAttempts.length, requestedSamples: requestedJudgeSamples },
        repairAction: "check-environment",
        retryable: false,
      });
    }
    if (judgeAttempts.length > 1) {
      judgeMaxDelta = Math.max(...expectedJudgeScoreKeys.map((key) => {
        const values = judgeAttempts.flatMap((attempt) => attempt.scores?.[key] === undefined ? [] : [attempt.scores[key]]);
        return values.length > 1 ? Math.max(...values) - Math.min(...values) : 0;
      }));
      const unstableThreshold = config.llm.quality.maxScoreDelta;
      if (judgeMaxDelta > unstableThreshold) {
        issues.push({
          severity: qualityProfile.name === "strict" ? "error" : "warning",
          code: "judge_unstable",
          issueClass: "hard",
          message: "Quality judge samples differ by as much as " + judgeMaxDelta.toFixed(1) + " points.",
          evidence: { sampleCount: judgeAttempts.length, maxScoreDelta: judgeMaxDelta, threshold: unstableThreshold },
          repairAction: "retry-stage",
          retryable: true,
        });
      }
    }
  }

  const scoreValues = scores ? Object.values(scores) : [];
  const scoreAverage = scoreValues.length ? scoreValues.reduce((sum, value) => sum + value, 0) / scoreValues.length : undefined;
  const scoreMinimum = scoreValues.length ? Math.min(...scoreValues) : undefined;
  if (scoreAverage !== undefined && scoreMinimum !== undefined && (scoreAverage < 78 || scoreMinimum < 70)) {
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
    scoreStatus,
    profile: qualityProfile,
    metrics: {
      narrationChars,
      targetSeconds,
      ...(scoreAverage === undefined ? {} : { scoreAverage: Number(scoreAverage.toFixed(1)) }),
      ...(scoreMinimum === undefined ? {} : { scoreMinimum }),
      scoreStatus,
      judgeSamplesRequested: scoreStatus === "not-required" ? 0 : requestedJudgeSamples,
      judgeSamplesCompleted: judgeAttempts.length,
      judgeMaxScoreDelta: Number(judgeMaxDelta.toFixed(2)),
      ...(judgeReason ? { judgeReason } : {}),
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
      factClaimCount: project.factLedger?.claims.length ?? 0,
      referencedFactClaimCount: new Set([
        ...(project.titleClaimIds ?? []),
        ...project.scenes.flatMap((scene) => scene.claimIds ?? []),
        ...(project.narrationSegments?.flatMap((segment) => segment.claimIds ?? []) ?? []),
      ]).size,
      factConflictCount: project.factLedger ? findFactConflicts(project.factLedger).length : 0,
      storyPlanCandidateCount: project.storyPlanning?.rankings.length ?? 0,
      storyPlanRejectedCount: project.storyPlanning?.rankings.filter((ranking) => ranking.rejectedReasons.length > 0).length ?? 0,
      selectedStoryPlanScore: project.storyPlanning?.rankings.find((ranking) => ranking.candidate.id === project.storyPlanning?.selectedCandidateId)?.scores.total ?? 0,
    },
  });
}
