import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { buildHtmlVideoContentGraph, readHtmlVideoContentGraphFile, type HtmlVideoContentGraph } from "../../html-video/content-graph";
import type { VideoProject, VideoScene } from "../../pipeline/types";
import { prepareF5SynthesisText } from "../../pipeline/tts";
import { getTemplateById } from "../../templates/template-registry";
import { buildProductionDecisions } from "../../production/visual-planner";
import { isNewsProject, projectNewsDate, projectRepositoryDate } from "../../pipeline/news-date";
import { repositoryHomepageTitle, repositoryNarrationTitle, repositoryOpeningTitleCount, repositoryProjectName, repositoryProjectTitleSummary, repositoryProjectUrl, repositoryTitleIdentity } from "../../pipeline/repository-project";
import { containsForbiddenGithubReference, containsForbiddenPlatformPromotion, containsForbiddenSourceAttribution, containsForbiddenWebsiteReference, genericNarrationFillerMatches, scrubGithubReference } from "../../pipeline/story";
import { runExternalProcess } from "../../pipeline/external-operation";
import { finalizeQualityEvaluation, type QualityEvaluation, type QualityIssueInput, type QualityProfile, type QualityScoreStatus } from "../quality-protocol";
import { getRuntimeConfig, type RuntimeConfig } from "../../config/runtime-config";
import { canonicalSpeechText } from "../speech-normalization";
import { findFactConflicts, highRiskPredicatesInText, sceneFactText } from "../../pipeline/fact-ledger";
import { storedNarrationSceneTranscripts, transcribeNarrationScenes, verifySceneTranscripts } from "../scene-audio-verification";
import { analyzeFrameVisual } from "../frame-visual-analysis";
import { readVisualAuditFile } from "../../html-video/visual-audit";
import { callQualityJudge, expectedJudgeScoreKeys, type QualityJudgeAttempt } from "./judge-client";
import { contentDurationPolicy, contentTypeForProject } from "../../pipeline/content-strategy";

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

const repositoryDomainPatterns = {
  stock: [
    /股票/u, /证券/u, /(?:^|\W)stock(?:s| market)?(?:\W|$)/i, /行情/u, /K\s*线/iu,
    /A\s*股/iu, /港股/u, /美股/u, /量化/u, /回测/u, /买卖点/u, /决策看板/u,
  ],
  pcb: [
    /电路板/u, /自动走线/u, /板图/u, /禁布区/u, /板厂/u, /高速信号/u,
    /printed circuit board/i, /autorout(?:er|ing)/i, /freerouting/i, /(?:^|\W)pcb(?:\W|$)/i,
  ],
} as const;

type RepositoryDomain = keyof typeof repositoryDomainPatterns;

function repositoryDomainScores(text: string) {
  return Object.fromEntries(Object.entries(repositoryDomainPatterns).map(([domain, patterns]) => [
    domain,
    patterns.filter((pattern) => pattern.test(text)).length,
  ])) as Record<RepositoryDomain, number>;
}

function dominantRepositoryDomain(text: string) {
  const scores = repositoryDomainScores(text);
  const ranked = (Object.entries(scores) as Array<[RepositoryDomain, number]>).sort((left, right) => right[1] - left[1]);
  return ranked[0][1] >= 2 && ranked[0][1] > ranked[1][1] ? { domain: ranked[0][0], scores } : null;
}

function narrationLimits(scene: VideoScene, contentType: ReturnType<typeof contentTypeForProject>) {
  if (contentType === "repository") {
    if (scene.type === "title") return { min: 25, max: 72 };
    if (scene.type === "briefing_points") return { min: 40, max: 105 };
    if (scene.type === "outro") return { min: 35, max: 130 };
    return { min: 40, max: 100 };
  }
  if (contentType === "technical-article") {
    if (scene.type === "title") return { min: 30, max: 80 };
    if (scene.type === "briefing_points") return { min: 55, max: 130 };
    if (scene.type === "outro") return { min: 40, max: 95 };
    return { min: 55, max: 120 };
  }
  if (scene.type === "title") return { min: 25, max: 80 };
  if (scene.type === "briefing_points") return { min: 45, max: 110 };
  if (scene.type === "outro") return { min: 35, max: 90 };
  return { min: 45, max: 105 };
}

const EARLY_VALUE_PATTERN = /不用|不再|只需|直接|省(?:下|掉)?|解决|降低|减少|提升|提高|更快|更少|自动|替你|避免|防范|失控|停更|退场|退出|结束|泡沫|核心|关键|真正|意味着|改变|风险|限制|成本|价格|涨价|定价|峰谷|结果|突破|首次|首秀|投用|投入运行|复用|最多|至少|并行|统一|专为|生图|编辑|推理|打造|复刻|何去何从|人气|体验|吸引|惊喜|潜力|成绩|全球第|总参数|激活参数/;

function textTokens(value: string) {
  const compact = normalizeText(value);
  const tokens = new Set<string>();
  for (let index = 0; index < compact.length - 1; index += 2) tokens.add(compact.slice(index, index + 2));
  return tokens;
}

function textSimilarity(left: string, right: string) {
  const leftTokens = textTokens(left);
  const rightTokens = textTokens(right);
  const intersection = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  const union = new Set([...leftTokens, ...rightTokens]).size;
  return union ? intersection / union : 0;
}

function firstValueIndex(value: string) {
  const match = EARLY_VALUE_PATTERN.exec(value);
  return match?.index ?? -1;
}

function visibleTokenCoverage(visibleText: string, narration: string) {
  const visible = normalizeText(visibleText);
  const spoken = normalizeText(narration);
  const tokens = new Set<string>();
  for (const match of spoken.matchAll(/[a-z][a-z0-9.-]+|\d+(?:\.\d+)?%?|[\u4e00-\u9fff]{2,}/gi)) {
    const token = match[0].toLowerCase();
    if (/^[\u4e00-\u9fff]+$/.test(token) && token.length > 3) {
      for (let index = 0; index < token.length - 1; index += 1) tokens.add(token.slice(index, index + 2));
    } else {
      tokens.add(token);
    }
  }
  if (tokens.size === 0) return 1;
  const matched = [...tokens].filter((token) => visible.includes(token)).length;
  return matched / tokens.size;
}

function standaloneNumbers(text: string) {
  return text.match(/(?<![A-Za-z])\d+(?:\.\d+)?%?(?![A-Za-z])/g) ?? [];
}

const NEWS_TECHNICAL_TERMS = [
  /\b(?:API|SDK|CUDA|GPU|CPU|Token|tokens|FP8|BF16|RAG|OCR|LLM|ASR|TTS)\b/giu,
  /(?:上下文窗口|推理吞吐|显存|算子|协议|框架|向量数据库|参数量|基准测试|缓存命中|内存访问|端到端)/gu,
];
const NEWS_EXPLANATION_PATTERN = /(?:也就是|简单说|换句话说|可以理解为|意味着|相当于|对普通人|对用户来说|不用懂技术|按每百万 Tokens 计价)/u;
const NEWS_AUDIENCE_VALUE_PATTERN = /(?:普通用户|用户|消费者|开发者|企业|团队|学生|创作者|患者|司机|家庭|意味着|影响|能用来|可以用来|帮助|省下|减少|降低|提高|更快|更便宜|更方便|限制|风险|适合)/u;
const MODEL_RELEASE_SUBJECT_PATTERN = /(?:新(?:一代|款)?大模型|大模型|语言模型|基础模型|视觉模型|推理模型|模型(?:版本|发布|开源|权重)|LLM|GPT(?:[-\s]?[\w.]+)?|Qwen(?:[-\s]?[\w.]+)?|DeepSeek[-\s]?[A-ZV\d.]+|GLM[-\s]?[\w.]+|Llama[-\s]?[\w.]+|Mistral[-\s]?[\w.]+|MiniMax[-\s]?[\w.]+|MAGI[-\s]?[\w.]+|Shieldstral[-\s]?[\w.]+)/iu;
const MODEL_RELEASE_EVENT_PATTERN = /(?:正式)?(?:发布|推出)|开源(?:发布)?|开放权重|权重开放|(?:正式版|预览版).{0,18}(?:发布|推出|上线|进入公测|开放公测)|(?:进入|开放)公测.{0,18}(?:正式版|预览版)/iu;
const MODEL_ACCESS_DETAIL_PATTERNS = {
  openSource: /(?:开源|开放权重|开放模型|权重开放|闭源|仅提供 API|可下载|商业许可|许可证)/iu,
  apiPrice: /(?:API|接口|调用|按量|价格|定价|每百万|每千|免费额度|元|美元|\$)/iu,
  hardware: /(?:显存|GPU|显卡|硬件|部署|本地运行|本地部署|内存|CUDA|服务器)/iu,
  speed: /(?:速度|吞吐|每秒|能跑多快|秒生成|tokens?\/秒|token\/s|延迟|性能|推理快|生成快)/iu,
};
const MODEL_ACCESS_NARRATION_PATTERNS = {
  openSource: /(?:开源|开放权重|开放模型|权重开放|闭源|不开源|开放范围|商业许可|许可证|是否开源)/iu,
  apiPrice: /(?:API|接口|调用|按量|价格|定价|免费|收费|额度|每百万|每千|元|美元|\$)/iu,
  hardware: /(?:显存|GPU|显卡|硬件|部署|本地运行|本地部署|内存|CUDA|服务器)/iu,
  speed: /(?:速度|吞吐|每秒|能跑多快|秒生成|tokens?\/秒|token\/s|延迟|性能|推理快|生成快)/iu,
};
const MODEL_ACCESS_DETAIL_LABELS = {
  openSource: "开源或开放范围",
  apiPrice: "API 渠道和价格",
  hardware: "本地部署硬件",
  speed: "运行速度或性能",
} as const;
const MODEL_ACCESS_PLACEHOLDER_PATTERN = /(?:未提及|未说明|未检索到|没有说明|暂无(?:公开)?(?:信息|价格|数据)|未知)/iu;

function concreteModelAccessEvidence(text: string) {
  return text.split(/[。！？!?；;\n]/u).filter((sentence) => !MODEL_ACCESS_PLACEHOLDER_PATTERN.test(sentence)).join(" ");
}

export function newsTechnicalJargon(text: string) {
  const matches: string[] = [];
  for (const pattern of NEWS_TECHNICAL_TERMS) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) matches.push(match[0]);
  }
  return matches;
}

function newsEducationIssues(narration: string, modelRelease = false): QualityIssueInput[] {
  const jargon = newsTechnicalJargon(narration);
  if (jargon.length === 0) return [];
  const issues: QualityIssueInput[] = [];
  const uniqueJargon = [...new Set(jargon.map((term) => term.toLowerCase()))];
  if ((!modelRelease && uniqueJargon.length >= 4) || jargon.length >= (modelRelease ? 12 : 6)) {
    issues.push({ severity: "error", code: "news_excessive_technical_detail", message: "新闻旁白连续堆叠技术术语，普通读者无法直接理解。", repairAction: "revise-scenes", retryable: true, evidence: { terms: uniqueJargon, count: jargon.length } });
  }
  const unexplainedSentence = narration.split(/[。！？!?；;]/u).find((sentence) => {
    const sentenceJargon = newsTechnicalJargon(sentence);
    return sentenceJargon.length >= 2 && !NEWS_EXPLANATION_PATTERN.test(sentence)
      && !(modelRelease && /(?:API|Token|显存|量化|每秒|每百万)/iu.test(sentence));
  });
  if (unexplainedSentence) {
    issues.push({ severity: "error", code: "news_jargon_unexplained", message: "新闻中的技术术语没有转换成普通读者能理解的结果。", repairAction: "revise-scenes", retryable: true, evidence: { sentence: unexplainedSentence.slice(0, 160), terms: newsTechnicalJargon(unexplainedSentence) } });
  }
  if (!NEWS_AUDIENCE_VALUE_PATTERN.test(narration)) {
    issues.push({ severity: "error", code: "news_audience_value_missing", message: "新闻没有说明这件事影响谁、能带来什么实际变化或有什么限制。", repairAction: "revise-scenes", retryable: true });
  }
  return issues;
}

function modelReleaseAccessIssues(project: VideoProject, sourceText: string, sourceSignal: string, narration: string): QualityIssueInput[] {
  const releaseSignal = `${project.meta.title} ${sourceSignal}`;
  if (!MODEL_RELEASE_SUBJECT_PATTERN.test(releaseSignal) || !MODEL_RELEASE_EVENT_PATTERN.test(releaseSignal)) return [];
  const keys = Object.keys(MODEL_ACCESS_DETAIL_PATTERNS) as Array<keyof typeof MODEL_ACCESS_DETAIL_PATTERNS>;
  const sourceAvailable = keys.filter((key) => MODEL_ACCESS_DETAIL_PATTERNS[key].test(concreteModelAccessEvidence(sourceText)));
  const narratedConcreteText = concreteModelAccessEvidence(narration);
  const missing = sourceAvailable.filter((key) => !MODEL_ACCESS_NARRATION_PATTERNS[key].test(narratedConcreteText));
  const issues: QualityIssueInput[] = [];
  if (MODEL_ACCESS_PLACEHOLDER_PATTERN.test(narration)) {
    issues.push({
      severity: "error",
      code: "model_access_details_placeholder",
      message: "模型发布新闻不得用“未提及”或“未检索到”代替联网资料；应写入已检索到的具体事实。",
      repairAction: "revise-scenes",
      retryable: true,
    });
  }
  if (missing.length === 0) return issues;
  return [{
    severity: "error",
    code: "model_access_details_missing",
    message: `模型发布新闻缺少用户关心的访问信息：${missing.map((key) => MODEL_ACCESS_DETAIL_LABELS[key]).join("、")}。`,
    repairAction: "revise-scenes",
    retryable: true,
    evidence: {
      missing: missing.map((key) => MODEL_ACCESS_DETAIL_LABELS[key]),
      sourceAvailable: sourceAvailable.map((key) => MODEL_ACCESS_DETAIL_LABELS[key]),
      unsupportedSourceFields: missing.filter((key) => !sourceAvailable.includes(key)).map((key) => MODEL_ACCESS_DETAIL_LABELS[key]),
    },
  }, ...issues];
}

function isDetailedModelReleaseProject(project: VideoProject) {
  const source = project.sources[0];
  const signal = `${project.meta.title} ${source?.title ?? ""} ${source?.summary ?? ""} ${source?.content ?? ""}`;
  return isNewsProject(project)
    && MODEL_RELEASE_SUBJECT_PATTERN.test(signal)
    && MODEL_RELEASE_EVENT_PATTERN.test(signal)
    && ((source?.research?.length ?? 0) > 0 || project.scenes.length >= 5);
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
  const repository = Boolean(repositoryProjectName(project));
  const contentType = contentTypeForProject(project);
  const contentPolicy = contentDurationPolicy(contentType);
  const isModelReleaseProject = isDetailedModelReleaseProject(project);
  const narrationChars = project.narration.replace(/\s+/g, "").length;
  const naturalDuration = config.tts.durationPolicy === "natural";
  const minimumChars = Math.round(targetSeconds * (naturalDuration ? 4.2 : 4.8));
  const maximumChars = contentType === "news"
    ? Math.round(targetSeconds * (isModelReleaseProject ? 5.7 : 5.3))
    : Math.round(targetSeconds * (contentType === "technical-article" ? 9 : 8.2));
  const plannedDurationSeconds = project.scenes.reduce((sum, scene) => sum + scene.duration, 0);
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
        severity: repository ? "warning" : "error", code: "scene_high_risk_predicate_unverified",
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

  const expectedSceneCount = isModelReleaseProject || /qbitai\.com\/2026\/08\/481372|baijiahao\.baidu\.com\/s\?id=1875120348654659873/i.test(source?.url ?? "") ? 5 : contentPolicy.sceneCount;
  if (project.scenes.length !== expectedSceneCount || project.narrationSegments?.length !== project.scenes.length) {
    issues.push({ severity: "error", code: "scene_segment_mismatch", message: `${contentType} 短视频必须是 ${expectedSceneCount} 个场景，并与旁白逐段对应。` });
  }
  if (targetSeconds < contentPolicy.minimumSeconds || targetSeconds > contentPolicy.hardMaximumSeconds || plannedDurationSeconds > contentPolicy.hardMaximumSeconds) {
    issues.push({
      severity: "error",
      code: "platform_duration_mismatch",
      message: `${contentType} 建议 ${contentPolicy.minimumSeconds}-${contentPolicy.maximumSeconds} 秒，硬上限 ${contentPolicy.hardMaximumSeconds} 秒；当前目标 ${targetSeconds} 秒，画面 ${plannedDurationSeconds} 秒。`,
      evidence: {
        contentType,
        targetSeconds,
        plannedDurationSeconds,
        recommendedMinimumSeconds: contentPolicy.minimumSeconds,
        recommendedMaximumSeconds: contentPolicy.maximumSeconds,
        hardMaximumSeconds: contentPolicy.hardMaximumSeconds,
      },
    });
    revisionNotes.push(`将视频压缩到 ${contentPolicy.minimumSeconds}-${contentPolicy.maximumSeconds} 秒，只保留钩子、关键证据、实际用途和边界。`);
  }
  if (narrationChars < minimumChars) {
    issues.push({ severity: "error", code: "narration_short", message: `旁白仅 ${narrationChars} 字，目标至少 ${minimumChars} 字。` });
    revisionNotes.push(`将总旁白扩充到 ${minimumChars} 到 ${maximumChars} 字。`);
  }
  if (narrationChars > maximumChars) {
    issues.push({ severity: "error", code: "narration_long", message: `旁白 ${narrationChars} 字，超过 ${contentType} 的完整播报预算 ${maximumChars} 字。` });
    revisionNotes.push(`将总旁白压缩到 ${maximumChars} 字以内。`);
  }
  if (contentType === "news") {
    for (const segment of project.narrationSegments ?? []) {
      const scene = project.scenes[segment.sceneIndex];
      const characters = segment.text.replace(/\s+/gu, "").length;
      const estimatedSpeechSeconds = characters / 5.1;
      if (scene && estimatedSpeechSeconds > scene.duration + 0.75) {
        issues.push({
          severity: "error",
          code: "narration_scene_overflow",
          message: `第 ${segment.sceneIndex + 1} 屏旁白约需 ${estimatedSpeechSeconds.toFixed(1)} 秒，但场景只有 ${scene.duration.toFixed(1)} 秒，可能出现未播完就跳屏。`,
          sceneIndex: segment.sceneIndex,
          evidence: { characters, estimatedSpeechSeconds, sceneDurationSeconds: scene.duration },
        });
      }
    }
  }
  const firstNarration = project.narrationSegments?.[0]?.text ?? "";
  const spokenProjectText = [
    project.narration,
    ...(project.narrationSegments ?? []).flatMap((segment) => [segment.text, segment.ttsText ?? "", segment.providerSynthesisText ?? ""]),
  ].join(" ");
  const publicProjectText = [
    project.meta.title,
    project.narration,
    ...(project.narrationSegments ?? []).flatMap((segment) => [segment.text, segment.ttsText ?? "", segment.providerSynthesisText ?? ""]),
    ...project.scenes.map(sceneVisibleText),
  ].join(" ");
  if (isNewsProject(project) && containsForbiddenSourceAttribution(spokenProjectText)) {
    issues.push({ severity: "error", code: "source_attribution_exposed", message: "新闻画面或旁白不得出现网站、媒体或文章来源署名。" });
    revisionNotes.push("删除 IT之家、量子位、36氪、TechWeb 等网站来源文字，只保留事实内容。 ");
  }
  if (isNewsProject(project) && /文章/u.test(publicProjectText)) {
    issues.push({ severity: "error", code: "news_article_wording_exposed", message: "新闻视频不得出现“文章”字样，直接陈述事实和影响。", evidence: { fragments: publicProjectText.match(/[^。！？!?]{0,18}文章[^。！？!?]{0,18}/gu)?.slice(0, 5) ?? [] } });
    revisionNotes.push("删除“文章披露”“文章列出”“文章称”等字样，直接说公开事实、价格、开放范围和限制。");
  }  if (containsForbiddenPlatformPromotion(publicProjectText)) {
    issues.push({ severity: "error", code: "external_platform_promotion_exposed", message: "视频不得出现第三方平台上线、体验中心、链接或引导访问表述。" });
    revisionNotes.push("删除第三方平台名称、上线渠道和链接引导，只保留产品功能与事实结果。");
  }
  const normalizedTitle = normalizeText(project.meta.title);
  const normalizedOpening = normalizeText(firstNarration);
  const sourceTitle = normalizeText(scrubGithubReference(project.sources[0]?.title ?? ""));
  if (!repositoryProjectName(project) && sourceTitle && normalizedTitle !== sourceTitle) {
    issues.push({ severity: "error", code: "source_title_not_preserved", message: "视频标题和首页标题必须直接使用清洗后的原始文章标题。", sceneIndex: 0, evidence: { sourceTitle: project.sources[0]?.title, projectTitle: project.meta.title } });
    revisionNotes.push("恢复原始文章标题，不要另写概括标题。 ");
  }
  const firstScenePurposeText = project.scenes[0] ? sceneVisibleText(project.scenes[0]) : "";
  const isModelRelease = /(?:模型|MAGI|Shieldstral|Mistral)/i.test(project.meta.title) && /(?:发布|推出|开源|参数|Preview)/i.test(project.meta.title);
  if (isModelRelease && !/(?:用途|用于|用来|可用于|支持|端侧|边缘|上下文|审核|生成|处理|完成|推理|生图|图像|浏览器|智能体|专为|编程|歌曲|音乐|文档)/u.test(firstScenePurposeText)) {
    issues.push({ severity: "error", code: "homepage_purpose_missing", message: "模型类视频首屏必须直接说明模型是做什么的。", sceneIndex: 0 });
    revisionNotes.push("在首屏副标题写清模型用途和直接使用场景，不要只展示参数。 ");
  }
  const narrationPunctuationBalance = [
    ["(", ")"], ["（", "）"], ["[", "]"], ["【", "】"], ["“", "”"], ["‘", "’"],
  ].filter(([open, close]) => (project.narration.split(open).length - 1) !== (project.narration.split(close).length - 1));
  if (narrationPunctuationBalance.length > 0) {
    issues.push({ severity: "error", code: "narration_punctuation_unbalanced", message: "Narration contains unmatched brackets or quotation marks that may produce TTS artifacts." });
    revisionNotes.push("Remove unmatched brackets and quotation marks before synthesis.");
  }
  const narratedRepositoryName = repositoryProjectName(project);
  const narratedTitle = normalizeText(project.meta.title);
  const titleRepeated = narratedRepositoryName
    ? repositoryOpeningTitleCount(project.narration, narratedRepositoryName) > 1
    : narratedTitle.length >= 4 && normalizeText(project.narration).split(narratedTitle).length - 1 > 1;
  if (titleRepeated) {
    issues.push({ severity: "error", code: "title_repeated_in_narration", message: "旁白重复播报主标题，只允许完整播报一次。", sceneIndex: 0 });
    revisionNotes.push("首屏只播报一次完整标题，删除后续重复标题。");
  }
  const narrationTexts = (project.narrationSegments ?? []).map((segment) => segment.text).filter(Boolean);
  const narrationJoined = narrationTexts.join(" ");
  if (contentType === "news") {
    const educationIssues = newsEducationIssues(project.narration, isModelReleaseProject);
    issues.push(...educationIssues);
    if (educationIssues.length > 0) revisionNotes.push("面向普通读者重写新闻：只保留发生了什么、影响谁、实际变化和限制；把技术术语改成日常语言，不连续罗列 API、框架、参数或架构细节。");
  }
  const genericTransitionMatches = [
    ...narrationTexts,
    ...(project.narrationSegments ?? []).flatMap((segment) => [segment.ttsText ?? "", segment.providerSynthesisText ?? ""]),
    ...project.scenes.map(sceneVisibleText),
  ].flatMap(genericNarrationFillerMatches);
  if (genericTransitionMatches.length > 0) {
    issues.push({
      severity: "error",
      code: "generic_transition_filler",
      message: "文案包含空泛模板句，应直接陈述事实、影响或限制。",
      evidence: { fragments: [...new Set(genericTransitionMatches)].slice(0, 8) },
    });
    revisionNotes.push("删除“这意味着”“这说明”“这条新闻讲的是”等模板套话，直接说具体事实和影响。");
  }
  if (/(?:\.\.\.|…+)/u.test(narrationJoined)) {
    issues.push({ severity: "error", code: "narration_truncated_fragment", message: "旁白包含未完成的截断片段。", evidence: { fragments: narrationJoined.match(/[^。！？!?]{0,18}(?:\.\.\.|…+)[^。！？!?]{0,18}/gu) ?? [] } });
    revisionNotes.push("删除 LLM 截断碎片，确保每个场景以完整句子结束。");
  }
  const danglingFragmentPattern = /(?:^|[。！？!?])(?:关键是|真正改变的是|要知道|如今|此前|其中|最后|所以|但是|以及|例如|除文本外|值得注意的是|此前报道|试了|创)[。！？!?]|(?:附加|以及其他|迭代后)[。！？!?]/gu;
  const danglingFragments = narrationTexts.flatMap((text) => text.match(danglingFragmentPattern) ?? []);
  const unpunctuatedSegments = narrationTexts.filter((text) => !/[。！？!?]$/u.test(text.trim()));
  if (danglingFragments.length > 0 || unpunctuatedSegments.length > 0) {
    issues.push({ severity: "error", code: "narration_truncated_fragment", message: "旁白包含残句或未完整结束的场景文本。", evidence: { fragments: [...danglingFragments, ...unpunctuatedSegments].slice(0, 8) } });
    revisionNotes.push("删除独立的连接词和残句，并确保每个场景以完整句子结束。");
  }
  const sentenceCounts = new Map<string, number>();
  for (const segmentText of narrationTexts) {
    for (const sentence of segmentText.split(/[。！？!?；;]/u).map((value) => normalizeText(value)).filter((value) => value.length >= 10)) {
      sentenceCounts.set(sentence, (sentenceCounts.get(sentence) ?? 0) + 1);
    }
  }
  const repeatedSentences = [...sentenceCounts.entries()].filter(([, count]) => count > 1).map(([sentence]) => sentence).slice(0, 5);
  if (repeatedSentences.length > 0) {
    issues.push({ severity: "error", code: "narration_noise_repeated", message: "旁白重复播报相同句子或信息片段。", evidence: { repeatedSentences } });
    revisionNotes.push("每个事实只播报一次，删除相邻或跨场景重复句。");
  }
  if (repositoryProjectName(project) && /围绕实际开发任务整理的开源工具|将项目资料中的核心功能和使用路径组织为可查阅的工作流/u.test(narrationJoined)) {
    issues.push({ severity: "error", code: "repository_narration_generic", message: "开源项目旁白落入通用模板，未说明该项目的独特用途。", evidence: { repository: repositoryProjectName(project) } });
    revisionNotes.push("根据项目 README 重写痛点、结果、使用场景和限制，禁止使用通用占位文案。");
  }

  const compactNarration = project.narration.replace(/\s+/g, "");
  const earlyWindow = compactNarration.slice(0, Math.max(36, Math.round(6 * 7) + 2));
  const valueIndex = firstValueIndex(compactNarration);
  const openingValuePattern = /\u6709\u671b|\u8ba1\u5212|\u4f30\u503c|\u53d1\u5e03|\u63a8\u51fa|\u4e0a\u5e02/u;
  const titleValuePattern = /\u751f\u6210|\u53d1\u5e03|\u63a8\u51fa|\u4e0a\u5e02|\u4f30\u503c|\u63d0\u5347|\u4e0a\u7ebf|\u5f00\u6e90|\u5f00\u64ad|\u5bb6\u7528|\u663e\u5361|\u8dd1\u51fa|\u72ec\u89d2\u517d|\u878d\u8d44|\u7eaa\u5f55|\u699c\u5355|\u521b\u4e0b|\u5f71\u54cd|\u6536\u8d2d|\u7f8e\u5143|\u66b4\u6da8|\u6700\u8d35|\u843d\u69cc|\u6d88\u5931|\u7834\u706d|\u5012\u584c|\u52a0\u5165|\u8d5a|\u6536\u5165|\u8ba2\u5355|\u9500\u91cf|\u7b2c\u4e00\u540d|\u593a\u51a0|\u5143\u51f6|\u4f9d\u8d56\u5305|\u8f93\u51fa\u4e0d\u540c|\u4e2d\u6bd2|\u53d7\u4f24|\u4e8b\u6545|SOTA/u;
  const repositoryOpeningValue = repositoryProjectName(project)
    ? repositoryProjectTitleSummary(project)
    : "";
  const titleHasValue = titleValuePattern.test(project.meta.title) || /来了|进入|最强/u.test(project.meta.title);
  if (valueIndex < 0 && !repositoryOpeningValue && !titleHasValue) {
    issues.push({ severity: "error", code: "hook_value_missing", message: "开场没有结果、冲突、痛点或用户收益钩子。", sceneIndex: 0 });
    revisionNotes.push("标题后立刻给出结果、冲突、痛点或用户收益，不要用背景介绍开场。");
  } else if (!repositoryOpeningValue && !EARLY_VALUE_PATTERN.test(earlyWindow) && !openingValuePattern.test(earlyWindow) && !titleHasValue && !(/(?:模型|AI)[^。！？!?]{0,24}(?:生成|生图)/u.test(project.meta.title) && /(?:模型|AI)[^。！？!?]{0,24}(?:生成|生图)/u.test(earlyWindow))) {
    issues.push({ severity: "error", code: "value_revealed_too_late", message: "核心价值在开场 6 秒之后才出现。", sceneIndex: 0, evidence: { valueCharacterIndex: valueIndex, earlyWindowCharacters: earlyWindow.length } });
    revisionNotes.push("把第一个核心卖点提前到开场 6 秒内。");
  }

  const segmentClaims = (project.narrationSegments ?? []).map((segment) => new Set(segment.claimIds ?? []));
  const allClaims = new Set(segmentClaims.flatMap((claims) => [...claims]));
  const halfwaySceneCount = Math.max(1, Math.ceil(project.scenes.length / 2));
  const earlyClaims = new Set(segmentClaims.slice(0, halfwaySceneCount).flatMap((claims) => [...claims]));
  const earlyClaimCoverage = allClaims.size ? earlyClaims.size / allClaims.size : 1;
  if (project.storyPlanning && earlyClaimCoverage < 0.7) {
    issues.push({ severity: "error", code: "value_revealed_too_late", message: `视频过半前只覆盖 ${(earlyClaimCoverage * 100).toFixed(0)}% 的事实价值。`, evidence: { earlyClaimCoverage, earlyClaimCount: earlyClaims.size, totalClaimCount: allClaims.size } });
    revisionNotes.push("在视频前半段覆盖至少 70% 的核心事实，把边界和补充说明留到后半段。");
  }
  const firstScene = project.scenes[0];
  const coverDecision = productionDecisions[0]?.templateSelection;
  const coverTemplate = coverDecision ? getTemplateById(coverDecision.templateId) : undefined;
  const coverHtml = firstScene && coverTemplate
    ? coverTemplate.renderHtml({
      project,
      scene: firstScene,
      sceneIndex: 0,
      width: project.meta.width,
      height: project.meta.height,
      variantId: coverDecision.variantId,
    })
    : "";
  const renderedSceneHtml = productionDecisions.map((decision) => {
    const scene = project.scenes[decision.sceneIndex];
    const template = getTemplateById(decision.templateSelection.templateId);
    return scene && template ? template.renderHtml({
      project,
      scene,
      sceneIndex: decision.sceneIndex,
      width: project.meta.width,
      height: project.meta.height,
      variantId: decision.templateSelection.variantId,
    }) : "";
  }).join("\n");
  const repositoryAddresses = project.sources.map((source) => source.repo).filter((repo): repo is string => Boolean(repo));
  if (containsForbiddenWebsiteReference(spokenProjectText)) {
    issues.push({ severity: "error", code: "narration_website_reference_exposed", message: "旁白、ttsText 和 providerSynthesisText 不得播报网站地址或域名；网址只允许作为画面字段展示。" });
    revisionNotes.push("从 narration、ttsText 和 providerSynthesisText 删除 http、www 及裸域名，保留网址在首屏视觉字段中的展示。 ");
  }
  const repositoryName = repositoryProjectName(project);
  if (repositoryName) {
    const firstVisibleText = firstScene ? sceneVisibleText(firstScene) : "";
    const titleSummary = repositoryProjectTitleSummary(project);
    const homepageTitle = repositoryHomepageTitle(repositoryName, titleSummary);
    if (!titleSummary || titleSummary.length < 6 || /^(?:开源)?(?:工具|项目|项目推荐|实用工具)$/u.test(titleSummary)) {
      issues.push({ severity: "error", code: "repository_title_summary_missing", message: "开源项目首屏标题必须包含具体用途总结。", sceneIndex: 0, evidence: { titleSummary: titleSummary || "missing" } });
      revisionNotes.push("在项目原名后加入一句具体用途总结，直接说明它能帮用户完成什么。");
    }
    if (firstScene?.type !== "title" || firstScene.headline !== homepageTitle) {
      issues.push({ severity: "error", code: "repository_recommendation_missing", message: `首屏必须完整显示“${homepageTitle}”。`, sceneIndex: 0 });
      revisionNotes.push(`首屏标题改为“${homepageTitle}”，并保留项目原名。`);
    }
    if (project.meta.title !== repositoryName) {
      issues.push({ severity: "error", code: "repository_name_not_canonical", message: `开源项目标题必须使用项目原名 ${repositoryName}。` });
      revisionNotes.push(`将视频标题恢复为项目原名 ${repositoryName}，不要翻译或改写。`);
    }
    const sourceDomain = dominantRepositoryDomain([
      source?.repo ?? "", source?.title ?? "", source?.summary ?? "", (source?.content ?? "").slice(0, 1200),
    ].join(" "));
    const repositoryOutputText = [
      project.narration,
      ...project.scenes.map((scene) => sceneVisibleText(scene)),
    ].join(" ");
    const outputScores = repositoryDomainScores(repositoryOutputText);
    const outputDomain = dominantRepositoryDomain(repositoryOutputText);
    const conflictingDomain = sourceDomain
      ? (Object.keys(repositoryDomainPatterns) as RepositoryDomain[]).find((domain) => (
          domain !== sourceDomain.domain
          && outputScores[domain] >= 3
          && outputScores[domain] >= sourceDomain.scores[domain] + 2
        ))
      : undefined;
    if (sourceDomain && conflictingDomain) {
      issues.push({
        severity: "error",
        code: "repository_domain_mismatch",
        message: `项目来源属于 ${sourceDomain.domain}，但生成内容混入了 ${conflictingDomain} 领域。`,
        evidence: {
          sourceDomain: sourceDomain.domain,
          outputDomain: outputDomain?.domain ?? conflictingDomain,
          sourceSignals: Object.entries(sourceDomain.scores).map(([domain, score]) => `${domain}:${score}`),
          outputSignals: Object.entries(outputScores).map(([domain, score]) => `${domain}:${score}`),
        },
      });
      revisionNotes.push("重新读取项目标题、摘要和 README，只保留来源支持的用途、工作流和限制，禁止套用其他项目画像。");
    }
    const repositoryUrl = repositoryProjectUrl(project);
    const repositoryPath = project.sources.find((item) => item.kind === "github")?.repo ?? repositoryUrl.replace(/^https?:\/\/(?:www\.)?/i, "").replace(/\/$/, "");
    const exposedRepositoryAddress = [repositoryUrl, repositoryPath, "github.com/", "raw.githubusercontent.com/"].some((value) => value && renderedSceneHtml.toLowerCase().includes(value.toLowerCase()));
    if (exposedRepositoryAddress) {
      issues.push({ severity: "error", code: "repository_address_exposed", message: "开源项目视频画面不得出现仓库地址或外部平台域名。", sceneIndex: 0, evidence: { repositoryPath: repositoryPath || "detected" } });
      revisionNotes.push("从所有模板和可视字段删除 github.com、owner/repository 及其他仓库地址；只保留项目原名、用途和 Star 数。 ");
    }
    const stars = Number(project.sources.find((item) => item.kind === "github")?.metrics?.stars);
    if (!Number.isFinite(stars) || stars <= 0 || /(?:^|\D)0\s*Stars\b/i.test(firstVisibleText)) {
      issues.push({ severity: "error", code: "repository_star_count_invalid", message: "开源项目 Star 数缺失或无效，禁止以 0 Stars 发布。", sceneIndex: 0, evidence: { stars: Number.isFinite(stars) ? stars : "missing" } });
      revisionNotes.push("重新抓取项目的真实 Star 数；抓取失败时停止发布，不得用 0 代替。 ");
    } else {
      const formattedStars = `${Math.round(stars).toLocaleString("en-US")} Stars`;
      if (!coverHtml.includes(formattedStars)) {
        issues.push({ severity: "error", code: "repository_star_not_visible", message: "开源项目真实 Star 数没有显示在首屏。", sceneIndex: 0, evidence: { stars, expectedText: formattedStars } });
        revisionNotes.push(`在首屏安全区清晰显示真实 Star 数：${formattedStars}。`);
      }
    }
    const missingRepositoryContext = [
      !/(?:用途|用于|用来|解决)/u.test(firstVisibleText) ? "用途" : "",
      !/(?:适用|场景)/u.test(firstVisibleText) ? "适用场景" : "",
    ].filter(Boolean);
    if (missingRepositoryContext.length > 0) {
      issues.push({ severity: "error", code: "repository_value_context_missing", message: `开源项目首屏缺少：${missingRepositoryContext.join("、")}。`, sceneIndex: 0 });
      revisionNotes.push("首屏同时写清项目用途、解决的问题和适用场景。 ");
    }
    const canonicalOpening = repositoryNarrationTitle(repositoryName, titleSummary);
    if (!repositoryTitleIdentity(firstNarration).startsWith(repositoryTitleIdentity(canonicalOpening))) {
      issues.push({ severity: "error", code: "repository_title_narration_mismatch", message: `首屏旁白必须与画面标题一致，先完整播报“${canonicalOpening}”。`, sceneIndex: 0 });
      revisionNotes.push(`首句完整播报“${canonicalOpening}”，然后进入项目用途。`);
    }
    const repositoryDate = projectRepositoryDate(project);
    if (!repositoryDate) {
      issues.push({ severity: "error", code: "repository_date_missing", message: "开源项目缺少可展示的推荐日期。", sceneIndex: 0 });
      revisionNotes.push("为开源项目保留生成日期，并在首屏显示精确到天的推荐日期。");
    } else {
      if (!coverHtml.includes(repositoryDate) || !coverHtml.includes("推荐日期")) {
        issues.push({ severity: "error", code: "repository_date_not_visible", message: "开源项目推荐日期没有显示在首屏。", sceneIndex: 0, evidence: { repositoryDate, templateId: coverDecision?.templateId ?? "missing" } });
        revisionNotes.push("在首屏安全区显示推荐日期，精确到天。");
      }
      if (normalizeText(spokenProjectText).includes(normalizeText(repositoryDate)) || /推荐日期/u.test(spokenProjectText)) {
        issues.push({ severity: "error", code: "repository_date_spoken", message: "开源项目推荐日期只允许显示，不得进入旁白或 TTS。", sceneIndex: 0, evidence: { repositoryDate } });
        revisionNotes.push("从 narration、ttsText 和 providerSynthesisText 删除推荐日期，只保留首屏视觉日期。");
      }
    }
    const promotionHeadlines = project.scenes.slice(1).map((scene) => sceneVisibleText(scene));
    const missingPromotionSections = [
      { label: "用户痛点", pattern: /解决|麻烦|痛点|省掉/ },
      { label: "核心价值", pattern: /值得关注|核心价值|核心亮点/ },
      { label: "上手路径", pattern: /开始|上手|使用/ },
      { label: "适用人群与边界", pattern: /什么人|适合谁|使用边界|别急/ },
    ].filter((section) => !promotionHeadlines.some((headline) => section.pattern.test(headline)));
    if (missingPromotionSections.length > 0) {
      issues.push({
        severity: "error",
        code: "repository_promotion_structure_missing",
        message: `开源项目推荐缺少：${missingPromotionSections.map((section) => section.label).join("、")}。`,
      });
      revisionNotes.push("按用户痛点、一句话收益、可信证据、最短上手路径、适用人群与边界重写项目推荐，删除空泛功能罗列。");
    }
  }
  if (project.sources.some((source) => source.kind === "github") && containsForbiddenGithubReference(spokenProjectText, repositoryAddresses)) {
    issues.push({ severity: "error", code: "repository_address_spoken", message: "开源项目仓库地址只能显示在首屏，不得出现在旁白或 TTS 合成文本中。", sceneIndex: 0 });
    revisionNotes.push("保留首屏仓库地址，但从旁白、ttsText 和 providerSynthesisText 中删除平台名、域名及 owner/repository。 ");
  }
  if (!repositoryName && !normalizeText(firstNarration).startsWith(normalizeText(project.meta.title))) {
    issues.push({ severity: "error", code: "title_not_spoken_first", message: "第一段旁白没有先完整播报新闻标题。", sceneIndex: 0 });
    revisionNotes.push("将新闻标题逐字放在第一段旁白的第一句话，念完标题后再进入正文。 ");
  }
  const publicationDate = projectNewsDate(project);
  if (isNewsProject(project) && !publicationDate) {
    issues.push({ severity: "error", code: "news_date_missing", message: "新闻项目缺少可展示的发布日期。" });
    revisionNotes.push("为新闻来源补充 publishedAt，并在首页显著展示新闻日期。 ");
  } else if (isNewsProject(project) && publicationDate) {
    if (!coverHtml.includes(publicationDate)) {
      issues.push({ severity: "error", code: "news_date_not_visible", message: "新闻发布日期没有显示在首屏。", sceneIndex: 0, evidence: { publicationDate, templateId: coverDecision?.templateId ?? "missing" } });
      revisionNotes.push("在首屏安全区显著显示精确到天的新闻发布日期。 ");
    }
    if (!normalizeText(firstNarration).includes(normalizeText(publicationDate))) {
      issues.push({ severity: "error", code: "news_date_not_spoken", message: "第一段旁白没有播报首页展示的新闻日期。", sceneIndex: 0 });
      revisionNotes.push("标题播报完成后，紧接着播报新闻日期。 ");
    }
  }
  const titleChineseCount = (project.meta.title.match(/[\u4e00-\u9fff]/g) ?? []).length;
  if (!repositoryProjectName(project) && titleChineseCount < 4) {
    issues.push({ severity: "error", code: "title_not_chinese_summary", message: "视频主标题没有形成清晰的中文总结。" });
    revisionNotes.push("将主标题改写为14到30个汉字的中文事实总结，英文仅保留必要专有名。 ");
  }
  const sourceText = `${source?.title ?? ""} ${source?.summary ?? ""} ${source?.content ?? ""} ${(source?.research ?? []).map((item) => `${item.title} ${item.source} ${item.content}`).join(" ")}`;
  if (isNewsProject(project)) issues.push(...modelReleaseAccessIssues(project, sourceText, `${source?.title ?? ""} ${source?.summary ?? ""}`, project.narration));
  const releaseStatusSource = `${source?.title ?? ""} ${source?.summary ?? ""}`;
  const releaseStatusPattern = /正式发布|正式推出|对外推出|即日起.{0,80}开放|(?:开启|进入|开放)公测/;
  const releaseNarrationPattern = /正式发布|正式推出|对外推出|开源|发布|推出|上线|开放|公测/;
  if (releaseStatusPattern.test(releaseStatusSource) && !releaseNarrationPattern.test(project.narration)) {
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
    const limits = narrationLimits(scene, contentType);
    if (narrationLength > limits.max) {
      issues.push({ severity: "error", code: "scene_narration_overloaded", message: `第 ${index + 1} 屏旁白 ${narrationLength} 字，超过当前画面建议上限 ${limits.max} 字。`, sceneIndex: index });
      revisionNotes.push(`压缩第 ${index + 1} 屏旁白，只复述该屏可见字段，不要扩展屏幕外内容。`);
    } else if (narrationLength < limits.min) {
      issues.push({ severity: "warning", code: "scene_narration_thin", message: `第 ${index + 1} 屏旁白仅 ${narrationLength} 字。`, sceneIndex: index });
    }
    const visibleText = `${project.meta.title} ${sceneVisibleText(scene)} ${index === 0 ? projectNewsDate(project) : ""}`;
    const coverage = visibleTokenCoverage(visibleText, segment.text);
    alignmentScores.push(coverage);
    if (coverage < (repository ? 0.15 : 0.25)) {
      issues.push({ severity: "error", code: "scene_narration_mismatch", message: `第 ${index + 1} 屏旁白与画面字段重合度过低。`, sceneIndex: index });
      revisionNotes.push(`重写第 ${index + 1} 屏旁白，按画面上的标题、卡片、数据或步骤逐项讲解。`);
    }
    const extraNumbers = extraNarrationNumbers(visibleText, segment.text);
    if (extraNumbers.length > 0) {
      issues.push({ severity: "error", code: "scene_extra_numbers", message: `第 ${index + 1} 屏旁白出现画面未展示的数字：${extraNumbers.join("、")}。`, sceneIndex: index });
      revisionNotes.push(`将第 ${index + 1} 屏旁白中的数字同步到画面，或从旁白删除。`);
    }
  });

  const redundantPairs: Array<[number, number, number]> = [];
  for (let left = 0; left < project.scenes.length; left += 1) {
    for (let right = left + 1; right < project.scenes.length; right += 1) {
      const similarity = textSimilarity(sceneVisibleText(project.scenes[left]), sceneVisibleText(project.scenes[right]));
      if (similarity >= 0.66) redundantPairs.push([left, right, Number(similarity.toFixed(3))]);
    }
  }
  if (redundantPairs.length > 0) {
    issues.push({ severity: "error", code: "scene_information_redundant", message: "不同场景重复表达同一组信息。", evidence: { pairs: redundantPairs.map(([left, right, similarity]) => `${left}:${right}:${similarity}`) } });
    revisionNotes.push("合并重复场景，每屏只保留一个新的结论或证据。");
  }

  const structuredEvidenceCount = project.scenes.filter((scene) => ["signal_chart", "timeline", "news_stack"].includes(scene.type)).length;
  const authenticVisualCount = productionDecisions.filter((decision) => decision.visualPlan.source !== "programmatic").length
    + structuredEvidenceCount
    + (project.screenshots?.length ?? 0)
    + (project.assets?.filter((asset) => asset.role === "evidence" || asset.role === "demo").length ?? 0);
  if (plannedDurationSeconds > 30 && authenticVisualCount === 0) {
    issues.push({ severity: "error", code: "weak_visual_proof", message: "整条视频没有真实截图、运行结果、数据证据或产品素材。", evidence: { authenticVisualCount, plannedDurationSeconds } });
    revisionNotes.push("至少为一个关键结论加入真实截图、运行结果、输入输出对比或来源证据。");
  }

  const visualStateCount = productionDecisions.reduce((sum, decision) => sum + 1 + decision.syncCues.length, 0);
  const visualChangeIntervalSeconds = plannedDurationSeconds / Math.max(1, visualStateCount);
  if (visualChangeIntervalSeconds > 4) {
    issues.push({ severity: "error", code: "low_visual_change_rate", message: `平均 ${visualChangeIntervalSeconds.toFixed(1)} 秒才发生一次有效视觉变化。`, evidence: { visualStateCount, visualChangeIntervalSeconds } });
    revisionNotes.push("每 2 到 4 秒安排一次关键词高亮、数据进入、局部推进或证据切换，不要依赖频繁整屏跳切。");
  }

  const finalNarration = project.narrationSegments?.at(-1)?.text ?? "";
  const previousNarration = project.narrationSegments?.slice(0, -1).map((segment) => segment.text).join(" ") ?? "";
  const closeSimilarity = textSimilarity(finalNarration, `${project.meta.title} ${previousNarration}`);
  const addsDecisionValue = /限制|边界|适合|不适合|建议|优先|风险|注意|取决于|值得|可以|不能|不应|先/.test(finalNarration);
  if (finalNarration && closeSimilarity >= 0.58 && !addsDecisionValue) {
    issues.push({ severity: "error", code: "empty_summary_close", message: "结尾只是重复标题或前文，没有提供限制、选择建议或适用边界。", sceneIndex: project.scenes.length - 1, evidence: { closeSimilarity } });
    revisionNotes.push("结尾补充限制、选择建议、适用者或验证边界，不要再次概括标题。");
  }

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
      contentType,
      recommendedMinimumSeconds: contentPolicy.minimumSeconds,
      recommendedMaximumSeconds: contentPolicy.maximumSeconds,
      hardMaximumSeconds: contentPolicy.hardMaximumSeconds,
      plannedDurationSeconds,
      earlyClaimCoverage: Number(earlyClaimCoverage.toFixed(3)),
      authenticVisualCount,
      visualStateCount,
      visualChangeIntervalSeconds: Number(visualChangeIntervalSeconds.toFixed(3)),
      redundantScenePairCount: redundantPairs.length,
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
