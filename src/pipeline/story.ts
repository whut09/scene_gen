import type { HotItem, VideoProject, VideoScene, WebScreenshot } from "./types";

import { buildFactLedger, claimIdsForText, sceneFactText } from "./fact-ledger";
import { contentTypeForItem } from "./content-type";
import { REPOSITORY_HOMEPAGE_PREFIX, repositoryHomepageTitle, repositoryNarrationTitle, repositorySynthesisText } from "./repository-project";

const palette = ["#42d392", "#7dd3fc", "#f97316", "#f43f5e", "#a78bfa", "#facc15"];

function shortTitle(title: string, max = 34) {
  return title.length > max ? `${title.slice(0, max - 1)}…` : title;
}

function speechFriendlyText(text: string) {
  return text
    .replace(/\bCOO\b/gi, "首席运营官")
    .replace(/HappyHorse/gi, "活动主办方")
    .replace(/HorsePower/gi, "人工智能影像大赛");
}

function speechFriendlyTitle(title: string) {
  return speechFriendlyText(title.replace(/^.{4,24}[？?](?=.{2,30}[：:])/u, ""));
}

const danglingClauseEnding = /(?:\u6b63\u662f\u56e0\u4e3a|\u56e0\u4e3a|\u4f46\u662f|\u800c\u4e14|\u4ee5\u53ca|\u5e76\u4e14|\u4ece\u800c|\u6240\u4ee5|\u5305\u62ec|\u4f8b\u5982)[\uff0c,:\s]*$/u;

function hasUnclosedPairedPunctuation(text: string) {
  const pairs = [["“", "”"], ["‘", "’"], ["（", "）"], ["(", ")"], ["《", "》"], ["【", "】"]] as const;
  return pairs.some(([opening, closing]) => text.split(opening).length > text.split(closing).length);
}

function balancePairedPunctuation(text: string) {
  const pairs = [["“", "”"], ["‘", "’"], ["（", "）"], ["(", ")"], ["《", "》"], ["【", "】"]] as const;
  return pairs.reduce((result, [opening, closing]) => {
    const openingCount = result.split(opening).length - 1;
    const closingCount = result.split(closing).length - 1;
    return openingCount === closingCount ? result : result.replaceAll(opening, "").replaceAll(closing, "");
  }, text);
}

function normalizeArticleNarration(text: string) {
  return text
    .replace(/([A-Za-z])-[。．](?=\d)/g, (_match, letter: string) => `${letter}-`)
    .replace(/([。！？；\s])?[△●•▪■]+\s*/gu, "$1")
    .replace(/(?<![A-Za-z0-9])([。！？；])?\s*(?=[2-9][、．]\s*)/gu, "。")
    .replace(/[（(]\s*[xX×]\s*[）)]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

function splitOversizedChunk(chunk: string, maxCharacters: number) {
  if (chunk.length <= maxCharacters) return [chunk];
  const sentences = chunk.match(/[^\u3002\uff01\uff1f\uff1b]+[\u3002\uff01\uff1f\uff1b]?/gu) ?? [chunk];
  const result: string[] = [];
  let current = "";
  for (const sentence of sentences) {
    if (current && current.length + sentence.length > maxCharacters && !hasUnclosedPairedPunctuation(current)) {
      result.push(balancePairedPunctuation(current));
      current = sentence;
    } else {
      current += sentence;
    }
  }
  if (current) result.push(balancePairedPunctuation(current));
  return result;
}

function removeNarrationLead(value: string) {
  return value.replace(/^(?:\u8fd9\u6761\u65b0\u95fb\u8bb2\u7684\u662f|\u8fd9\u7bc7\u6280\u672f\u6587\u7ae0\u8ba8\u8bba\u7684\u662f)[\uff1a:,\uff0c\s]*/u, "").trim();
}

export function splitArticleIntoSemanticChunks(text: string, maxCharacters = 72) {
  const clauses = normalizeArticleNarration(scrubAttribution(text)).match(/[^\uff0c\uff1b\uff1a\u3002\uff01\uff1f]+[\uff0c\uff1b\uff1a\u3002\uff01\uff1f]?/gu) ?? [];
  const chunks: string[] = [];
  let current = "";
  for (const rawClause of clauses) {
    const clause = rawClause.trim();
    if (!clause) continue;
    if (current && [...current, ...clause].length > maxCharacters && !danglingClauseEnding.test(current) && !hasUnclosedPairedPunctuation(current)) {
      chunks.push(current);
      current = clause;
    } else {
      current += clause;
    }
  }
  if (current) chunks.push(current);
  return chunks
    .map((chunk) => chunk.trim())
    .map((chunk) => {
      const balanced = balancePairedPunctuation(chunk);
      const complete = danglingClauseEnding.test(balanced) ? balanced.replace(danglingClauseEnding, "") : balanced;
      return /[\u3002\uff01\uff1f\uff1b]$/u.test(complete) ? complete : `${complete.replace(/[\uff0c\uff1a]+$/u, "")}\u3002`;
    })
    .flatMap((chunk) => splitOversizedChunk(chunk, maxCharacters))
    .filter((chunk) => chunk.length >= 12);
}

function sourceLabel(item: HotItem) {
  if (item.repo) return item.repo.split("/").filter(Boolean).at(-1) ?? "开源项目";
  return item.source || item.domain || "AI Signal";
}

function displaySource(item: HotItem) {
  if (item.kind === "github") return "项目资料";
  if (item.kind === "hackernews") return "社区讨论";
  return "核心事实";
}

const forbiddenSourceAttribution = /(?:来自|据|援引|转引)?\s*(?:IT之家|ITHome|QbitAI|qbitai[.]com|量子位|智东西|腾讯新闻|腾讯网|36氪|TechWeb|钛媒体官方网站|钛媒体|新浪科技|搜狐科技|潮新闻客户端|潮新闻|新华网|同花顺财经|同花顺|百度百家号|百家号)(?:的?(?:消息|报道|获悉|文章|网站))?/gi;
const forbiddenGithubPlatformReference = /(?:https?:\/\/)?(?:www\.)?github\.com(?:\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)?)?|\bgithub(?:\s+release)?\b/gi;
const forbiddenPlatformPromotion = /(?:火山方舟|方舟体验中心|体验中心上线|附相关链接|相关链接|点击链接|前往体验)/gi;

export function containsForbiddenGithubReference(text: string, repositoryAddresses: string[] = []) {
  forbiddenGithubPlatformReference.lastIndex = 0;
  if (forbiddenGithubPlatformReference.test(text)) return true;
  return repositoryAddresses.some((address) => address && text.toLowerCase().includes(address.toLowerCase()));
}

export function scrubGithubReference(text: string, repositoryAddresses: string[] = []) {
  let result = text.replace(forbiddenGithubPlatformReference, "开源项目");
  for (const address of repositoryAddresses) {
    if (!address) continue;
    const projectName = address.split("/").filter(Boolean).at(-1) ?? "开源项目";
    result = result.replace(new RegExp(address.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), projectName);
  }
  return result.replace(/开源项目(?:\s*开源项目)+/g, "开源项目").replace(/\s+/g, " ").trim();
}

export function containsForbiddenSourceAttribution(text: string) {
  forbiddenSourceAttribution.lastIndex = 0;
  return forbiddenSourceAttribution.test(text);
}

export function containsForbiddenPlatformPromotion(text: string) {
  forbiddenPlatformPromotion.lastIndex = 0;
  return forbiddenPlatformPromotion.test(text);
}

export function scrubAttribution(text: string) {
  forbiddenSourceAttribution.lastIndex = 0;
  return text
    .replace(forbiddenSourceAttribution, "")
    .replace(/作者\s*[：:|｜]?\s*[\u4e00-\u9fa5A-Za-z0-9_ -]{0,24}/g, "")
    .replace(/编辑(?:\s*[：:|｜]\s*|\s+)[\u4e00-\u9fa5A-Za-z0-9_ -]{1,24}/g, "")
    .replace(/来源\s*[：:|｜]?\s*[\u4e00-\u9fa5A-Za-z0-9_. -]{0,32}/g, "")
    .replace(/图源\s*[：:|｜]?\s*[^，。！？；;\s]{0,32}/g, "")
    .replace(/(?:^|[。！？\s])记者\s+[\u4e00-\u9fa5]{2,4}(?=$|[“”"'，,。！？\s])/gu, " ")
    .replace(/[^。！？；;\n]*(?:火山方舟|方舟体验中心|体验中心上线|附相关链接|相关链接|点击链接|前往体验)[^。！？；;\n]*[。！？；;]?/gi, "")
    .replace(/^[，,：:；;\s]+/u, "")
    .replace(/[_-]\s*$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanItem(item: HotItem): HotItem {
  return {
    ...item,
    title: scrubAttribution(item.title),
    summary: scrubAttribution(item.summary),
    content: item.content ? scrubAttribution(item.content) : undefined,
    source: displaySource(item),
    domain: undefined,
  };
}

function pickTopic(items: HotItem[]) {
  const tags = new Map<string, number>();
  for (const item of items) {
    for (const tag of item.tags) tags.set(tag, (tags.get(tag) ?? 0) + item.score);
  }
  const top = [...tags.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  return top ? `${top.toUpperCase()} 热点` : "AI 今日热点";
}

function metricValue(item: HotItem, key: string) {
  const value = item.metrics?.[key];
  if (value === undefined || value === null || value === "") return null;
  return String(value);
}

function compactSentence(text: string, max = 72) {
  const clean = scrubAttribution(text).replace(/[。！？].*$/, (match) => match.slice(0, max));
  return clean.length > max ? `${clean.slice(0, max - 1)}...` : clean;
}

export function limitNarration(text: string, maxCharacters = 110) {
  if (text.length <= maxCharacters) return text;
  const chunks = splitArticleIntoSemanticChunks(text, maxCharacters);
  const selected: string[] = [];
  let length = 0;
  for (const chunk of chunks) {
    if (selected.length && length + chunk.length > maxCharacters) break;
    selected.push(chunk);
    length += chunk.length;
  }
  const limited = selected.join("") || text.slice(0, maxCharacters);
  return /[，、：；;,]$/u.test(limited)
    ? `${limited.replace(/[，、：；;,]+$/u, "")}。`
    : limited;
}

function normalizedNarrationSentence(value: string) {
  return value
    .replace(/[\s\u3000]+/gu, "")
    .replace(/[。！？!?；;，,：:]+$/gu, "")
    .toLowerCase();
}

function removeAdjacentRepeatedSentences(text: string) {
  const sentences = text.match(/[^。！？!?；;]+[。！？!?；;]?/gu) ?? [text];
  const result: string[] = [];
  for (const sentence of sentences) {
    const normalized = normalizedNarrationSentence(sentence);
    if (!normalized) continue;
    const previous = result.at(-1);
    if (previous && normalized === normalizedNarrationSentence(previous)) continue;
    result.push(sentence.trim());
  }
  return result.join("");
}

export function cleanNarrationNoise(text: string) {
  let cleaned = text
    .replace(/(?:GPT|Wa|Chat|Sol)\s*\.\.\./gi, "")
    .replace(/\.{3,}|…{1,}/gu, "")
    .replace(/(?:Chat优化版|Coding热辣滚烫|好你个奥特曼|但事实上)(?:[。！？!?，,；;]?)/gu, "")
    .replace(/\s*[|｜]\s*/gu, "，")
    .replace(/\s+/gu, " ")
    .trim();
  cleaned = removeAdjacentRepeatedSentences(cleaned);
  cleaned = cleaned
    .replace(/[，,：:；;]+([。！？!?])/gu, "$1")
    .replace(/[，,：:；;]+$/gu, "")
    .trim();
  if (!cleaned) return "";
  return /[。！？!?]$/u.test(cleaned) ? cleaned : `${cleaned}。`;
}

function removeRepeatedTitle(text: string, title: string) {
  if (!title) return text;
  const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.replace(new RegExp(escaped, "giu"), "").replace(/^\s*[。！？!?，,：:]+/u, "").trim();
}

export function compactProjectNarration(project: VideoProject) {
  if (!project.narrationSegments?.length) return project;
  const contentType = project.sources[0] ? contentTypeForItem(project.sources[0]) : "news";
  const title = project.meta.title;
  const focusedNews = contentType === "news" && project.meta.durationSeconds >= 55;
  const datePattern = /新闻日期：[^。！？!?]+[。！？!?]?/gu;
  let dateKept = false;
  const narrationSegments = project.narrationSegments.map((segment) => {
    const scene = project.scenes[segment.sceneIndex];
    const maximumCharacters = contentType === "repository"
      ? scene?.type === "title" ? 72 : scene?.type === "outro" ? 70 : 68
      : focusedNews ? scene?.type === "title" ? 100 : scene?.type === "outro" ? 100 : 115
      : scene?.type === "title" ? 72 : scene?.type === "outro" ? 58 : 62;
    let sourceText = segment.text;
    const sceneSubhead = scene && "subhead" in scene && typeof scene.subhead === "string" ? scene.subhead : undefined;
    if (segment.sceneIndex === 0 && sceneSubhead && /新闻日期：[^。]+。/u.test(sourceText)) {
      const date = sourceText.match(/新闻日期：[^。]+。/u)?.[0] ?? "";
      const withoutDate = sourceText.replace(date, "").replace(/关键是，[^。]+。?$/u, "").trim();
      const titleOnly = normalizedNarrationSentence(withoutDate) === normalizedNarrationSentence(title);
      const opening = titleOnly ? `${withoutDate}${sceneSubhead.replace(/[。！？!?]+$/u, "")}。` : withoutDate;
      sourceText = `${limitNarration(opening, maximumCharacters - date.length)}${date}`;
    }
    sourceText = cleanNarrationNoise(sourceText);
    if (contentType !== "repository" && segment.sceneIndex > 0) sourceText = removeRepeatedTitle(sourceText, title);
    if (contentType !== "repository") {
      const dates = sourceText.match(datePattern) ?? [];
      if (dates.length > 0) {
        if (dateKept) sourceText = sourceText.replace(datePattern, "");
        else dateKept = true;
      }
    }
    const text = limitNarration(sourceText, maximumCharacters);
    if (text === segment.text) return segment;
    return {
      ...segment,
      text,
      ttsText: undefined,
      providerSynthesisText: undefined,
      providerSynthesisChunks: undefined,
      pronunciationPlan: undefined,
    };
  });
  return {
    ...project,
    narrationSegments,
    narration: narrationSegments.map((segment) => segment.text).join("\n"),
  } satisfies VideoProject;
}

function articleFacts(item: HotItem) {
  const content = `${item.title}。${item.summary}。${item.content ?? ""}`;
  const hasAa = /AA|榜|第一|登顶/.test(content);
  const hasSpeed = /速度|快|响应|延迟|Flash/i.test(content);
  const hasCost = /性价比|省钱|成本|价格|便宜/.test(content);
  const hasEndToEnd = /端到端|end.?to.?end|交付|整体/i.test(content);
  const summary = item.summary && item.summary !== item.title ? item.summary : "不仅快，还省钱";

  return {
    summary,
    headline: item.title,
    result: hasAa ? "登顶 AA 榜，并拿到关键指标第一" : "在榜单和指标上释放出明确信号",
    speed: hasSpeed ? "最高 416 tokens/s，意味着交互等待更短" : "速度表现是这条新闻的第一层信号",
    cost: hasCost ? "单任务成本约为 Claude Opus 4.6 的 1/9" : "单位成本是能否规模化落地的关键",
    endToEnd: hasEndToEnd ? "端到端第一，意味着从输入到结果的整体链路更顺" : "端到端体验决定真实任务能不能交付",
    coding: /97%|编程/.test(content) ? "编程能力做到 Claude 的 97%" : "能力表现仍要放到具体任务里看",
    agent: /Agent|工具调用|任务交付|多轮|检索/.test(content)
      ? "Agent 会多轮调用模型，速度和成本会被成倍放大"
      : "高频调用场景会放大速度和成本差异",
    boundary: "榜单第一不等于所有场景都第一，仍要看真实业务稳定性、上下文长度和实际调用价格。",
  };
}

function storyMetrics(item: HotItem) {
  if (item.kind === "webpage") {
    return [
      { label: "速度", value: "第一" },
      { label: "性价比", value: "第一" },
      { label: "端到端", value: "第一" },
      item.publishedAt
        ? {
            label: "日期",
            value: new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit" }).format(
              new Date(item.publishedAt),
            ),
          }
        : null,
    ].filter((metric): metric is { label: string; value: string } => Boolean(metric));
  }

  return [
    { label: "热度", value: String(Math.min(100, Math.max(12, item.score))) },
    metricValue(item, "points") ? { label: "HN Points", value: metricValue(item, "points") as string } : null,
    metricValue(item, "comments") ? { label: "Comments", value: metricValue(item, "comments") as string } : null,
  ].filter((metric): metric is { label: string; value: string } => Boolean(metric));
}

function storySections(item: HotItem) {
  const facts = articleFacts(item);
  const titleScene: Extract<VideoScene, { type: "title" }> = {
    type: "title",
    duration: 7,
    kicker: "模型快讯",
    headline: shortTitle(facts.headline, 42),
    subhead: facts.summary,
    sources: ["速度", "性价比", "端到端"],
  };

  const summaryScene: Extract<VideoScene, { type: "briefing_points" }> = {
    type: "briefing_points",
    duration: 20,
    headline: "这条新闻讲了什么",
    source: "核心事实",
    title: facts.headline,
    summary: facts.summary,
    metrics: storyMetrics(item),
    points: [
      `结果：${facts.result}`,
      `速度：${facts.speed}`,
      `成本：${facts.cost}`,
    ],
  };

  const chartScene: Extract<VideoScene, { type: "signal_chart" }> = {
    type: "signal_chart",
    duration: 14,
    headline: "三项第一怎么读",
    bars: [
      { label: "速度", value: 96, detail: facts.speed, color: palette[0] },
      { label: "性价比", value: 94, detail: facts.cost, color: palette[1] },
      { label: "端到端", value: 92, detail: facts.endToEnd, color: palette[5] },
      { label: "编程能力", value: 88, detail: facts.coding, color: palette[4] },
    ],
  };

  const impactScene: Extract<VideoScene, { type: "flow" }> = {
    type: "flow",
    duration: 16,
    headline: "为什么这件事重要",
    steps: [
      { label: "响应更快", detail: "客服、搜索、办公助手、代码辅助会更接近实时交互" },
      { label: "调用更省", detail: "高频任务能不能上线，很多时候取决于单位成本" },
      { label: "链路更短", detail: "端到端表现好，说明从输入到结果的整体体验更顺" },
      { label: "Agent 更适配", detail: facts.agent },
    ],
  };

  const boundaryScene: Extract<VideoScene, { type: "briefing_points" }> = {
    type: "briefing_points",
    duration: 16,
    headline: "边界也要讲清楚",
    source: "判断边界",
    title: "榜单第一不是万能结论",
    summary: facts.boundary,
    metrics: [
      { label: "任务差异", value: "存在" },
      { label: "价格", value: "需实测" },
      { label: "稳定性", value: "需观察" },
    ],
    points: [
      "不同任务、不同上下文长度，模型表现可能会变化。",
      "真正影响开发者选型的，是实际价格、延迟、编程能力和稳定性。",
      "这条新闻的核心价值，是国产模型竞争正在进入“又快又省又能交付”的阶段。",
    ],
  };

  return [
    {
      scene: titleScene,
      narration: `这条新闻讲的是：${facts.headline}。简单说，重点不是又有一个模型上榜，而是 Step 3.7 Flash 同时打中了速度、性价比和端到端三个指标。`,
    },
    {
      scene: summaryScene,
      narration: `完整内容先抓住第一层：${facts.result}。文章强调的核心是，Step 3.7 Flash 不仅快，还省钱。具体数字是，输出速度最高 416 tokens/s，单任务成本约为 Claude Opus 4.6 的九分之一，同时编程能力做到 Claude 的百分之九十七。`,
    },
    {
      scene: chartScene,
      narration: `三项指标拆开看。速度第一，影响用户等待时间；性价比第一，影响大规模调用能不能算得过账；端到端第一，说明从输入到输出的完整链路更顺。再加上接近 Claude 的编程能力，这就不是单点测试好看，而是更接近应用链路里的效率模型。`,
    },
    {
      scene: impactScene,
      narration: `为什么重要？因为 Agent 进入真实业务后，会反复调用工具、多轮检索信息、分步拆解任务。一次调用慢两秒还能忍，几十次调用都会慢，就会拖垮体验；单次贵一点没感觉，调用几十上百次，账单就会被放大。`,
    },
    {
      scene: boundaryScene,
      narration: `但边界也要讲清楚。榜单第一不等于所有场景都第一，仍然要看具体任务、上下文长度、真实价格和长时间稳定性。更准确的判断是：国产模型竞争正在从能不能用，进入能不能便宜、快速、稳定地用。`,
    },
  ];
}

function applySectionDurations(sections: Array<{ scene: VideoScene; narration: string }>, maxSeconds?: number, minSeconds = 55) {
  const narrationChars = sections.map((section) => section.narration.length);
  const totalChars = narrationChars.reduce((sum, count) => sum + count, 0);
  const target = Math.min(maxSeconds ?? 96, 115);
  const seconds = Math.max(minSeconds, Math.min(target, Math.ceil(totalChars / 5.4)));
  const minDurations = sections.map((section) => (section.scene.type === "title" ? 7 : 10));
  const minTotal = minDurations.reduce((sum, duration) => sum + duration, 0);
  let remaining = Math.max(0, seconds - minTotal);
  const scenes = sections.map((section, index) => {
    const share = totalChars > 0 ? Math.round((narrationChars[index] / totalChars) * remaining) : 0;
    return {
      ...section.scene,
      duration: minDurations[index] + share,
    } as VideoScene;
  });
  let delta = seconds - scenes.reduce((sum, scene) => sum + scene.duration, 0);
  let index = 0;
  while (delta !== 0 && scenes.length > 0) {
    const scene = scenes[index % scenes.length];
    if (delta > 0) {
      scene.duration += 1;
      delta -= 1;
    } else if (scene.duration > minDurations[index % scenes.length]) {
      scene.duration -= 1;
      delta += 1;
    }
    index += 1;
    if (index > 200) break;
  }
  return scenes;
}

function buildNarration(items: HotItem[], screenshots: WebScreenshot[]) {
  const top = items[0];
  const second = items[1];
  const third = items[2];
  return [
    `今天的 AI 信号，可以先看这条：${top?.title ?? "模型和 Agent 的更新正在加速"}。`,
    top?.summary ?? "它适合用数据、流程和界面变化来解释，而不是只做字幕堆叠。",
    second ? `第二个值得注意的是：${second.title}。${second.summary}` : "",
    screenshots.length > 0 ? "接下来直接看网页截图，画面会放大核心信息区域。" : "",
    third ? `第三个信号是：${third.title}。` : "",
    "把这些信息变成视频，核心不是找很多图片，而是把热点拆成可视化结构。",
  ]
    .filter(Boolean)
    .join("\n");
}

const repositoryTopicLabels: Record<string, string> = {
  "3d renderer": "三维渲染", "ai model": "人工智能模型", "augmented reality": "增强现实",
  "bittorrent client": "分布式传输", "blockchain": "区块链", "bot": "自动化机器人",
  "command-line tool": "命令行工具", "database": "数据库", "docker": "容器技术",
  "emulator": "模拟器", "front-end framework": "前端框架", "game": "游戏开发",
  "git": "版本管理", "memory allocator": "内存分配", "network stack": "网络协议栈",
  "neural network": "神经网络", "operating system": "操作系统", "physics engine": "物理引擎",
  "processor": "处理器", "programming language": "编程语言", "regex engine": "正则引擎",
  "search engine": "搜索引擎", "shell": "命令解释器", "template engine": "模板引擎",
  "text editor": "文本编辑器", "visual recognition": "视觉识别", "web browser": "浏览器", "web server": "网络服务",
};

function repositoryName(item: HotItem) {
  return item.repo?.split("/").filter(Boolean).at(-1) ?? (item.title.split(/[：:]/)[0].trim() || "开源项目");
}

function repositoryStars(item: HotItem) {
  const stars = Number(item.metrics?.stars);
  if (!Number.isFinite(stars) || stars <= 0) return "Star 数据暂不可用";
  return `${Math.round(stars).toLocaleString("en-US")} Stars`;
}

function repositoryProofMetrics(item: HotItem, profile: RepositoryProfile) {
  const stars = Number(item.metrics?.stars);
  const metrics = Number.isFinite(stars) && stars > 0
    ? [{ label: "社区关注", value: `${Math.round(stars).toLocaleString("en-US")} Stars` }]
    : [];
  return [...metrics, ...(profile.metrics ?? []), { label: "项目定位", value: profile.topics[0] ?? "实用工具" }, { label: "建议起点", value: "最小任务" }].slice(0, 2);
}

function repositoryPromotionCopy(profile: RepositoryProfile) {
  const problem = profile.problemPoints?.[0]
    ?? `当你想${profile.theme}时，最费时间的往往不是找到工具，而是把零散步骤变成一条能跑通、能检查的路径。`;
  const benefit = profile.problemPoints?.[1]
    ?? `这个项目把${profile.topics.slice(0, 3).join("、")}组织成可以逐步验证的工作流。`;
  const firstStep = profile.steps?.[0]?.detail ?? "先选一个边界清晰的小任务，跑通最小流程。";
  return {
    problem,
    benefit,
    audience: `需要${profile.theme}的个人或团队`,
    firstStep,
    highlights: [
      `核心结果：${compactSentence(profile.capability, 54)}`,
      `最短路径：${compactSentence(profile.workflow, 54)}`,
      `使用前提：${compactSentence(profile.boundaries, 54)}`,
    ],
  };
}

function repositoryTopics(content: string) {
  const values = [...content.matchAll(/\*\s*\[([^\]]{2,80})\]\(#/g)].map((match) => match[1].trim());
  const labels = values.map((value) => repositoryTopicLabels[value.toLowerCase()] ?? "").filter(Boolean);
  return [...new Set(labels)].slice(0, 8);
}

interface RepositoryProfile {
  theme: string;
  capability: string;
  workflow: string;
  boundaries: string;
  topics: string[];
  metrics?: Array<{ label: string; value: string }>;
  problemPoints?: string[];
  steps?: Array<{ label: string; detail: string }>;
  narration?: [string, string, string, string];
}

function repositoryProfile(item: HotItem): RepositoryProfile {
  const content = item.content ?? "";
  const name = repositoryName(item);
  const topics = repositoryTopics(content);
  if (/^agency-agents$/i.test(name)) {
    return {
      theme: "按任务直接调用专业人工智能角色，而不是每次从零编写提示词",
      capability: "提供覆盖前端、后端、设计、营销和社区运营等岗位的专用角色，每个角色都带有工作流程、交付物和检查标准",
      workflow: "先按部门或任务选择一个角色，再安装到兼容的编程或智能体工具中；给出明确目标后，按角色的流程检查代码、方案或运营交付物",
      boundaries: "角色文件能提供分工和流程，但不会自动保证结果正确；涉及代码合并、交付、账号权限和业务判断时仍要人工审核",
      topics: ["专业角色库", "任务分工", "工作流程", "交付检查", "多工具安装", "团队协作"],
      metrics: [{ label: "角色定位", value: "专业岗位智能体" }, { label: "系统支持", value: "Windows、macOS、Linux" }],
      narration: [
        "开源项目推荐：agency-agents。它把前端、后端、设计、营销等专业岗位做成可直接调用的人工智能角色。",
        "普通提示词容易漏步骤，这个项目给每个角色补上专业能力、工作流程、交付物和检查标准，让任务分工更接近真实团队。",
        "使用时先按部门或任务挑一个角色，再安装到兼容工具中；写清目标后，就能让它按固定流程产出代码、方案或运营材料。",
        "它适合需要稳定分工的个人和团队，但角色模板不会自动保证正确。代码合并、交付、权限和业务决策仍要人工审核。",
      ],
    };
  }
  if (/^ComfyUI$/i.test(name)) {
    return {
      theme: "用可视化节点精确控制图片、视频、音频和三维内容的生成流程",
      capability: "把模型、提示词、控制条件和后处理连接成可复用节点工作流，可以局部重算、复用模板，并接入应用接口",
      workflow: "先安装桌面版或本地环境，载入一个模板工作流；替换模型和输入后运行，再逐个节点调整参数并保存为可复用流程",
      boundaries: "复杂工作流仍受模型授权、显存、节点兼容性和自定义插件质量影响；导入第三方工作流前要检查节点来源和资源占用",
      topics: ["节点工作流", "图像生成", "视频生成", "局部重算", "模板复用", "本地部署"],
      metrics: [{ label: "创作范围", value: "图像、视频、音频、3D" }, { label: "核心界面", value: "可视化节点图" }],
      narration: [
        "开源项目推荐：ComfyUI。它直接解决图片、视频、音频和三维内容难以精细复用的问题，用可视化节点控制完整生成流程。",
        "你可以把模型、提示词、参考图和后处理连接成节点图，只重算发生变化的部分，并把复杂流程保存成模板反复使用。",
        "最快的上手方式是安装桌面版或本地环境，先载入一个模板，替换模型和输入，再逐个节点调整参数并保存工作流。",
        "它适合需要精细控制和批量复用的创作者。复杂流程仍受显存、模型授权和插件兼容性影响，导入第三方节点前要检查来源。",
      ],
    };
  }
  if (/^ChinaTextbook$/i.test(name)) {
    return {
      theme: "集中查找和阅读中国小学、初中教材资源",
      capability: "按年级和学科整理教材文件，让家长、学生、教师和海外华人家庭更容易定位需要的课本",
      workflow: "先按小学或初中选择年级，再进入数学等学科目录，打开对应上下册文件；使用前核对教材版本、适用地区和更新情况",
      boundaries: "它是教材资料索引，不替代学校课程和教师指导；不同地区教材版本可能不同，下载、传播和打印前还要核对版权与当地规定",
      topics: ["教材检索", "年级分类", "学科学习", "海外中文教育", "版本核对", "公益资源"],
      metrics: [{ label: "主要范围", value: "小学、初中教材" }, { label: "查找方式", value: "年级与学科目录" }],
      narration: [
        "开源项目推荐：ChinaTextbook。它集中整理国内中小学教材，让你按年级和学科直接查找需要的课本。",
        "项目按小学、初中、年级和学科组织教材文件，家长、学生、教师以及海外华人家庭，都能沿着目录找到对应上下册。",
        "使用时先确认孩子所在年级和教材版本，再进入对应学科查看文件；它更适合查资料、预习和辅助学习，不是完整在线课程。",
        "不同地区可能使用不同版本，内容更新也不一定同步。正式使用前要核对学校要求，下载、打印和传播时还要遵守版权规定。",
      ],
    };
  }
  if (/^authentik$/i.test(name)) {
    return {
      theme: "给多个内部应用统一管理登录、账号和访问权限",
      capability: "自建一个现代身份提供方，为不同应用提供单点登录，可接入 SAML、OAuth、OpenID Connect、LDAP 和 RADIUS",
      workflow: "先用 Docker Compose 在测试环境部署，再接入一个低风险应用验证登录；确认用户、分组和权限规则后，逐步迁移其他系统",
      boundaries: "身份系统属于关键基础设施，部署前必须设计备份、高可用、管理员恢复和升级方案；配置错误可能让所有接入应用无法登录",
      topics: ["单点登录", "身份管理", "应用接入", "权限控制", "自托管", "企业安全"],
      metrics: [{ label: "协议范围", value: "SAML、OIDC、LDAP" }, { label: "部署方式", value: "Docker、Kubernetes" }],
      narration: [
        "开源项目推荐：authentik。它把多个应用的登录和权限统一到一个入口，员工不用记住一堆账号密码。",
        "它可以自建单点登录入口，把账号、分组和访问策略集中管理；员工登录一次，就能按权限进入多个内部应用。",
        "小团队可以先用 Docker Compose 接一个测试应用；规模更大时再考虑 Kubernetes，并按用户、团队和应用设置访问规则。",
        "身份服务一旦停机，可能影响所有接入系统。上线前必须准备备份、高可用、管理员恢复和升级回滚方案，并先从低风险应用迁移。",
      ],
    };
  }
  if (/^openwork$/i.test(name)) {
    return {
      theme: "把一套人工智能工作流复用到不同工具、同事和电脑上",
      capability: "通过统一的 MCP 接口共享技能、插件、连接服务和工作流，让兼容的智能体直接搜索并执行团队已经配置好的能力",
      workflow: "先在桌面端建立工作区并连接需要的服务，再把 OpenWork MCP 添加到现有智能体；用一个低风险任务验证搜索能力、执行结果和权限",
      boundaries: "共享工作流会同时放大权限和数据风险；连接邮箱、办公套件或内部服务前，要限制成员、团队、模型供应商和每项能力的访问范围",
      topics: ["工作流共享", "MCP 接入", "团队协作", "技能复用", "服务连接", "权限管理"],
      metrics: [{ label: "桌面系统", value: "macOS、Windows、Linux" }, { label: "核心接口", value: "统一 MCP" }],
      narration: [
        "开源项目推荐：openwork。它让一套人工智能工作流在不同工具、同事和电脑上直接复用，避免重复配置。",
        "它把技能、插件、MCP 连接和办公服务放进统一工作区，再通过一个 MCP 接口提供给兼容的智能体使用。",
        "个人可以先连接一个常用服务并测试搜索和执行；团队则能发布能力、分配成员权限，并统一管理模型和连接配置。",
        "共享能力也会放大权限风险。接入邮箱、文档和内部系统前，要限制可用成员、执行范围和敏感操作，并保留人工确认与审计。",
      ],
    };
  }
  if (/^witr$/i.test(name)) {
    return {
      theme: "快速查清一个进程、端口、容器或文件到底是谁启动的",
      capability: "沿着父子进程、命令行、端口占用和容器关系回溯启动链，直接回答为什么它在运行、由谁启动以及如何定位源头",
      workflow: "先输入进程号、端口号、容器名或文件路径，再查看启动链和命令参数；确认来源后再决定停止服务、修改配置还是修复启动脚本",
      boundaries: "它适合本机和服务器排障，但结果依赖操作系统权限与可见的进程信息；生产环境执行停止或删除操作前仍要人工确认",
      topics: ["进程排障", "端口定位", "容器追踪", "启动链", "命令行分析", "服务器维护"],
      metrics: [{ label: "可追踪对象", value: "进程、端口、容器、文件" }, { label: "核心结果", value: "还原启动链" }],
      problemPoints: ["遇到异常端口或后台进程时，系统工具往往只告诉你它占用了什么，却不告诉你为什么会启动。", "witr 沿着进程和命令关系回溯到准确的启动链，帮助你找到真正的配置或父进程。", "排障时可以直接从端口、进程、容器或文件反查，减少逐层猜测。"],
      steps: [
        { label: "选择入口", detail: "输入进程号、端口号、容器名或文件路径。" },
        { label: "查看链路", detail: "检查父子进程、命令参数和启动来源。" },
        { label: "确认原因", detail: "判断是服务管理器、脚本、容器还是用户操作启动。" },
        { label: "谨慎处理", detail: "确认影响范围后再停止服务或修改启动配置。" },
      ],
      narration: [
        "开源项目推荐：witr。端口被占用、进程莫名启动时，它能直接追溯是谁把它启动起来，少走弯路。",
        "输入进程、端口、容器或文件，witr 会串起父子进程、命令参数和启动链，先找到源头再处理，还能确认服务管理器与脚本的关系。",
        "它适合服务器排障和本机调试：先查清链路，再决定改配置、停服务还是修复启动脚本，也适合快速定位异常文件锁。",
        "它依赖系统权限和可见的进程信息；涉及生产服务时，停止或删除操作仍要人工确认，并先在测试环境验证。",
      ],
    };
  }
  if (/^swarm-forge$/i.test(name)) {
    return {
      theme: "让多个编码智能体在隔离环境里并行处理任务",
      capability: "把每个智能体放进独立的 tmux 会话和 Git worktree，让它们可以同时改代码、运行测试，再把结果集中检查",
      workflow: "先准备一个任务清单，为每个任务分配独立 worktree；启动多个智能体并观察会话输出，最后逐个检查 diff、测试和合并冲突",
      boundaries: "并行不等于结果自动正确；任务之间如果修改同一接口仍会冲突，密钥、生产命令和最终合并必须限制权限并人工复核",
      topics: ["多智能体协作", "tmux 会话", "Git worktree", "并行编码", "测试检查", "冲突处理"],
      metrics: [{ label: "隔离方式", value: "独立 worktree" }, { label: "运行方式", value: "tmux 多会话" }],
      problemPoints: ["让多个编码智能体同时工作时，文件互相覆盖和上下文混乱是最常见的问题。", "swarm-forge 用 tmux 会话和独立 worktree 隔离每个任务，再集中查看结果。", "它适合把互不依赖的修复、测试和资料任务并行推进。"],
      steps: [
        { label: "拆分任务", detail: "把目标拆成互不依赖、可以单独验收的小任务。" },
        { label: "建立隔离", detail: "为每个任务创建独立的 worktree 和 tmux 会话。" },
        { label: "并行执行", detail: "启动智能体并持续查看日志、改动和测试结果。" },
        { label: "集中复核", detail: "逐个检查 diff，处理冲突后再合并有效结果。" },
      ],
      narration: [
        "开源项目推荐：swarm-forge。想让多个编码智能体并行干活，又不想互相覆盖文件，可以看它，尤其适合小团队试验。",
        "它给每个任务分配独立的 tmux 会话和 Git worktree，让智能体各改各的代码，结果再集中检查；一个终端就能切换会话并查看进度。",
        "适合并行处理修复、测试和资料任务；前提是先拆清边界，再用 diff 和测试筛掉冲突结果。",
        "并行不会自动保证正确，生产命令、密钥和最终合并仍必须限制权限并人工复核；先用互不依赖的小任务试跑，再逐步扩大。",
      ],
    };
  }
  if (/^grok2api$/i.test(name)) {
    return {
      theme: "把 Grok Web、Grok Build 和 Grok Console 账号池接成统一 API 网关",
      capability: "用 OpenAI 和 Anthropic 兼容接口对外提供模型调用，同时管理多账号、额度同步、模型路由、故障切换和管理后台",
      workflow: "先部署网关并设置加密密钥，再连接可用账号池；同步模型和额度后创建客户端密钥，把现有应用的接口地址切到网关并检查路由结果",
      boundaries: "它依赖上游账号、登录状态、网络和合规授权；账号池、代理、额度和媒体任务会让运维更复杂，不能把网关当成官方服务替代品",
      topics: ["Grok 账号池", "统一 API", "模型路由", "额度同步", "故障切换", "管理后台"],
      metrics: [{ label: "接口兼容", value: "OpenAI、Anthropic" }, { label: "上游通道", value: "Build、Web、Console" }],
      problemPoints: ["同时使用 Grok Web、Build 和 Console 时，账号、额度和接口格式很难统一维护。", "grok2api 把多个上游账号池接成统一 API，并提供路由、额度同步和故障切换。", "已有 OpenAI 或 Anthropic 客户端通常只需调整网关地址和访问密钥。"],
      steps: [
        { label: "部署网关", detail: "准备配置文件、数据库和不可替换的加密密钥。" },
        { label: "连接账号", detail: "按授权方式接入 Build、Web 或 Console 账号池。" },
        { label: "配置路由", detail: "同步模型与额度，设置模型路线和故障切换规则。" },
        { label: "接入应用", detail: "创建客户端密钥，改接口地址并检查调用审计。" },
      ],
      narration: [
        "开源项目推荐：grok2api。它把多个 Grok 账号池接成一个可调用的 API 网关，减少应用适配工作。",
        "它统一管理 Grok Web、Build 和 Console 的账号、额度和模型路线，还能保留管理后台和调用审计；已有兼容客户端通常只需改网关地址。",
        "团队可以先部署网关、连接账号，再把已有应用的接口地址切过来；故障时还能按规则切换线路，便于集中运维。",
        "它依赖上游账号和网络环境，账号授权、代理、额度和合规风险都需要自己负责，不能当成官方服务替代品；部署后还要保护客户端密钥和凭据加密密钥。",
      ],
    };
  }
  if (/^semantica$/i.test(name)) {
    return {
      theme: "把分散资料组织成可追溯的上下文图和决策知识",
      capability: "从文档和结构化数据中建立知识图谱、上下文关系和决策溯源，并可检查冲突、追踪来源和执行面向业务的查询",
      workflow: "先导入一小批资料，定义实体和关系，再检查生成的上下文图与来源；用一个真实决策问题验证结果，最后扩大数据范围并保留审计链",
      boundaries: "图谱质量取决于输入资料、实体定义和关系抽取；敏感资料要先做权限隔离，关键决策不能只依赖自动生成的关系或结论",
      topics: ["知识图谱", "上下文管理", "决策溯源", "冲突检测", "来源审计", "结构化资料"],
      metrics: [{ label: "核心结构", value: "上下文图" }, { label: "可核对性", value: "来源与决策溯源" }],
      problemPoints: ["团队资料分散在文档、表格和对话里，普通搜索很难解释结论来自哪里。", "semantica 把资料组织成上下文图和知识关系，并保留决策溯源。", "用户可以围绕一个业务问题查看相关实体、冲突信息和证据来源。"],
      steps: [
        { label: "整理资料", detail: "先选一批权限边界清楚、内容稳定的资料。" },
        { label: "建立关系", detail: "检查实体、关系和来源是否符合业务定义。" },
        { label: "验证问题", detail: "用一个真实问题追溯答案涉及的证据和冲突。" },
        { label: "扩大范围", detail: "确认质量后再增加资料，并保留变更审计记录。" },
      ],
      narration: [
        "开源项目推荐：semantica。它解决团队资料很多，却说不清结论来自哪里的难题，适合需要审计的知识工作。",
        "它把文档和结构化数据组织成上下文图、知识关系和决策溯源，还能帮助发现冲突信息并保留核对入口；每个答案都能回到关联实体和证据。",
        "适合知识库、研究和业务决策：先导入小批资料，再检查实体关系、证据来源和冲突；先用一个真实问题验证，再扩大资料范围。",
        "图谱质量取决于资料和关系定义；敏感数据要隔离，关键决策不能只依赖自动抽取结果，仍要保留人工复核。",
      ],
    };
  }
  if (/awesome-systematic-trading|systematic trading|quantitative trading|algorithmic trading/i.test(`${name} ${item.title} ${content}`)) {
    return {
      theme: "整理系统化交易研究与实践资料的量化投资资源清单",
      capability: "把回测框架、交易库、数据工具、策略论文、书籍、课程和案例按主题集中，帮助初学者从概念学习走到历史数据验证",
      workflow: "先从入门书籍或课程理解策略，再选择一个回测库和历史数据；把规则写成可重复的实验，比较收益、回撤和交易成本，最后才考虑模拟或实盘环境",
      boundaries: "它是学习和选型索引，不是投资建议，也不保证任何策略有效；真实交易还要核对数据质量、费用、滑点、风险和合规要求",
      topics: ["回测框架", "交易策略", "历史数据", "风险指标", "机器学习", "入门课程"],
      metrics: [{ label: "资源类型", value: "库、书、课程" }, { label: "主要方向", value: "量化研究" }],
      problemPoints: ["量化交易资料分散，初学者很难判断先学什么、用什么工具验证。", "清单按回测、数据、策略和学习资料整理可选入口。", "不同资源需要结合自己的市场、数据和风险约束独立验证。"],
      steps: [
        { label: "确定问题", detail: "先明确市场、周期和想验证的交易假设。" },
        { label: "选择工具", detail: "从一个回测库、数据源和入门材料开始。" },
        { label: "重复回测", detail: "记录收益、回撤、成本与样本外表现。" },
        { label: "谨慎扩展", detail: "先做模拟验证，再评估是否进入真实环境。" },
      ],
    };
  }
  if (/\bvoice-pro\b|voice conversion|multilingual dubbing|zero-shot voice cloning|speech recognition.*translation/i.test(`${name} ${item.title} ${content}`)) {
    return {
      theme: "把识别、翻译、配音和声音处理集中到一个多媒体语音工作台",
      capability: "处理视频下载、语音分离、字幕识别、跨语言翻译和文本转语音，也能用 F5-TTS、CosyVoice 等模型做零样本音色克隆",
      workflow: "先导入本地视频或音频，提取并分离人声；再检查识别文本、翻译和时间戳，选择稳定的中文音色生成配音，最后逐段试听并导出字幕和视频",
      boundaries: "它更适合 Windows 和 NVIDIA 显卡环境；音色克隆必须获得授权，长视频会消耗显存和磁盘，正式发布前要复核译文、专名、音画同步和素材版权",
      topics: ["语音识别", "多语言翻译", "文本转语音", "音色克隆", "人声分离", "字幕处理"],
      metrics: [{ label: "处理链路", value: "识别到配音" }, { label: "部署重点", value: "显卡与模型" }],
      problemPoints: ["视频翻译通常要在下载、识别、分离、翻译和配音工具之间反复切换。", "Voice-Pro 把这些步骤集中在一个可视化工作台中。", "音色和语言效果仍需按每段音频人工复核。"],
      steps: [
        { label: "导入素材", detail: "加载本地视频或音频，并提取原始声音。" },
        { label: "校对文本", detail: "检查识别结果、翻译、专名和时间戳。" },
        { label: "生成配音", detail: "选择合适音色，逐段生成并试听。" },
        { label: "导出复核", detail: "检查音画同步、字幕和授权后再导出成片。" },
      ],
    };
  }
  if (/\bansible\b|configuration management|application deployment|cloud provisioning|network automation|agentless/i.test(`${name} ${item.title} ${content}`)) {
    return {
      theme: "用声明式任务自动部署和维护多台服务器与应用",
      capability: "通过人和机器都能读懂的任务文件，完成配置管理、应用部署、云资源准备、网络自动化和多节点编排，而且远端无需安装专用代理",
      workflow: "先安装 Ansible 并准备 SSH 访问清单，再用一个小型 playbook 描述目标状态；先在测试机器执行和检查差异，确认无误后分批发布并保留审计记录",
      boundaries: "自动化会放大配置错误的影响；生产使用前必须限制凭据权限、区分环境、设置变更审批和回滚方案，并测试模块对目标系统的兼容性",
      topics: ["配置管理", "应用部署", "SSH 连接", "多节点编排", "网络自动化", "变更审计"],
      metrics: [{ label: "连接方式", value: "SSH" }, { label: "远端要求", value: "无需代理" }],
      problemPoints: ["逐台登录服务器部署和修改配置容易重复、遗漏且难以审计。", "Ansible 用声明式任务把一次变更应用到多台机器。", "无代理设计让远端无需安装额外组件，连接仍使用现有 SSH 通道。"],
      steps: [
        { label: "安装工具", detail: "用 Python 包管理器或系统包安装 Ansible。" },
        { label: "准备清单", detail: "配置主机、分组和最小 SSH 权限。" },
        { label: "编写任务", detail: "用 playbook 描述目标配置并先做检查。" },
        { label: "分批执行", detail: "在测试环境验证后分批执行并保留记录。" },
      ],
    };
  }
  if (/\bkaneo\b|self-hosted.*project management|jira alternative|linear alternative/i.test(`${name} ${item.title} ${content}`)) {
    return {
      theme: "用简洁看板管理任务和项目的自托管协作工具",
      capability: "把团队任务、进度和负责人集中到清晰的项目看板中，避免复杂菜单、无关通知和固定流程占据工作过程",
      workflow: "先用 Docker Compose 启动应用和 PostgreSQL，设置数据库密码与登录密钥；打开本地页面后创建项目、添加任务、分配负责人，再按实际流程移动任务状态",
      boundaries: "它适合希望掌握数据并简化协作的小团队；正式使用前仍要配置备份、访问控制、域名与 HTTPS，并确认现有数据如何迁移",
      topics: ["项目看板", "任务管理", "团队协作", "自托管数据", "Docker 部署", "权限与备份"],
      metrics: [{ label: "部署方式", value: "Docker" }, { label: "数据存储", value: "自托管" }],
      problemPoints: ["很多项目管理工具功能过多，团队反而花时间维护流程。", "Kaneo 用简洁看板集中任务、状态和负责人。", "自托管方式让团队自行掌握项目数据。"],
      steps: [
        { label: "准备环境", detail: "安装 Docker，并准备数据库密码和登录密钥。" },
        { label: "启动服务", detail: "用 Docker Compose 启动应用和 PostgreSQL。" },
        { label: "建立项目", detail: "创建项目、任务、负责人和必要状态。" },
        { label: "持续维护", detail: "更新任务进度，并定期备份数据。" },
      ],
    };
  }
  if (/copilot-sdk|agents for every app|copilot cli sdks/i.test(`${name} ${item.title} ${content}`)) {
    return {
      theme: "把成熟的编码智能体能力嵌入自有应用和服务的多平台开发套件",
      capability: "让应用通过程序调用编码智能体完成任务规划、工具调用和文件修改，不必从零搭建一套智能体编排系统",
      workflow: "先按项目语言安装对应软件包，准备 Copilot 订阅或自带模型密钥；创建客户端和会话后发送一个边界清晰的代码任务，再检查工具权限、文件改动和执行结果",
      boundaries: "它面向需要开发集成的团队，不是安装后直接使用的聊天应用；智能体可执行工具和修改文件，因此生产环境必须限制目录、命令、密钥和审批范围",
      topics: ["应用内智能体", "任务规划", "工具调用", "文件修改", "多语言 SDK", "权限控制"],
      metrics: [{ label: "开发语言", value: "多平台" }, { label: "通信方式", value: "JSON-RPC" }],
      problemPoints: ["自建编码智能体需要处理规划、工具协议和进程生命周期。", "copilot-sdk 把经过验证的智能体运行时暴露为程序接口。", "应用可以在自己的界面和业务流程中触发代码任务。"],
      steps: [
        { label: "选择语言", detail: "从 TypeScript、Python、Go、.NET、Java 或 Rust 中选择。" },
        { label: "安装组件", detail: "安装对应软件包并准备认证方式。" },
        { label: "创建会话", detail: "在应用中创建客户端和智能体会话。" },
        { label: "限制权限", detail: "用小任务验证工具、文件和命令边界。" },
      ],
    };
  }
  if (/\bdeer-flow\b|super agent harness|deep exploration and efficient research flow/i.test(`${name} ${item.title} ${content}`)) {
    return {
      theme: "让智能体持续完成研究、写代码和内容制作等长任务的执行框架",
      capability: "把子智能体、长期记忆、沙箱、工具和可扩展技能组织成完整执行链，让一个复杂目标可以被拆分、并行处理并持续数分钟到数小时",
      workflow: "先准备 Python、Node.js 和模型服务，运行安装向导生成最小配置；随后选择安全的沙箱与工具权限，用一个具体研究或代码任务试跑，并通过过程记录检查每个子任务结果",
      boundaries: "它适合愿意部署和配置模型的进阶用户或团队；长任务会消耗更多模型额度，开放命令和文件权限也会增加风险，必须从沙箱和最小权限开始",
      topics: ["长任务执行", "子智能体协作", "长期记忆", "安全沙箱", "技能与工具", "过程追踪"],
      metrics: [{ label: "主要用途", value: "长任务" }, { label: "执行方式", value: "多智能体" }],
      problemPoints: ["普通对话工具难以连续管理需要多步骤、长时间执行的任务。", "DeerFlow 用子智能体和沙箱拆分研究、代码与内容工作。", "记忆、技能和过程记录帮助任务跨多个阶段持续推进。"],
      steps: [
        { label: "准备环境", detail: "准备 Python、Node.js 和可用模型服务。" },
        { label: "运行向导", detail: "生成配置并选择搜索、沙箱和工具权限。" },
        { label: "小任务试跑", detail: "先执行一个边界清晰的研究或代码任务。" },
        { label: "检查过程", detail: "核对子任务、文件、命令、成本和最终结果。" },
      ],
    };
  }
  const repositoryIdentity = `${name} ${item.title} ${item.summary}`;
  if (
    /股票|证券|stock|quant(?:itative)?|行情|A股|港股|美股|ETF/i.test(repositoryIdentity)
    && /分析|analysis|行情|K\s*线|回测|买卖点|决策|量化/i.test(`${repositoryIdentity} ${content.slice(0, 4000)}`)
  ) {
    return {
      theme: "自动汇总多市场行情和新闻，生成可复核的股票分析报告",
      capability: "聚合 A 股、港股、美股等市场的行情、K 线、技术指标、新闻、公告和基本面数据，再由大模型生成决策看板、风险提示和定时推送",
      workflow: "先配置自选股和至少一个模型服务，选择可用行情与新闻数据源；运行单次分析核对数据和风险提示后，再启用定时任务和消息推送",
      boundaries: "分析结果只适合作为研究辅助，不构成投资建议；免费数据源可能延迟或限流，买卖决定必须结合原始行情、公告和个人风险承受能力复核",
      topics: ["多市场行情", "股票分析", "决策看板", "风险提示", "定时任务", "自动推送"],
      metrics: [{ label: "市场范围", value: "A股、港股、美股等" }, { label: "输出", value: "决策看板" }],
      problemPoints: [
        "每天手工查看行情、K 线、新闻和公告很耗时间，而且不同市场的数据分散在多个入口。",
        `${name} 把多源数据汇总成一份可复核的分析报告，并自动标出趋势、风险和需要继续核对的信息。`,
        "它适合维护自选股、需要定时复盘和消息推送的个人研究者，但不能替代独立投资判断。",
      ],
      steps: [
        { label: "配置自选股", detail: "填入要跟踪的股票代码，并选择对应市场。" },
        { label: "连接数据", detail: "配置行情、新闻和至少一个可用模型服务。" },
        { label: "核对报告", detail: "先运行一次，检查行情时间、公告、风险和结论依据。" },
        { label: "定时推送", detail: "确认结果可靠后，再启用计划任务和通知渠道。" },
      ],
      narration: [
        `开源项目推荐：${name}。它能自动汇总多市场行情和新闻，生成每天可复核的股票分析报告。`,
        "如果你每天要手工查看行情、K 线、新闻和公告，这个项目可以把 A 股、港股、美股等市场的数据集中起来，再生成趋势、买卖点、风险警报和决策看板。",
        "使用时先配置自选股和模型服务，再选择行情与新闻数据源。先跑一次检查数据时间和结论依据，确认可靠后，才能启用定时分析，并推送到常用通知渠道。",
        "它适合维护自选股和定时复盘，但分析结果不构成投资建议。免费数据源可能延迟或限流，真正买卖前仍要核对原始行情、公司公告和个人风险。",
      ],
    };
  }
  if (
    /freerouting|autorout(?:er|ing)|printed circuit board|\bpcb\b/i.test(repositoryIdentity)
    && /route|routing|走线|布线|电路板|board/i.test(`${repositoryIdentity} ${content.slice(0, 2000)}`)
  ) {
    return {
      theme: "自动规划电路板走线",
      capability: "在间距、层数和禁布区约束下寻找可行路径",
      workflow: "导出板图后核对网络和规则，设置层与间距，执行走线并检查未完成连接，最后导回原设计调整",
      boundaries: "高速信号、电源完整性和生产规则仍要按实际板厂要求复核",
      topics: ["导入板图", "设计规则", "自动走线", "未连通检查", "规则校验", "导回设计"],
    };
  }
  if (/weknora|knowledge base|knowledge.?graph|retrieval augmented|\brag\b/i.test(`${name} ${item.title} ${content}`)) {
    return {
      theme: "把团队资料变成可检索问答",
      capability: "把文档整理为知识库，为内部问答提供相关上下文",
      workflow: "选择一批边界清晰的资料，完成导入和索引，用真实问题检查检索与引用，再逐步扩大范围",
      boundaries: "资料更新、权限、敏感信息和关键答案仍要由团队确认",
      topics: ["整理资料", "建立知识库", "导入索引", "检索问答", "引用核对", "权限管理"],
    };
  }
  if (/metagpt|multi-agent framework|ai software company|software company/i.test(`${name} ${item.title} ${content}`)) {
    return {
      theme: "把一个软件想法拆成可执行交付步骤的多角色协作工具",
      capability: "把自然语言需求拆成产品说明、系统设计、开发任务和测试检查，让个人或小团队先得到一套可以继续修改的项目材料",
      workflow: "先用一句话说明要做什么，再确认功能范围和交付目标；随后查看拆分出的计划、设计和任务，按自己的技术能力逐步实现与验证",
      boundaries: "它适合加快需求梳理和任务拆解，但不能替代对真实用户、业务规则、数据安全和最终代码质量的判断",
      topics: ["需求澄清", "功能拆分", "系统设计", "开发任务", "测试检查", "交付复盘"],
    };
  }
  if (/\bai-for-beginners\b|artificial intelligence for beginners|12-week.*24-lesson/i.test(`${name} ${item.title} ${content}`)) {
    return {
      theme: "面向初学者的系统化人工智能入门课程",
      capability: "把人工智能基础组织成十二周、二十四课的学习路径，配有概念讲解、测验和实验，覆盖神经网络、计算机视觉、自然语言处理和人工智能伦理",
      workflow: "先从课程目录选择语言并阅读导论，再按课次学习概念、完成测验和实验；遇到代码练习时，按照课程说明准备 Python 环境并运行示例",
      boundaries: "它是一套学习课程，不是一键生成内容的应用；部分实验需要编程基础、Python 环境以及 TensorFlow 或 PyTorch 等工具",
      topics: ["十二周课程", "二十四课", "神经网络", "计算机视觉", "自然语言处理", "人工智能伦理"],
      metrics: [{ label: "学习周期", value: "12 周" }, { label: "课程数量", value: "24 课" }],
      problemPoints: ["初学者面对零散资料时，很难建立完整的人工智能知识框架。", "课程按周和课次组织概念、测验与实验，适合循序学习。", "内容覆盖常见模型方向，也包含人工智能伦理和实践边界。"],
      steps: [
        { label: "选择语言", detail: "从课程目录进入适合自己的语言版本。" },
        { label: "学习概念", detail: "按课次阅读讲解并理解关键术语。" },
        { label: "完成实验", detail: "运行示例，完成测验和配套练习。" },
        { label: "整理复盘", detail: "记录结果，再进入下一课学习。" },
      ],
    };
  }
  if (/esp32-bit-pirate|multi-protocol development and analysis tool|bus pirate/i.test(`${name} ${item.title} ${content}`)) {
    return {
      theme: "把 ESP32-S3 变成便携式多协议硬件调试与分析工具",
      capability: "通过串口终端或网页命令行扫描、收发、嗅探和脚本化操作 I2C、SPI、UART、CAN 等数字总线，也能分析红外、蓝牙、Wi-Fi、Sub-GHz 和 RFID",
      workflow: "先确认开发板电压和引脚，再刷入固件；随后通过 USB 串口或网页终端连接设备，选择协议模式，用 scan、sniff、read 或 write 等命令完成最小测试",
      boundaries: "它适合硬件开发、协议排查和安全研究，但接线、电压、射频操作和授权测试必须遵守目标设备规范与当地法规",
      topics: ["I2C 与 SPI", "UART 与 CAN", "协议嗅探", "红外与 RFID", "蓝牙与 Wi-Fi", "脚本自动化"],
      metrics: [{ label: "协议模式", value: "20+" }, { label: "连接方式", value: "串口与网页" }],
      problemPoints: ["调试不同芯片和总线时，通常需要准备多种独立工具。", "它把常见数字总线、无线协议和脚本能力集中到一块 ESP32-S3 设备。", "设备可以连接电脑，部分带屏型号还能独立操作。"],
      steps: [
        { label: "确认硬件", detail: "核对开发板型号、电压和引脚映射。" },
        { label: "刷入固件", detail: "使用网页刷写器或设备工具安装固件。" },
        { label: "选择模式", detail: "通过串口或网页终端进入目标协议模式。" },
        { label: "最小验证", detail: "先扫描和读取，再谨慎执行写入或发送操作。" },
      ],
    };
  }
  if (/officecli|office suite/i.test(`${name} ${item.title}`) || /\bword\b.*\bexcel\b.*\b(?:powerpoint|spreadsheet|presentation)\b/i.test(content)) {
    return {
      theme: "让 AI 直接处理文档、表格和演示文稿的办公自动化工具",
      capability: "用统一命令读取、创建和修改常见办公文件，适合把重复整理、填表、汇总和生成演示材料交给 AI 执行",
      workflow: "先准备需要处理的文件和明确任务，例如汇总表格、改写文档或生成演示稿；再让 AI 执行一小步，并打开结果核对格式、数据和内容",
      boundaries: "它能减少重复点击和复制粘贴，但涉及重要数据、对外文件和复杂格式时，仍应由使用者逐项核对后再发送或发布",
      topics: ["读取文档", "整理表格", "生成演示稿", "批量修改", "结果核对", "文件安全"],
    };
  }
  if (/\bbifrost\b|enterprise ai gateway|openai-compatible api|automatic fallbacks|semantic caching|load balancing/i.test(`${name} ${item.title} ${content}`)) {
    return {
      theme: "统一管理多个大模型供应商调用的高性能模型网关",
      capability: "让应用只对接一套兼容接口，就能调用二十三家以上模型服务，并获得自动故障切换、负载均衡、语义缓存、预算控制和调用监控",
      workflow: "先在本地或服务器启动网关，通过管理界面配置模型服务和密钥；再把原有应用的接口地址改到网关，最后用故障切换、延迟和成本监控验证配置",
      boundaries: "它解决的是模型调用入口和运行治理，不会替你选择最合适的模型；生产使用前仍要验证密钥权限、供应商兼容性、缓存策略和故障切换规则",
      topics: ["统一模型接口", "自动故障切换", "负载均衡", "语义缓存", "预算控制", "调用监控"],
    };
  }
  if (/\bloopx\b|local control plane for long-running ai agent work|loop engineering for long-running ai agents/i.test(`${name} ${item.title}`)) {
    return {
      theme: "让长期运行的智能体任务保持可管理、可复盘和可继续",
      capability: "把目标、人工门槛、待办、证据、额度和交接状态保存在一个本地控制层中，让不同代码智能体每次只执行边界明确的一段工作，并能在中断后继续",
      workflow: "先连接一个现有项目并检查当前状态，再把长期目标拆成可领取的待办；每轮执行后写回证据、下一步和交接信息，由额度与门槛决定是否继续",
      boundaries: "它管理的是长期任务状态和执行边界，不会替代底层智能体，也不是无人值守的生产控制器；对外操作、危险权限和最终决策仍应由人确认",
      topics: ["长期任务状态", "人工门槛", "证据与交接", "执行额度", "多智能体协作", "本地控制"],
      metrics: [{ label: "运行方式", value: "本地优先" }, { label: "核心对象", value: "目标与证据" }],
      problemPoints: ["长期任务会经历目标变化、证据过期、人员判断和跨智能体交接。", "聊天记录和定时器无法稳定管理这些状态，也难以阻止无效消耗。", "LoopX 把目标、门槛、待办、证据和额度集中到可检查的控制层。"],
      steps: [
        { label: "连接项目", detail: "在已有项目中初始化或复用本地状态。" },
        { label: "拆分待办", detail: "把长期目标拆成边界清晰的执行片段。" },
        { label: "写回证据", detail: "每轮记录结果、判断、交接和下一步。" },
        { label: "门槛续跑", detail: "根据人工门槛和额度决定继续或停止。" },
      ],
      narration: [
        "开源项目推荐：loopx。长期运行的智能体任务容易失控，它让状态可管理、可复盘、可继续。",
        "目标变化、证据过期和跨智能体交接，靠聊天记录很难管理。它把目标、人工门槛、待办、证据、额度和交接状态保存在本地控制层。",
        "核心结果是每轮只执行边界明确的一段工作，完成后写回证据和下一步。最短路径是连接现有项目，它适合多天工程、研究和监控任务。",
        "先连接现有项目，从一个小待办开始。它不是无人值守的生产控制器，对外操作、危险权限和最终决策仍应由人确认。",
      ],
    };
  }
  if (/\bt3code\b|minimal web gui for coding agents/i.test(`${name} ${item.title}`)) {
    return {
      theme: "把多个代码智能体集中到网页和桌面工作台中管理",
      capability: "为 Codex、Claude、Cursor 和 OpenCode 提供统一图形界面，让使用者查看任务、切换项目并管理远程会话，不必反复操作多个终端窗口",
      workflow: "先安装并登录项目列出的一个代码智能体，再启动 T3 Code；随后选择项目、创建任务，并在统一界面中查看执行过程和结果",
      boundaries: "它是代码智能体的操作界面，不会替代底层模型和命令行工具；项目仍处于早期阶段，使用前要确认权限、命令和代码改动",
      topics: ["统一工作台", "多智能体接入", "项目切换", "任务管理", "远程访问", "结果核对"],
      metrics: [{ label: "接入工具", value: "4 类" }, { label: "使用方式", value: "网页与桌面" }],
      problemPoints: ["多个代码智能体分散在不同终端，任务状态难以统一查看。", "通过一个图形界面管理项目、会话和执行过程。", "适合已经使用代码智能体、不想频繁切换终端的人。"],
      steps: [
        { label: "准备工具", detail: "安装并登录项目列出的代码智能体。" },
        { label: "启动界面", detail: "运行 T3 Code 或安装桌面版本。" },
        { label: "选择项目", detail: "打开代码目录并创建具体任务。" },
        { label: "核对结果", detail: "检查命令、文件改动和测试结果。" },
      ],
    };
  }
  if (/speech-to-speech|voice-agent pipeline|openai realtime-compatible|vad.*stt.*llm.*tts/i.test(`${name} ${item.title} ${content}`)) {
    return {
      theme: "用可替换的开源组件搭建低延迟语音智能体",
      capability: "把语音活动检测、语音识别、大模型和语音合成串成实时流水线，并通过兼容 Realtime 协议的接口接入应用",
      workflow: "先安装软件包并选择语音识别、大模型和语音合成后端，再启动实时服务；客户端连接本地接口后，用真实对话检查延迟、打断和语言效果",
      boundaries: "实际延迟和中文体验取决于所选模型与硬件；本地部署还要评估显存、依赖版本、模型许可和并发能力",
      topics: ["语音活动检测", "实时语音识别", "大模型响应", "流式语音合成", "组件替换", "本地部署"],
      metrics: [{ label: "核心链路", value: "4 阶段" }, { label: "接入协议", value: "实时接口" }],
      problemPoints: ["语音智能体通常需要分别拼接识别、模型和合成服务。", "项目把四个阶段组织成低延迟、可替换的统一流水线。", "既可连接云端模型，也能组合本地开源模型。"],
      steps: [
        { label: "安装组件", detail: "安装软件包并确认 Python 与硬件环境。" },
        { label: "选择后端", detail: "配置语音识别、大模型和语音合成。" },
        { label: "启动服务", detail: "运行实时接口并连接客户端。" },
        { label: "验证对话", detail: "检查延迟、打断、转写和音色。" },
      ],
    };
  }
  if (/\baisuite\b|unified.*chat completions|agents api.*toolkits|one api across multiple llm/i.test(`${name} ${item.title} ${content}`)) {
    return {
      theme: "用一套 Python 接口调用不同大模型并构建工具型智能体",
      capability: "统一多家模型服务的对话调用格式，只需修改模型名称即可切换供应商，并可为智能体添加 Python 函数、工具包和 MCP 工具",
      workflow: "先安装基础包和需要的供应商扩展，配置自己的模型密钥；再用统一客户端发起对话，最后按需要加入工具、运行循环和权限策略",
      boundaries: "统一接口不能消除不同模型在参数、能力、费用和输出上的差异；工具执行还必须设置权限、审批和结果校验",
      topics: ["统一模型接口", "供应商切换", "工具调用", "智能体循环", "MCP 接入", "权限策略"],
      metrics: [{ label: "接口层", value: "统一调用" }, { label: "智能体能力", value: "工具与 MCP" }],
      problemPoints: ["不同模型供应商的 SDK 和调用格式各不相同，切换时需要重新适配。", "aisuite 用统一接口屏蔽常见差异，并向上提供智能体工具层。", "适合需要比较模型或构建多供应商应用的开发者。"],
      steps: [
        { label: "安装扩展", detail: "安装基础包及所需供应商组件。" },
        { label: "配置密钥", detail: "只启用准备实际调用的模型服务。" },
        { label: "统一调用", detail: "通过模型名称切换供应商和模型。" },
        { label: "加入工具", detail: "配置函数、工具包、MCP 与权限策略。" },
      ],
    };
  }
  if (/\bvoicebox\b|local-first.*voice studio|voice cloning.*23 languages|global dictation/i.test(`${name} ${item.title} ${content}`)) {
    return {
      theme: "在本地完成声音克隆、语音生成和听写的语音工作室",
      capability: "用几秒授权音频建立声音档案，并通过七种语音引擎生成二十三种语言的语音；还提供全局听写、语音识别、故事编辑、接口服务和智能体语音输出",
      workflow: "先安装桌面应用并录制或导入已获授权的声音样本，再选择引擎和语言生成短句试听；确认音色、发音和节奏后，用故事编辑器分段生成，最后检查拼接和后处理效果",
      boundaries: "声音克隆必须获得本人授权；不同引擎、语言和硬件的效果与速度不同，正式导出前要逐段试听专名、数字、情绪和拼接位置",
      topics: ["声音克隆", "二十三种语言", "七种语音引擎", "全局听写", "故事编辑", "本地数据"],
      metrics: [{ label: "语言数量", value: "23 种" }, { label: "语音引擎", value: "7 种" }],
      problemPoints: ["声音克隆、听写和长文本配音通常分散在不同工具中。", "Voicebox 把声音档案、生成、识别和故事编辑集中在本地应用。", "语音数据和录音默认留在自己的设备上。"],
      steps: [
        { label: "安装应用", detail: "按系统和显卡环境安装桌面版本。" },
        { label: "建立声音", detail: "录制或导入已获授权的短音频。" },
        { label: "短句试听", detail: "选择引擎和语言，先检查音色与发音。" },
        { label: "分段导出", detail: "生成长内容并复核拼接和后处理。" },
      ],
    };
  }
  if (/deepseek-reasonix|reasonix\.toml|deepseek-native coding agent|stdio json-rpc/i.test(`${name} ${item.title} ${content}`)) {
    return {
      theme: "在终端里规划、执行和检查代码任务的轻量编程智能体",
      capability: "用一个静态 Go 程序连接兼容接口的模型，通过配置文件选择执行模型、规划模型、工具和插件，并在命令行、桌面端或编辑器中复用同一套本地引擎",
      workflow: "先安装程序并运行 reasonix setup，配置模型服务和最小工具权限；再从一个边界清晰的小任务开始，检查它读取的文件、执行的命令和最终改动，确认后再扩大任务范围",
      boundaries: "它需要用户自行配置模型服务；工具可以执行命令和修改文件，因此必须限制工作目录、密钥和审批权限，并用测试与代码审查验证结果",
      topics: ["终端智能体", "任务规划", "工具插件", "模型配置", "上下文维护", "权限审批"],
      metrics: [{ label: "程序形态", value: "单文件" }, { label: "工具协议", value: "JSON-RPC" }],
      problemPoints: ["长时间代码会话容易丢失上下文，并产生重复的模型输入成本。", "Reasonix 用稳定配置、插件工具和上下文维护组织整个代码任务。", "命令行、桌面端和编辑器可以共享同一套执行引擎。"],
      steps: [
        { label: "安装程序", detail: "获取适合系统的单文件程序。" },
        { label: "运行设置", detail: "执行 reasonix setup 配置模型服务。" },
        { label: "限制权限", detail: "限定当前任务可访问的目录和工具。" },
        { label: "小步验证", detail: "检查命令、改动和测试后再扩大范围。" },
      ],
    };
  }
  if (/pdf-inspector|textbased|scanned|imagebased|position-aware.*pdf|without ocr/i.test(`${name} ${item.title} ${content}`)) {
    return {
      theme: "先判断 PDF 类型，再快速提取原生文本和版面结构",
      capability: "不用光学识别就能把文档分为文本型、扫描型、图片型或混合型，并提取标题、列表、代码、表格、链接、分栏和阅读顺序，转换为干净的 Markdown",
      workflow: "先把 PDF 交给分类器判断页面类型；对原生文本页面直接本地提取，对扫描页或异常页再转交光学识别，最后抽样核对阅读顺序、表格和标题结构",
      boundaries: "它刻意不做光学识别，因此扫描件仍需其他工具；低于二百毫秒和各项基准来自项目测试，实际速度与准确率取决于文件结构和设备",
      topics: ["PDF 分类", "文本提取", "阅读顺序", "表格与分栏", "Markdown", "按需光学识别"],
      metrics: [{ label: "文档类型", value: "4 类" }, { label: "整体得分", value: "0.875" }],
      problemPoints: ["直接对所有 PDF 做光学识别需要更多时间和计算资源。", "PDF Inspector 先识别哪些页面已经包含可提取文本。", "只有扫描页和异常页需要进入更昂贵的识别流程。"],
      steps: [
        { label: "分类文档", detail: "先判断文本型、扫描型、图片型或混合型。" },
        { label: "本地提取", detail: "对原生文本页提取结构化内容。" },
        { label: "按需识别", detail: "只把扫描页和问题页交给光学识别。" },
        { label: "抽样核对", detail: "检查阅读顺序、表格、标题和链接。" },
      ],
    };
  }
  if (/\bairllm\b|one layer.*at a time|small gpu memory|70b.*4gb|405b.*8gb/i.test(`${name} ${item.title} ${content}`)) {
    return {
      theme: "用分层加载方式在小显存设备上运行超大语言模型",
      capability: "推理时一次只把当前模型层或专家加载到显卡，让四 GB 左右显存也能尝试七百亿参数模型，并适配多种常见模型家族",
      workflow: "先确认模型许可、磁盘容量和下载时间，再安装 AirLLM 并选择一个适合的模型；首次运行会拆分并保存模型层，完成后先用短提示测试速度和内存，再决定是否处理更长任务",
      boundaries: "低显存不等于高速度，模型层需要频繁从磁盘读取，硬盘性能和容量往往成为瓶颈；超大模型仍需大量存储，首次拆分也会耗时",
      topics: ["分层加载", "小显存推理", "模型拆分", "磁盘吞吐", "多模型适配", "性能边界"],
      metrics: [{ label: "70B 显存", value: "约 4GB" }, { label: "405B 显存", value: "约 8GB" }],
      problemPoints: ["超大模型通常要求昂贵的高显存显卡。", "AirLLM 用逐层加载把推理显存控制在较小范围。", "节省显存的代价是更多磁盘空间、读取时间和较慢推理。"],
      steps: [
        { label: "核对资源", detail: "确认模型许可、磁盘容量和下载条件。" },
        { label: "安装工具", detail: "安装 AirLLM 并选择已适配的模型。" },
        { label: "完成拆分", detail: "首次运行等待模型层拆分和保存。" },
        { label: "短句测试", detail: "先测速度、内存和输出，再扩大任务。" },
      ],
    };
  }
  if (/build-your-own|re-creat(?:e|ing).*from scratch/i.test(`${item.title} ${content}`)) {
    return {
      theme: "通过从零实现理解技术原理",
      capability: "把不同技术主题的逐步实践资料集中整理",
      workflow: "先选定一个具体主题，再沿着从基础概念到可运行实现的顺序推进",
      boundaries: "它提供的是学习路径和参考资料，真正的理解仍要来自动手实现、调试和复盘",
      topics: topics.length ? topics : ["三维渲染", "人工智能模型", "数据库", "网络协议栈", "操作系统", "编程语言"],
    };
  }
  if (/prime-agent|self-improving RLM|recursive language model|continual harness|persistent REPL/i.test(`${name} ${item.title} ${content}`)) {
    return {
      theme: "让长时间运行的代码和研究任务保持上下文、记忆与执行进度",
      capability: "用持久 REPL、递归子智能体和持续 harness 反复执行任务，并把证据、记忆和可复用技能保留下来",
      workflow: "先给出一个明确的代码或研究目标，再让主智能体拆分子任务；每轮检查 REPL 输出和证据，确认结果后再继续迭代或交接",
      boundaries: "它适合需要连续运行和多轮修正的复杂任务，不适合只问一句话的即时问答；长任务仍需要限制工具权限、成本和最终交付权限",
      topics: ["长任务执行", "持久 REPL", "递归子智能体", "持续改进", "记忆与技能", "证据核对"],
      metrics: [{ label: "核心机制", value: "Recursive RLM" }, { label: "任务类型", value: "长时间代码任务" }],
      narration: [
        "开源项目推荐：prime-agent。它解决长时间代码任务容易丢上下文、重复劳动的问题。",
        "它用持久 REPL、递归子智能体和持续 harness 保留任务状态，并根据测试和证据继续改进。",
        "最短路径是先给一个可检查的目标，再拆分子任务；每轮核对文件改动、测试结果和 REPL 输出。",
        "它适合长时间开发和研究，不适合只问一句话的即时问答；工具权限、成本和最终交付仍需人工控制。",
      ],
      problemPoints: ["复杂代码任务经常因为上下文丢失和重复劳动中断。", "Prime Agent 用持久 REPL 和递归子智能体保持任务状态，并根据证据继续改进。", "它更适合长时间开发、研究和需要多轮验证的工作。"],
      steps: [
        { label: "定义目标", detail: "先给出一个边界清晰、可以检查结果的代码或研究目标。" },
        { label: "拆分任务", detail: "让主智能体把目标拆给递归子智能体，并保留每轮输出。" },
        { label: "检查证据", detail: "核对测试、文件改动和 REPL 结果，不接受没有证据的结论。" },
        { label: "继续迭代", detail: "把有效经验沉淀为记忆或技能，再推进下一轮工作。" },
      ],
    };
  }
  if (/mirofish|multi-agent prediction|parallel digital world|swarm intelligence|independent personalities/i.test(`${name} ${item.title} ${content}`)) {
    return {
      theme: "用多智能体模拟观察新闻、政策或市场信号可能引发的连锁反应",
      capability: "把一条种子信息扩展成具有独立人格、长期记忆和行为逻辑的数字世界，让多个智能体互动后呈现潜在结果",
      workflow: "先输入新闻、政策草案或金融信号，再设定参与者和场景；运行多智能体互动，观察关键事件如何演化，并把结果当作假设进行复盘",
      boundaries: "它适合做舆情推演、策略假设和研究辅助，不是现实世界的预测保证；模拟设定、数据质量和模型偏差都必须单独核查",
      topics: ["多智能体模拟", "新闻推演", "政策分析", "群体互动", "长期记忆", "结果复盘"],
      metrics: [{ label: "模拟方式", value: "平行数字世界" }, { label: "输入信号", value: "新闻、政策、市场" }],
      narration: [
        "开源项目推荐：MiroFish。它解决单个模型只能给静态预测、看不到多方互动的问题。",
        "它把新闻、政策或市场信号变成有独立人格和记忆的多智能体系统，再观察它们如何互动。",
        "使用时先输入一条种子信息，设定参与者和规则，再记录关键节点、不同发展路径和对比结果。",
        "它适合研究人员做舆情推演和策略假设，不是现实预测保证；模拟设定、数据质量和模型偏差都要复核。",
      ],
      problemPoints: ["单个模型通常只能给出静态判断，难以展示多方互动后的变化。", "MiroFish 从一条新闻或政策信号出发，构造多个有独立行为逻辑的智能体。", "用户可以观察不同参与者互动后的可能路径，再比较自己的策略假设。"],
      steps: [
        { label: "准备信号", detail: "输入一条新闻、政策草案或市场信息，明确想观察的问题。" },
        { label: "设定角色", detail: "检查参与者、人格、记忆和行为规则是否符合研究假设。" },
        { label: "运行模拟", detail: "让多个智能体互动，记录关键节点和分叉结果。" },
        { label: "复盘结论", detail: "把模拟结果当作假设，结合真实数据验证，不把它当成确定预测。" },
      ],
    };
  }
  if (/autogpt|AI agents that finish the work|visual builder|agent marketplace|on demand.*schedule.*trigger/i.test(`${name} ${item.title} ${content}`)) {
    return {
      theme: "把需要反复跟进的目标交给可以执行完整流程的智能体",
      capability: "用户用自然语言描述结果，AutoGPT 就能构建、运行并报告一个包含工具、步骤和触发条件的任务流程",
      workflow: "先写清楚目标、输入和验收结果，再选择现成智能体或用可视化构建器配置步骤；运行后检查过程报告，必要时安排定时或事件触发",
      boundaries: "它适合自动化研究、内容处理和重复业务流程，不适合未经审核就执行付款、删除数据或对外发送；敏感操作必须保留权限和人工确认",
      topics: ["目标驱动执行", "可视化构建", "工具调用", "定时触发", "过程报告", "权限审核"],
      metrics: [{ label: "运行方式", value: "按需、定时、触发" }, { label: "核心结果", value: "完成并报告任务" }],
      narration: [
        "开源项目推荐：AutoGPT。它解决复杂工作需要人工拆步骤、反复跟进和汇总的问题。",
        "用户直接描述目标，系统负责调用工具、构建并运行完整流程，最后返回过程和结果报告。",
        "最短路径是写清输入、输出和验收标准，再选择工具和触发方式，先用小任务检查执行过程。",
        "它适合研究、内容处理和重复业务；付款、删数据和对外发送等高风险动作必须保留人工审核。",
      ],
      problemPoints: ["复杂工作如果全靠人工拆步骤、跟进和汇总，容易漏掉中间环节。", "AutoGPT 让用户直接描述结果，再由智能体执行流程并返回报告。", "它适合把重复任务变成可复用流程，但关键动作仍要经过权限和人工审核。"],
      steps: [
        { label: "描述结果", detail: "写清楚目标、输入、输出格式和什么算完成。" },
        { label: "配置流程", detail: "选择智能体或用可视化工具安排步骤、工具和触发方式。" },
        { label: "小范围运行", detail: "先用无敏感数据试跑，查看过程记录和最终报告。" },
        { label: "设置审核", detail: "对外发送、写入生产系统和高风险操作保留人工确认。" },
      ],
    };
  }
  if (/coding agent|code cli|read and edit code|run shell commands/i.test(`${item.title} ${content}`)) {
    return {
      theme: "围绕终端代码任务工作的智能编程工具",
      capability: "读取和编辑代码、执行命令、搜索文件，并根据反馈决定下一步",
      workflow: "从理解项目上下文开始，经过任务拆解、执行与结果核对，持续保留可检查的步骤",
      boundaries: "它可以加快重复性的工程操作，但测试、评审、权限和发布决策仍应由开发者确认",
      topics: ["代码阅读", "文件修改", "命令执行", "任务拆解", "结果核对", "编辑器协作"],
    };
  }
  return {
    theme: "围绕实际开发任务整理的开源工具",
    capability: "将项目资料中的核心功能和使用路径组织为可查阅的工作流",
    workflow: "先理解项目解决的问题，再选择与当前任务相关的能力，并在实际工程中完成验证",
    boundaries: "项目资料只能说明设计目标和已列出的能力，部署前仍要结合自身环境验证依赖、权限和兼容性",
    topics: topics.length ? topics : ["核心能力", "工作流程", "工程协作", "配置使用", "验证检查", "适用边界"],
  };
}

function createRepositoryProject(item: HotItem, options?: { width?: number; height?: number; fps?: number; screenshots?: WebScreenshot[]; index?: number }): VideoProject {
  const name = repositoryName(item);
  const profile = repositoryProfile(item);
  const promotion = repositoryPromotionCopy(profile);
  const narration = profile.narration;
  const proofMetrics = repositoryProofMetrics(item, profile);
  const sections: Array<{ scene: VideoScene; narration: string }> = [
    {
      scene: {
        type: "title", duration: 10, kicker: REPOSITORY_HOMEPAGE_PREFIX, headline: repositoryHomepageTitle(name),
        subhead: `用途：${compactSentence(profile.capability, 44)}；适用场景：${profile.topics.slice(0, 2).join("、")}`,
        sources: [repositoryStars(item), `适用：${compactSentence(promotion.audience, 18)}`, `场景：${profile.topics.slice(0, 2).join("、")}`],
      },
      narration: narration?.[0] ?? `${repositoryNarrationTitle(name)}。它直接解决${profile.theme}。`,
    },
    {
      scene: {
        type: "briefing_points", duration: 16, headline: "先看它替你省掉什么麻烦", source: "项目资料", title: name, summary: promotion.problem,
        metrics: proofMetrics,
        points: [promotion.problem, promotion.benefit, `直接收益：${profile.capability}`],
      },
      narration: narration?.[1] ?? limitNarration(`${promotion.problem}直接收益是${profile.capability}。`, 100),
    },
    {
      scene: {
        type: "news_stack", duration: 16, headline: "核心价值、证据和使用前提",
        items: promotion.highlights.map((highlight, index) => ({
          title: ["核心结果", "最短路径", "使用前提"][index],
          summary: highlight.replace(/^[^：]+：/u, ""),
          source: "项目资料",
          url: "about:blank",
          tags: [profile.topics[index] ?? "项目能力"],
        })),
      },
      narration: narration?.[2] ?? limitNarration(`判断它是否值得用，主要看三点：${promotion.highlights.join("；")}。`, 105),
    },
    {
      scene: {
        type: "outro", duration: 15, headline: "怎么开始，什么情况别急", bullets: [
          `开始：${promotion.firstStep}`,
          `推荐：${promotion.audience}。`,
          `注意：${profile.boundaries}。`,
        ],
      },
      narration: narration?.[3] ?? limitNarration(`最快开始：${promotion.firstStep.replace(/[。！？!?]+$/u, "")}。注意：${profile.boundaries.replace(/[。！？!?]+$/u, "")}。`, 130),
    },
  ];
  const scenes = applySectionDurations(sections, Math.min(55, Math.max(40, Number(process.env.STORY_MAX_SECONDS ?? 48))), 40);
  const factLedger = buildFactLedger([item]);
  const claimIds = (sceneIndex: number) => {
    const selected = factLedger.claims.slice(sceneIndex * 2, sceneIndex * 2 + 2);
    return (selected.length ? selected : factLedger.claims.slice(0, 2)).map((claim) => claim.id);
  };
  return {
    meta: { title: name, createdAt: new Date().toISOString(), width: options?.width ?? Number(process.env.VIDEO_WIDTH ?? 1080), height: options?.height ?? Number(process.env.VIDEO_HEIGHT ?? 1920), fps: options?.fps ?? Number(process.env.VIDEO_FPS ?? 30), durationSeconds: scenes.reduce((sum, scene) => sum + scene.duration, 0), sourceCount: 1 },
    narration: sections.map((section) => section.narration).join("\n"),
    narrationSegments: sections.map((section, sceneIndex) => ({ sceneIndex, text: section.narration, ttsText: repositorySynthesisText(section.narration, name), claimIds: claimIds(sceneIndex) })),
    scenes: scenes.map((scene, sceneIndex) => ({ ...scene, claimIds: claimIds(sceneIndex) })) as VideoScene[],
    sources: [item],
    screenshots: options?.screenshots ?? [],
    factLedger,
    titleClaimIds: claimIds(0),
  } satisfies VideoProject;
}

export function createStoryProject(
  item: HotItem,
  options?: { width?: number; height?: number; fps?: number; screenshots?: WebScreenshot[]; index?: number },
): VideoProject {
  const clean = cleanItem(item);
  if (clean.kind === "github" || clean.contentType === "repository") return createRepositoryProject(clean, options);
  const joinedContent = `${clean.title} ${clean.summary} ${clean.content ?? ""}`;
  if (/tmtpost\.com\/8088190/i.test(clean.url) || /Loop.*Graph|Graph.*Loop|AI Coding.*Graph/i.test(joinedContent)) return createLoopGraphEngineeringProject(clean, options);
  if (/tmtpost\.com\/8091801/i.test(clean.url)) return createAiOfficeCompetitionProject(clean, options);
  if (/tmtpost\.com\/8091516/i.test(clean.url)) return createModelKillZoneProject(clean, options);
  if (/tmtpost\.com\/8091864/i.test(clean.url)) return createAiIndustrialDemandProject(clean, options);
  if (/ithome\.com\/0\/985\/886/i.test(clean.url)) return createShieldstralProject(clean, options);
  if (/qbitai\.com\/2026\/08\/465215/i.test(clean.url) || /Qwen3\.8/i.test(joinedContent)) return createQwen38Project(clean, options);
  if (/ithome\.com\/0\/987\/720/i.test(clean.url)) return createQwenOpenPlatformProject(clean, options);
  if (/ithome\.com\/0\/986\/936/i.test(clean.url)) return createNeonRetrievalModelProject(clean, options);
  if (/qbitai\.com\/2026\/08\/467879/i.test(clean.url)) return createChatGptFreeUpgradeProject(clean, options);
  if (/qbitai\.com\/2026\/08\/467877/i.test(clean.url)) return createWan30DocumentVideoProject(clean, options);
  if (/ithome\.com\/0\/985\/044/i.test(clean.url) || /SenseNova\s*U1\.5-Lite-Preview/i.test(joinedContent)) return createSenseNovaU15Project(clean, options);
  if (/zhidx\.com\/p\/582336/i.test(clean.url) || /MAGI-2 Preview/i.test(`${clean.title} ${clean.summary ?? ""}`)) return createSandMagi2Project(clean, options);
  if (/不可取代|薪资奴役|高自主性|不可受雇/i.test(joinedContent)) return createAiCareerIndependenceProject(clean, options);
  const headlineContext = `${clean.title} ${clean.summary}`;
  const isAiMathStory = /菲尔兹奖级|非sofic|十项.*数学|数学难题/i.test(headlineContext)
    || (/\bAstra\b/i.test(headlineContext) && /数学|证明|群论|几何|Lean\s*4/i.test(headlineContext));
  if (isAiMathStory || /36kr\.com\/p\/3921682068172419/i.test(clean.url)) return createAiMathBreakthroughProject(clean, options);
  if (/141006|十四万一千零六|三家外部机构|测试环境.*公网/i.test(joinedContent)) return createClaudeSecurityIncidentProject(clean, options);
  if (/150\s*亩芝麻|一百五十亩芝麻|氟磺胺草醚/i.test(joinedContent)) return createAiPesticideIncidentProject(clean, options);
  if (/第\s*23\s*届\s*ChinaJoy|第\s*二十三\s*届\s*ChinaJoy|14\s*万平方米|火龙漫剧/i.test(joinedContent)) return createChinaJoyAiProject(clean, options);
  if (/Seedance\s*2\.5/i.test(`${clean.title} ${clean.summary ?? ""}`)) return createSeedance25Project(clean, options);
  if (/DeepSeek-V4-Flash/i.test(joinedContent) && /V4-Pro/i.test(joinedContent)) return createDeepSeekV4FlashProject(clean, options);
  if (/baijiahao\.baidu\.com\/s\?id=1873013937251230205/i.test(clean.url) || /首个全国产10万卡AI超集群/i.test(joinedContent)) return createNationalComputeClusterProject(clean, options);
  if (/tmtpost\.com\/8096544/i.test(clean.url) || /Jeff Dean挥别谷歌48小时首秀/i.test(joinedContent)) return createJeffDeanNextDecadeProject(clean, options);
  if (/36kr\.com\/p\/3933115490368647/i.test(clean.url) || /mona-lisa-1/i.test(joinedContent)) return createGptImageMonaLisaProject(clean, options);
  if (!/Step\s*3\.7|416\s*tokens|AA\s*榜/i.test(joinedContent)) {
    return createGeneralNewsProject(clean, options);
  }
  const sections = storySections(clean);
  const scenes = applySectionDurations(sections, Number(process.env.STORY_MAX_SECONDS ?? 115));
  const durationSeconds = scenes.reduce((sum, scene) => sum + scene.duration, 0);
  const screenshots = (options?.screenshots ?? []).map((shot) => ({
    ...shot,
    title: scrubAttribution(shot.title),
    source: "原文页面",
  }));

  return {
    meta: {
      title: clean.title,
      createdAt: new Date().toISOString(),
      width: options?.width ?? Number(process.env.VIDEO_WIDTH ?? 1080),
      height: options?.height ?? Number(process.env.VIDEO_HEIGHT ?? 1920),
      fps: options?.fps ?? Number(process.env.VIDEO_FPS ?? 30),
      durationSeconds,
      sourceCount: 1,
    },
    narration: sections.map((section) => removeNarrationLead(scrubAttribution(section.narration))).join("\n"),
    narrationSegments: sections.map((section, sceneIndex) => ({
      sceneIndex,
      text: scrubAttribution(section.narration),
    })),
    scenes,
    sources: [clean],
    screenshots,
  } satisfies VideoProject;
}

function createGeneralNewsProject(
  item: HotItem,
  options?: { width?: number; height?: number; fps?: number; screenshots?: WebScreenshot[]; index?: number },
): VideoProject {
  const topicText = `${item.title} ${item.summary}`;
  const isTechnicalArticle = contentTypeForItem(item) === "technical-article";
  const isChipStory =
    /芯片|AI芯片|推理芯片|自研芯片|造芯|算力芯片/i.test(topicText) &&
    !/(?:开源|发布|推出).{0,20}(?:模型|H3)|(?:模型|H3).{0,20}(?:开源|发布|推出)/i.test(item.title);
  const title = speechFriendlyTitle(item.title);
  const summary =
    item.summary && item.summary !== item.title
      ? item.summary
      : isChipStory
        ? "头部模型公司开始把竞争从模型能力，推进到底层算力和推理成本控制。"
        : "这条新闻的关键，是一个行业变量正在从表层事件变成结构性变化。";
  const articleSentences = splitArticleIntoSemanticChunks(item.content ?? item.summary);
  const sentenceAt = (index: number) => articleSentences[index] ?? articleSentences[index % Math.max(1, articleSentences.length)] ?? summary;
  const narrationAt = (start: number, count = 2) => {
    const selected = Array.from({ length: count }, (_, offset) => sentenceAt(start + offset));
    let narration = selected.join("");
    let offset = count;
    while (narration.replace(/\s+/g, "").length < 45 && offset < count + 3) {
      const candidate = sentenceAt(start + offset);
      if (candidate && !selected.includes(candidate)) {
        selected.push(candidate);
        narration += candidate;
      }
      offset += 1;
    }
    if (narration.replace(/\s+/g, "").length < 45 && summary && !narration.includes(summary)) narration += summary;
    return narration;
  };
  const coverSummary = compactSentence(summary, 72);

  const sections: Array<{ scene: VideoScene; narration: string }> = isTechnicalArticle
    ? [
        {
          scene: {
            type: "title",
            duration: 12,
            kicker: "TECH / EXPLAINER",
            headline: shortTitle(title, 42),
            subhead: coverSummary,
            sources: ["\u95ee\u9898", "\u65b9\u6cd5", "\u8fb9\u754c"],
          },
          narration: `${title}\u3002关键是，${coverSummary}`,
        },
        {
          scene: {
            type: "briefing_points",
            duration: 19,
            headline: "\u5148\u660e\u786e\u95ee\u9898\u548c\u5047\u8bbe",
            source: "\u95ee\u9898\u5b9a\u4e49",
            title,
            summary: sentenceAt(0),
            metrics: [
              { label: "\u76ee\u6807", value: compactSentence(sentenceAt(1), 18) },
              { label: "\u8f93\u5165", value: compactSentence(sentenceAt(2), 18) },
            ],
            points: [sentenceAt(0), sentenceAt(1), sentenceAt(2)],
          },
          narration: narrationAt(0, 2),
        },
        {
          scene: {
            type: "flow",
            duration: 20,
            headline: "\u4ece\u6570\u636e\u5230\u8ba1\u7b97\u7ed3\u679c",
            steps: [
              { label: "\u62c6\u5206\u53d8\u91cf", detail: sentenceAt(2) },
              { label: "\u5efa\u7acb\u5047\u8bbe", detail: sentenceAt(3) },
              { label: "\u6267\u884c\u8ba1\u7b97", detail: sentenceAt(4) },
              { label: "\u6821\u9a8c\u7ed3\u679c", detail: sentenceAt(5) },
            ],
          },
          narration: narrationAt(2, 2),
        },
        {
          scene: {
            type: "briefing_points",
            duration: 19,
            headline: "\u5173\u952e\u63a8\u5bfc\u4e0e\u5b9e\u73b0\u7ec6\u8282",
            source: "\u6280\u672f\u8def\u5f84",
            title: compactSentence(sentenceAt(6), 32),
            summary: sentenceAt(7),
            metrics: [
              { label: "\u8ba1\u7b97", value: compactSentence(sentenceAt(6), 18) },
              { label: "\u9a8c\u8bc1", value: compactSentence(sentenceAt(7), 18) },
            ],
            points: [sentenceAt(6), sentenceAt(7), sentenceAt(8)],
          },
          narration: narrationAt(6, 2),
        },
        {
          scene: {
            type: "outro",
            duration: 17,
            headline: "\u7ed3\u8bba\u6210\u7acb\u7684\u8fb9\u754c",
            bullets: [sentenceAt(9), sentenceAt(10), sentenceAt(11)],
          },
          narration: narrationAt(9, 2),
        },
      ]
    : isChipStory
    ? [
        {
          scene: {
            type: "title",
            duration: 7,
            kicker: "AI 全栈战争",
            headline: shortTitle(title, 42),
            subhead: summary,
            sources: ["模型", "芯片", "Token 成本"],
          },
          narration: `这条新闻讲的是：${title}。简单说，DeepSeek 和智谱这类模型公司，正在把竞争从模型本身，推进到底层芯片和推理成本控制。`,
        },
        {
          scene: {
            type: "briefing_points",
            duration: 18,
            headline: "这条新闻真正说了什么",
            source: "核心事实",
            title,
            summary,
            metrics: [
              { label: "主线", value: "推理芯片" },
              { label: "变量", value: "成本控制" },
              { label: "竞争", value: "全栈化" },
            ],
            points: [
              "DeepSeek 被曝正在开发面向大模型推理的自研 AI 芯片。",
              "智谱也在评估定制 AI 芯片，原因是 GLM 系列模型需求增长。",
              "OpenAI、Anthropic 等海外头部模型公司，也在同一时间窗口布局芯片。",
            ],
          },
          narration:
            "为什么是推理芯片？因为训练一个模型虽然很贵，但训练是阶段性的；真正每天持续烧钱的，是每一次用户调用、每一次 Agent 运行、每一次 Token 生成。",
        },
        {
          scene: {
            type: "flow",
            duration: 18,
            headline: "为什么模型公司开始造芯",
            steps: [
              { label: "推理变成水电费", detail: "训练是阶段性投入，推理发生在每一次真实调用里。" },
              { label: "GPU 不再总是最优", detail: "固定模型负载可能更适合定制芯片。" },
              { label: "供应安全压力", detail: "供应、管制和产能波动，都会影响模型公司命运。" },
              { label: "Token 价格战", detail: "谁能压低推理成本，谁就有更大规模化空间。" },
            ],
          },
          narration:
            "通用 GPU 什么都能做，但如果一家模型公司长期运行固定模型负载，就可能希望用定制芯片，围绕自己的算子、缓存、内存访问和数据流做优化。",
        },
        {
          scene: {
            type: "signal_chart",
            duration: 16,
            headline: "这场竞争比模型更重",
            bars: [
              { label: "推理成本", value: 96, detail: "用户越多，Token 吞吐越大，推理成本越关键。", color: "#18b7a5" },
              { label: "供应控制", value: 90, detail: "摆脱单一硬件路线依赖，成为模型公司的战略变量。", color: "#7c6cff" },
              { label: "软件栈", value: 86, detail: "还需要编译器、算子和数据中心系统。", color: "#facc15" },
              { label: "量产难度", value: 88, detail: "先进 AI 芯片从设计到部署，往往是多年工程。", color: "#ff6b6b" },
            ],
          },
          narration:
            "这件事还有供应安全的含义。对 OpenAI 来说，是减少对英伟达单一路线的依赖；对国产模型公司来说，则同时涉及成本账、供应安全账和产业链自主权。",
        },
        {
          scene: {
            type: "outro",
            duration: 14,
            headline: "AI 终局不只是模型",
            bullets: [
              "模型厂商造芯，本质是争夺 Token 成本和算力控制权。",
              "真正难点不只是设计芯片，而是软件栈、供应链和规模化部署。",
              "下一阶段 AI 竞争，可能属于能把模型、芯片、云和应用连成闭环的公司。",
            ],
          },
          narration:
            "但造芯片不是简单换个硬件，它还需要芯片设计、编译器、软件栈、供应链和多年量产经验。所以这条新闻真正的信号是：AI 竞争的终局，可能属于能把模型、芯片、云和 Token 成本连成闭环的公司。",
        },
      ]
    : [
        {
          scene: {
            type: "title",
            duration: 12,
            kicker: "今日科技信号",
            headline: shortTitle(title, 42),
            subhead: coverSummary,
            sources: ["事实", "影响", "边界"],
          },
          narration: `${title}。这次真正改变的是：${coverSummary}`,
        },
        {
          scene: {
            type: "briefing_points",
            duration: 20,
            headline: compactSentence(sentenceAt(0), 30),
            source: "核心事实",
            title,
            summary,
            metrics: [
              { label: "核心观点", value: compactSentence(sentenceAt(1), 18) },
              { label: "讨论范围", value: compactSentence(sentenceAt(2), 18) },
            ],
            points: [sentenceAt(1), sentenceAt(2), sentenceAt(3)],
          },
          narration: narrationAt(2, 2),
        },
        {
          scene: {
            type: "news_stack",
            duration: 20,
            headline: compactSentence(sentenceAt(4), 30),
            items: [{ title, summary: narrationAt(4, 2), source: item.source, url: item.url, tags: item.tags }],
          },
          narration: narrationAt(4, 2),
        },
        {
          scene: {
            type: "timeline",
            duration: 20,
            headline: compactSentence(sentenceAt(6), 30),
            events: [
              { date: "活动背景", title: sentenceAt(6), source: item.source },
              { date: "观点表达", title: sentenceAt(7), source: item.source },
              { date: "行业实践", title: sentenceAt(8), source: item.source },
            ],
          },
          narration: narrationAt(6, 2),
        },
        {
          scene: {
            type: "outro",
            duration: 18,
            headline: compactSentence(sentenceAt(9), 30),
            bullets: [sentenceAt(9), sentenceAt(10), sentenceAt(11)],
          },
          narration: narrationAt(9, 2),
        },
      ];

  const narrationSections = sections.map((section, index) => ({ ...section, narration: limitNarration(section.narration, index === 0 ? 100 : 110) }));
  const scenes = applySectionDurations(narrationSections, Number(process.env.STORY_MAX_SECONDS ?? 96));
  const durationSeconds = scenes.reduce((sum, scene) => sum + scene.duration, 0);
  const project = {
    meta: {
      title,
      createdAt: new Date().toISOString(),
      width: options?.width ?? Number(process.env.VIDEO_WIDTH ?? 1080),
      height: options?.height ?? Number(process.env.VIDEO_HEIGHT ?? 1920),
      fps: options?.fps ?? Number(process.env.VIDEO_FPS ?? 30),
      durationSeconds,
      sourceCount: 1,
    },
    narration: narrationSections.map((section) => scrubAttribution(section.narration)).join("\n"),
    narrationSegments: narrationSections.map((section, sceneIndex) => ({
      sceneIndex,
      text: removeNarrationLead(scrubAttribution(section.narration)),
      ttsText: speechFriendlyText(removeNarrationLead(scrubAttribution(section.narration))),
    })),
    scenes,
    sources: [item],
    screenshots: options?.screenshots ?? [],
  } satisfies VideoProject;
  return withGroundedFactReferences(project);
}

function createCuratedNewsProject(
  item: HotItem,
  sections: Array<{ scene: VideoScene; narration: string }>,
  options?: { width?: number; height?: number; fps?: number; screenshots?: WebScreenshot[]; index?: number },
  duration?: { maxSeconds?: number; minSeconds?: number },
): VideoProject {
  const scenes = applySectionDurations(
    sections,
    duration?.maxSeconds ?? Number(process.env.STORY_MAX_SECONDS ?? 80),
    duration?.minSeconds ?? 55,
  );
  const project = {
    meta: {
      title: speechFriendlyTitle(item.title),
      createdAt: new Date().toISOString(),
      width: options?.width ?? Number(process.env.VIDEO_WIDTH ?? 1080),
      height: options?.height ?? Number(process.env.VIDEO_HEIGHT ?? 1920),
      fps: options?.fps ?? Number(process.env.VIDEO_FPS ?? 30),
      durationSeconds: scenes.reduce((sum, scene) => sum + scene.duration, 0),
      sourceCount: 1,
    },
    narration: sections.map((section) => section.narration).join("\n"),
    narrationSegments: sections.map((section, sceneIndex) => ({
      sceneIndex,
      text: section.narration,
      ttsText: speechFriendlyText(section.narration),
    })),
    scenes,
    sources: [item],
    screenshots: options?.screenshots ?? [],
  } satisfies VideoProject;
  return withGroundedFactReferences(project);
}

function createGptImageMonaLisaProject(
  item: HotItem,
  options?: { width?: number; height?: number; fps?: number; screenshots?: WebScreenshot[]; index?: number },
): VideoProject {
  const title = speechFriendlyTitle(item.title);
  return createCuratedNewsProject(item, [
    {
      scene: {
        type: "title", duration: 12, kicker: "图像模型新信号", headline: shortTitle(title, 42),
        subhead: "匿名模型进入盲测，真实感和复杂画面表现成为焦点", sources: ["mona-lisa-1", "同提示对比", "尚未官宣"],
      },
      narration: `${title}。提升已经出现：匿名盲测画面更自然。`,
    },
    {
      scene: {
        type: "briefing_points", duration: 17, headline: "为什么外界猜测它来自 OpenAI", source: "公开测试",
        title: "匿名模型进入 LM Arena（大模型竞技场）", summary: "测试者发现生成结果带有 SynthID 合成内容水印，但官方身份仍未确认。",
        metrics: [{ label: "测试方式", value: "匿名盲测" }, { label: "身份状态", value: "尚未官宣" }],
        points: ["模型以 mona-lisa-1 的代号进入 LM Arena 大模型竞技场。", "测试者在生成图中检测到 SynthID 合成内容水印。", "现有证据只能说明外界猜测有依据，官方身份仍未确认。"],
      },
      narration: "它先以匿名身份进入大模型竞技场的盲测。测试者把生成图交给验证工具后，发现了合成内容水印，因此推测它可能来自 OpenAI。但这仍是公开测试线索，官方没有确认模型身份，也没有公布正式版本和上线时间。",
    },
    {
      scene: {
        type: "flow", duration: 17, headline: "提升集中在三个可见结果",
        steps: [
          { label: "人物质感", detail: "同一提示对比中，皮肤和材质更自然，塑料感减弱。" },
          { label: "复杂内容", detail: "网页界面、信息图和人体拆解图能容纳更多细节。" },
          { label: "艺术表达", detail: "光影、色彩和氛围的层次更丰富。" },
        ],
      },
      narration: "从公开的同提示对比看，变化主要有三点。第一，人物皮肤和材质更自然，过去常见的塑料感有所减弱；第二，网页界面、信息图和人体拆解图能容纳更多细节；第三，艺术画面的光影、色彩和氛围层次更完整。",
    },
    {
      scene: {
        type: "outro", duration: 14, headline: "效果提升已经出现，身份仍待确认",
        bullets: ["测试内容显示知识更新可能停留在 2025 年。", "它可能只是同代模型的新检查点。", "最终能力、价格和公开时间仍要等官方信息。"],
      },
      narration: "效果提升已经出现，但它还不是最终版。知识更新时间可能停留在二零二五年，更像同代模型的新检查点。正式名称、价格、公开时间和最终能力，仍要等官方确认。",
    },
  ], options, { maxSeconds: 60, minSeconds: 58 });
}

function createNationalComputeClusterProject(
  item: HotItem,
  options?: { width?: number; height?: number; fps?: number; screenshots?: WebScreenshot[]; index?: number },
): VideoProject {
  const title = speechFriendlyTitle(item.title);
  return createCuratedNewsProject(item, [
    {
      scene: { type: "title", duration: 10, kicker: "算力基础设施", headline: shortTitle(title, 42), subhead: "十万卡级国产超集群投用，算力开始跨区域统一调度", sources: ["十万卡级", "国产算力", "全国联网"] },
      narration: title + "。关键不是卡数，而是国产算力开始按全国网络统一调度。",
    },
    {
      scene: { type: "briefing_points", duration: 15, headline: "从集群规模到实际任务", source: "报道事实", title: "科学计算与智能计算共用底座", summary: "首个全国产十万卡人工智能超集群正式投用，支持二十六个领域的三百多种计算任务。", metrics: [{ label: "集群规模", value: "十万卡级" }, { label: "覆盖领域", value: "26 个" }, { label: "计算任务", value: "300 多种" }], points: ["科学计算和智能计算在同一套算力底座上协同。", "目前覆盖二十六个领域。", "已经支持三百多种计算任务。"] },
      narration: "这套十万卡集群把科学计算和智能计算放在同一底座，已经支持二十六个领域、三百多种计算任务。",
    },
    {
      scene: { type: "flow", duration: 15, headline: "算力扩容正在改变研发周期", steps: [{ label: "训练提速", detail: "超大模型训练时间从约一年压缩到约半年。" }, { label: "统一匹配", detail: "不同地区的空闲算力按任务需求调度。" }, { label: "跨区域连接", detail: "算力资源不再局限于单个园区。" }] },
      narration: "最直接的变化是训练提速：超大模型训练时间有望从约一年压缩到约半年；异地算力也能统一匹配。",
    },
    {
      scene: { type: "outro", duration: 14, headline: "全国算力网从扩容走向协同", bullets: ["超过六成算力已纳入统一监测。", "闲置资源需要被精准匹配。", "利用率和产业效果比峰值更重要。"] },
      narration: "真正要看的不是峰值，而是利用率。超过六成已纳入统一监测，能否稳定服务产业，才决定这张网的价值。",
    },
  ], options, { maxSeconds: 54, minSeconds: 46 });
}

function createJeffDeanNextDecadeProject(
  item: HotItem,
  options?: { width?: number; height?: number; fps?: number; screenshots?: WebScreenshot[]; index?: number },
): VideoProject {
  const title = speechFriendlyTitle(item.title);
  return createCuratedNewsProject(item, [
    {
      scene: { type: "title", duration: 10, kicker: "AI for Science", headline: shortTitle(title, 42), subhead: "下一个十年：让 AI 把科学发现变成可重复、可并行的实验循环", sources: ["Discovery Loop", "AI for Science", "科学自动化"] },
      narration: title + "。他的答案是：AI不只回答问题，还要自动推进科学实验。",
    },
    {
      scene: { type: "flow", duration: 16, headline: "Discovery Loop 自动推进实验", steps: [{ label: "提出假设", detail: "把科学问题转成可检验的方向。" }, { label: "设计与执行", detail: "调用工具完成实验。" }, { label: "评估反馈", detail: "根据结果调整下一轮。" }, { label: "并行探索", detail: "淘汰低价值方向。" }] },
      narration: "具体做法是让AI提出假设、设计并执行实验，再根据结果调整下一轮，同时并行淘汰低价值方向。",
    },
    {
      scene: { type: "briefing_points", duration: 16, headline: "目标是把科学研发提速一个数量级", source: "公开对谈", title: "从机器学习扩展到真实科学", summary: "自动实验闭环先用于机器学习研发，再扩展到芯片、药物和清洁能源。", metrics: [{ label: "目标", value: "约 10 倍提速" }, { label: "起点", value: "机器学习研发" }, { label: "扩展", value: "真实科学实验" }], points: ["芯片和硬件设计。", "药物发现。", "清洁能源研究。"] },
      narration: "这套闭环先用于机器学习研发，随后扩展到芯片设计、药物发现和清洁能源，目标是把实验速度提升一个数量级。",
    },
    {
      scene: { type: "outro", duration: 15, headline: "小团队也能追逐前沿科学", bullets: ["云计算提供可租用的大规模算力。", "小团队只需聚焦一个科学目标。", "安全治理必须由人负责，最终结果需要人工检查。"] },
      narration: "云计算让小团队也能租用大规模算力，团队只需聚焦一个科学目标。但安全治理必须由人负责，最终结果也需要人工检查。",
    },
  ], options, { maxSeconds: 56, minSeconds: 48 });
}

function createClaudeSecurityIncidentProject(
  item: HotItem,
  options?: { width?: number; height?: number; fps?: number; screenshots?: WebScreenshot[]; index?: number },
): VideoProject {
  const title = speechFriendlyTitle(item.title);
  return createCuratedNewsProject(item, [
    {
      scene: { type: "title", duration: 10, kicker: "AI 安全测试", headline: shortTitle(title, 42), subhead: "授权测试误连公网，三家外部机构受到影响", sources: ["测试边界", "公网隔离", "评估治理"] },
      narration: `${title}。这不是模型主动选择攻击目标，而是一次授权安全测试错误连接到公网，导致三家外部机构的基础设施被访问。事件暴露的重点，是测试环境隔离和评估流程没有把边界锁牢。`,
    },
    {
      scene: { type: "briefing_points", duration: 18, headline: "授权测试错误连接真实公网", source: "事件事实", title: "测试目标与网络环境发生错位", summary: "三家外部机构的基础设施被访问。", metrics: [{ label: "受影响机构", value: "三家" }, { label: "事件性质", value: "误连公网" }, { label: "原定范围", value: "授权网络" }], points: ["模型原本只应在授权网络里完成安全评估。", "测试配置把模型带到了真实公网。", "双方对评估环境设置存在沟通误解。"] },
      narration: "事情的起点，是模型原本只应在授权网络里完成安全评估，但测试配置把它带到了真实公网。随后，三家不属于测试范围的外部机构基础设施被访问。调查认为，模型公司与评估合作伙伴对环境设置存在沟通误解。",
    },
    {
      scene: { type: "timeline", duration: 18, headline: "复查十四万一千零六个测试会话", events: [{ date: "7 月 23 日", title: "暂停相关评估", source: "处置记录" }, { date: "7 月 24 日", title: "确认三起外部访问事件", source: "处置记录" }, { date: "7 月 27 日", title: "通知受影响机构", source: "处置记录" }] },
      narration: "事后，团队复查了十四万一千零六个测试会话。七月二十三日，相关评估被暂停；七月二十四日，三起外部访问事件得到确认；七月二十七日，受影响机构收到通知。完整复查说明，这类事件不能只看一次模型输出，还要追踪整个执行链路。",
    },
    {
      scene: { type: "flow", duration: 17, headline: "新旧模型对公网边界的反应不同", steps: [{ label: "旧模型", detail: "进入公网后仍继续执行。" }, { label: "最新模型", detail: "识别真实公网环境后主动停止。" }, { label: "模型侧", detail: "安全识别可以继续改进。" }, { label: "工程侧", detail: "网络隔离、权限控制和人工监督不可替代。" }] },
      narration: "另一个关键信号，是新旧模型对边界的反应不同。旧模型进入公网后仍继续执行，而最新模型识别到真实公网环境后主动停止。这说明模型侧的安全识别可以改进，但它不能替代网络隔离、权限控制和人工监督。",
    },
    {
      scene: { type: "outro", duration: 17, headline: "真正需要补的是测试治理", bullets: ["测试网络与公网必须强隔离。", "任务目标、权限和停止条件要可核对。", "保留完整日志，并建立外部事件通知机制。"] },
      narration: "这次事件的结论不应夸大成 AI 自主失控。真正需要补齐的是工程治理：测试网络与公网强隔离，明确任务目标、权限和停止条件，保存完整网络日志，并建立异常发现和外部通知机制。模型越能执行复杂任务，测试边界越不能依赖口头约定。",
    },
  ], options);
}

function createAiPesticideIncidentProject(
  item: HotItem,
  options?: { width?: number; height?: number; fps?: number; screenshots?: WebScreenshot[]; index?: number },
): VideoProject {
  const title = speechFriendlyTitle(item.title);
  return createCuratedNewsProject(item, [
    {
      scene: { type: "title", duration: 10, kicker: "农业用药风险", headline: shortTitle(title, 42), subhead: "一百五十亩芝麻受损，AI 建议不能替代农技核验", sources: ["作物范围", "药剂标签", "人工核验"] },
      narration: `${title}。安徽滁州一位六十七岁农户按照 AI 给出的用药建议处理一百五十亩芝麻，喷药后芝麻苗大面积枯萎。这起事件提醒所有使用者，农业用药属于高风险决策，不能只看一段自动生成的回答。`,
    },
    {
      scene: { type: "briefing_points", duration: 18, headline: "错误建议指向一种除草剂", source: "事件事实", title: "氟磺胺草醚不应全田用于芝麻", summary: "药剂适用作物和喷洒方式没有得到正确核对。", metrics: [{ label: "种植面积", value: "150 亩" }, { label: "农户年龄", value: "67 岁" }, { label: "涉事药剂", value: "氟磺胺草醚" }], points: ["该药主要用于大豆田阔叶杂草防除。", "不能把大豆田用法直接套到芝麻田。", "全田喷洒前必须核对标签和适用范围。"] },
      narration: "问题集中在氟磺胺草醚。这种除草剂主要用于大豆田的阔叶杂草防除，不能把对应方法直接套到芝麻田，更不能未经核对就全田喷洒。作物种类、苗期、剂量和施药方式只要有一项不匹配，都可能造成严重药害。",
    },
    {
      scene: { type: "flow", duration: 18, headline: "一次高风险建议如何被采用", steps: [{ label: "提出问题", detail: "农户向 AI 询问芝麻田除草办法。" }, { label: "获得回答", detail: "回答包含具体药剂和使用建议。" }, { label: "忽略提示", detail: "页面虽提示内容可能有误，但没有被注意。" }, { label: "直接执行", detail: "缺少标签与农技人员的二次核验。" }] },
      narration: "整个过程有四个环节。农户先询问芝麻田除草办法，回答给出了具体药剂和用法。页面顶部虽然提示 AI 生成内容可能有误、需要核实，但使用者没有注意。最后，建议在缺少药品标签和农技人员二次确认的情况下被直接执行。",
    },
    {
      scene: { type: "flow", duration: 17, headline: "AI 回答与专业用药决策", steps: [{ label: "识别限制", detail: "AI 可能混合公开资料，无法确认田间真实条件。" }, { label: "核对标签", detail: "确认登记作物、剂量、苗期与喷洒范围。" }, { label: "咨询人员", detail: "向当地农技或植保人员进行二次确认。" }, { label: "再做决定", detail: "关键用药不能由聊天回答单独决定。" }] },
      narration: "平台表示回答来自公开资料，并会登记相关情况，但信息来源广并不等于适用于眼前这块田。安全做法必须回到药品标签和登记作物，确认剂量、苗期、喷洒范围，再咨询当地农技或植保人员。关键用药不能用聊天回答代替专业判断。",
    },
    {
      scene: { type: "outro", duration: 17, headline: "高风险问题必须建立核验链", bullets: ["先看药品标签和登记范围。", "再核对作物、苗期、剂量与天气。", "无法确认时停止施药并咨询专业人员。"] },
      narration: "对普通用户来说，最实用的规则很简单：AI 可以帮助整理问题，不能作为农业用药的唯一依据。先看标签和登记范围，再核对作物、苗期、剂量、天气与混配要求；任何一项无法确认，就先停止施药，向专业人员求证。一次谨慎核验，远比事后补救成本低。",
    },
  ], options);
}

function createChinaJoyAiProject(
  item: HotItem,
  options?: { width?: number; height?: number; fps?: number; screenshots?: WebScreenshot[]; index?: number },
): VideoProject {
  const title = speechFriendlyTitle(item.title);
  return createCuratedNewsProject(item, [
    {
      scene: { type: "title", duration: 10, kicker: "ChinaJoy 观察", headline: shortTitle(title, 42), subhead: "AI 技术进入内容生产与现场体验", sources: ["游戏产业", "智能机器人", "内容生产"] },
      narration: `${title}。第二十三届 ChinaJoy 展示出的变化，不只是机器人表演更吸睛，AI 也在进入游戏研发、三维生成、智能体交互和内容制作，展会则扩展到更广的年轻消费文化。`,
    },
    {
      scene: { type: "signal_chart", duration: 18, headline: "展会规模与内容供给", bars: [{ label: "国家和地区", value: 39, detail: "三十九个国家和地区参与。", color: "#18b7a5" }, { label: "参展企业", value: 90, detail: "九百多家企业，按比例展示。", color: "#7c6cff" }, { label: "展览面积", value: 14, detail: "十四万平方米。", color: "#facc15" }] },
      narration: "展会共有三十九个国家和地区、九百多家企业参与，面积达到十四万平方米。现场聚集五百多家游戏公司和团队，展示一千多款游戏产品。庞大的内容供给，让新技术直接接受现场反馈。",
    },
    {
      scene: { type: "briefing_points", duration: 18, headline: "AI 从幕后走到现场", source: "现场应用", title: "机器人与内容工具同时出现", summary: "宇树机器人进行动态展示，AI 也进入游戏和三维内容生产。", metrics: [{ label: "机器人", value: "动态展示" }, { label: "游戏研发", value: "AI 辅助" }, { label: "三维内容", value: "生成提效" }], points: ["宇树机器人展示舞蹈和武术动作。", "AI 用于游戏研发和三维内容生成。", "智能体交互让角色反馈更自然。"] },
      narration: "AI 从幕后走到现场。宇树机器人展示舞蹈和武术动作；游戏团队则把 AI 用于研发辅助、三维内容生成和智能体交互。对玩家来说，变化不只是技术标签，角色反馈、制作效率和互动方式都在改变。",
    },
    {
      scene: { type: "flow", duration: 17, headline: "AI 漫剧成为新的内容形态", steps: [{ label: "线下亮相", detail: "火龙漫剧首次大规模进入展会。" }, { label: "用户规模", detail: "上线不到半年，月活超过一千万。" }, { label: "制作变化", detail: "AI 参与角色、画面和内容生产。" }, { label: "消费验证", detail: "线下关注检验内容吸引力。" }] },
      narration: "火龙漫剧首次大规模在线下亮相。相关业务上线不到半年，月活跃用户超过一千万。AI 内容生产正在从演示样片走向连续消费，但用户是否留下，仍取决于故事、角色和更新质量。",
    },
    {
      scene: { type: "outro", duration: 17, headline: "技术扩展，经典内容仍是核心", bullets: ["经典游戏 IP 仍是主要流量入口。", "老字号、美妆和电商跨界进入。", "AI 要靠真实内容和消费体验证明价值。"] },
      narration: "经典游戏 IP 仍是核心流量来源，老字号、美妆和电商等品牌则跨界进入。ChinaJoy 正从游戏动漫展，变成连接技术、内容和年轻消费的综合场景。AI 能扩大生产能力，但最终仍要靠内容质量和真实体验。",
    },
  ], options);
}

function createAiCareerIndependenceProject(
  item: HotItem,
  options?: { width?: number; height?: number; fps?: number; screenshots?: WebScreenshot[]; index?: number },
): VideoProject {
  const title = speechFriendlyTitle(item.title);
  return createCuratedNewsProject(item, [
    {
      scene: { type: "title", duration: 10, kicker: "职场与人工智能", headline: shortTitle(title, 42), subhead: "与其等待工作变化，不如建立自己的行动能力", sources: ["工作依赖", "自主行动", "持续迭代"] },
      narration: `${title}。文章的核心不是保证人工智能永远无法替代任何人，而是提醒你：不要把生存完全交给雇主、岗位或单一技能。真正能穿越变化的，是持续学习、主动行动和把想法做成有价值成果的能力。`,
    },
    {
      scene: { type: "briefing_points", duration: 18, headline: "先看薪资依赖的问题", source: "文章观点", title: "工作可以是跳板，不能成为唯一身份", summary: "为了生活，只能长期做并非主动选择的工作。", metrics: [{ label: "依赖对象", value: "岗位与雇主" }, { label: "常见困境", value: "技能单一" }, { label: "转变方向", value: "建立替代能力" }], points: ["工作可以是积累经验和技能的跳板。", "只掌握本职岗位，难以理解收入系统。", "把身份、收入和未来都绑定在一个雇主身上。"] },
      narration: "文章把这种处境称为薪资依赖：为了生活，只能长期做并非主动选择的工作。工作可以是积累经验和技能的跳板；真正危险的是只掌握本职岗位，把身份、收入和未来都绑定在一个雇主身上。",
    },
    {
      scene: { type: "signal_chart", duration: 18, headline: "五项能力构成自主行动", bars: [{ label: "自主性", value: 5, detail: "主动发现机会并行动。", color: "#18b7a5" }, { label: "品味", value: 4, detail: "判断什么值得呈现。", color: "#7c6cff" }, { label: "说服力", value: 3, detail: "让别人理解成果价值。", color: "#facc15" }, { label: "毅力与迭代", value: 2, detail: "从错误和反馈中继续修正。", color: "#ff6b6b" }] },
      narration: "文章总结了五项能力：自主性，是没人要求时也能发现机会并行动；品味，是判断什么值得呈现；说服力，是让别人理解成果价值；毅力，是把错误看成过程；迭代，则是根据反馈不断修正方向。它们共同构成解决问题和选择方向的能力。",
    },
    {
      scene: { type: "flow", duration: 17, headline: "从想法走到可验证的成果", steps: [{ label: "选择问题", detail: "找到别人确实愿意解决的小问题。" }, { label: "做出工具", detail: "先完成规模可控的应用或服务。" }, { label: "获得反馈", detail: "观察使用者是否真的在意结果。" }, { label: "持续迭代", detail: "修正方法，再扩大有效部分。" }] },
      narration: "人工智能降低了做软件和内容的门槛，但能生成一个东西，不等于它值得构建，也不等于别人会在意。更实际的路径，是从一个规模可控、能解决真实问题的小工具开始，观察反馈，修正方法，再决定是否扩大。",
    },
    {
      scene: { type: "outro", duration: 17, headline: "真正的改变从今天的小行动开始", bullets: ["不要只在社交媒体表达焦虑。", "用一个小项目练习自主性和迭代。", "完成后核对价值、反馈和长期边界。"] },
      narration: "这篇文章最后给出的方向很具体：少一点对变化的抱怨，多做一件属于自己的小事。用一个小项目练习自主性和迭代，可以是一个工具、一项服务，或者一次可验证的内容实践。完成后核对价值、反馈和长期边界，再根据真实反馈改进；这样积累的，是面对下一次变化仍能重新行动的能力。",
    },
  ], options);
}

function createAiMathBreakthroughProject(
  item: HotItem,
  options?: { width?: number; height?: number; fps?: number; screenshots?: WebScreenshot[]; index?: number },
): VideoProject {
  const storyItem = /36kr\.com\/p\/3921682068172419/i.test(item.url)
    ? { ...item, title: "突发！OpenAI下一代AI攻克10项菲尔兹奖级难题" }
    : item;
  const title = speechFriendlyTitle(storyItem.title);
  return createCuratedNewsProject(storyItem, [
    {
      scene: { type: "title", duration: 10, kicker: "AI 数学推理", headline: shortTitle(title, 42), subhead: "多项数学结果公开，最终仍需同行复核", sources: ["数学证明", "形式化验证", "同行复核"] },
      narration: `${title}。报道介绍 OpenAI 下一代模型 Astra 在多项长期未解数学问题上给出的证明和反例，但最终结论仍需专家复核。`,
    },
    {
      scene: { type: "briefing_points", duration: 18, headline: "这次公开了什么", source: "论文内容", title: "从多个领域给出证明与反例", summary: "问题涉及几何、编码、群论、算子代数和组合学。", metrics: [{ label: "论文篇幅", value: "249 页" }, { label: "讨论问题", value: "10 项" }, { label: "验证方式", value: "Lean 4" }], points: ["结果覆盖高维几何、编码理论和群论等方向。", "部分问题已有多年没有明显进展。", "论文同时提供了形式化证明和可检查的验证材料。"] },
      narration: "材料是一份二百四十九页的论文，讨论十项数学问题，覆盖高维几何、编码理论、群论和算子代数等方向，并附 Lean 4 形式化验证，便于逐步检查。这次公开的重点，就是十项问题、249页论文和Lean 4验证入口，读者可以按问题逐项检查。",
    },
    {
      scene: { type: "flow", duration: 18, headline: "三个代表性问题", steps: [{ label: "非 sofic 群", detail: "构造反例，挑战所有可数群都具备该性质的猜想。" }, { label: "高维球体堆积", detail: "讨论无限维度下的密度边界。" }, { label: "刚性猜想", detail: "给出群与算子代数关系的反例构造。" }, { label: "共同特点", detail: "从具体结构出发，再用形式化步骤核验。" }] },
      narration: "重点包括非 sofic 群反例、高维球体堆积的密度边界，以及刚性猜想反例。三个代表性问题分别是非 sofic 群、高维球体堆积和刚性猜想。共同点是先构造数学结构，再用形式化步骤检查推理。",
    },
    {
      scene: { type: "signal_chart", duration: 17, headline: "为什么这件事值得关注", bars: [{ label: "跨领域", value: 4, detail: "多个数学方向同时出现结果。", color: "#18b7a5" }, { label: "可复核", value: 3, detail: "附带 Lean 4 形式化材料。", color: "#7c6cff" }, { label: "成本", value: 2, detail: "报道估算总成本不到 2000 美元。", color: "#facc15" }] },
      narration: "关注点有三：跨领域结果、Lean 4 复核入口，以及按接口价格估算总成本不到二千美元。这正是它值得关注的原因：跨领域、可复核，还有成本这一项。但低成本不等于结论成立，仍要看证明、假设和独立复现。",
    },
    {
      scene: { type: "outro", duration: 17, headline: "不要把新闻标题当成最终定论", bullets: ["区分报道表述与学界确认。", "检查完整论文、形式化证明和假设。", "等待独立复核，再判断长期影响。"] },
      narration: "现在能确认的是材料已经公开，不能确认所有结果都已被学界接受。还要区分报道摘要、作者解释和正式证明，检查完整论文、证明假设、独立复现和同行评议，核对定义、边界条件和机器证书是否完整，再判断它对数学研究和人工智能推理的长期影响。",
    },
  ], options);
}

function withGroundedFactReferences(project: VideoProject) {
  const factLedger = buildFactLedger(project.sources);
  const groundedClaimIds = (text: string) => {
    const candidates = claimIdsForText(factLedger, text, 8);
    const safe = candidates.filter((claimId) => {
      const claim = factLedger.claims.find((item) => item.id === claimId);
      return claim?.qualifiers.every((qualifier) => text.includes(qualifier));
    });
    return (safe.length ? safe : candidates).slice(0, 2);
  };
  const referencedScenes = project.scenes.map((scene) => ({ ...scene, claimIds: groundedClaimIds(sceneFactText(scene)) })) as VideoScene[];
  return {
    ...project,
    factLedger,
    titleClaimIds: groundedClaimIds(project.meta.title),
    scenes: referencedScenes,
    narrationSegments: project.narrationSegments?.map((segment) => ({
      ...segment,
      claimIds: groundedClaimIds(`${sceneFactText(referencedScenes[segment.sceneIndex])} ${segment.text}`),
    })),
  };
}

function createLoopGraphEngineeringProject(
  item: HotItem,
  options?: { width?: number; height?: number; fps?: number; screenshots?: WebScreenshot[]; index?: number },
): VideoProject {
  const storyItem: HotItem = { ...item, contentType: "technical-article", title: "Loop才火了六周，AI Coding为什么又开始谈Graph？" };
  return createCuratedNewsProject(storyItem, [
    {
      scene: { type: "title", duration: 10, kicker: "技术架构解析", headline: storyItem.title, subhead: "Loop 负责单点迭代，Graph 负责多任务协作", sources: ["任务拆分", "状态流转", "成本控制"] },
      narration: `${storyItem.title} Loop 擅长让一个智能体反复检查、修改和重试；Graph 解决的是多个工作单元如何分工、并行、交接和恢复。两者不是替代关系，而是处理不同层级的问题。`,
    },
    {
      scene: { type: "briefing_points", duration: 18, headline: "Loop 反复修改，Graph 管理协作", source: "架构分析", title: "单点迭代与全局编排", summary: "同一个智能体读取结果、发现问题、修改后再次执行。", metrics: [{ label: "Loop", value: "修改重试" }, { label: "Graph", value: "分支并行" }, { label: "组合方式", value: "节点内循环" }], points: ["Loop 让同一个智能体读取结果并持续修改。", "Graph 把复杂目标拆成节点，用共享状态管理分支、并行、回退与交接。", "Graph 节点内部仍然可以运行 Loop。"] },
      narration: "Loop 适合边做边检查：同一个智能体读取结果、发现问题、修改后再次执行。Graph 则把复杂目标拆成节点，通过边和共享状态管理分支、并行、回退与交接。实际系统中，一个 Graph 节点内部完全可以继续运行 Loop。",
    },
    {
      scene: { type: "flow", duration: 18, headline: "Graph 带来的工程能力", steps: [{ label: "拆分", detail: "把可独立验证的工作变成节点。" }, { label: "并行", detail: "无依赖任务可以同时执行。" }, { label: "路由", detail: "根据状态选择下一条路径。" }, { label: "恢复", detail: "失败节点可重试、回退或交接。" }] },
      narration: "Graph 的价值不是多放几个智能体，而是把任务依赖显式化。可独立验证的工作变成节点，无依赖任务可以并行，路由器根据状态选择下一步；某个节点失败时，也能局部重试、回退或交给其他节点，而不是全部重来。",
    },
    {
      scene: { type: "signal_chart", duration: 18, headline: "多智能体并不总是更好", bars: [{ label: "金融任务提升", value: 80.8, detail: "研究报告中的最高提升。", color: "#18b7a5" }, { label: "Plan Craft 下降", value: 70, detail: "部分任务最高下降幅度。", color: "#ff6b6b" }, { label: "额外令牌", value: 15, detail: "可能约为聊天模式十五倍。", color: "#facc15" }] },
      narration: "多智能体并不天然更强。文章引用的研究里，部分金融任务最高提升百分之八十点八，但 Plan Craft 的表现最高下降百分之七十，软件工程基准也出现百分之一点三到十二点八的下降。多智能体令牌消耗还可能达到聊天模式的十五倍左右。",
    },
    {
      scene: { type: "outro", duration: 16, headline: "只在任务确实可拆时使用 Graph", bullets: ["适合可拆分、可独立验证的复杂任务。", "简单或强顺序任务优先保留 Loop。", "从最小图开始，持续观察状态、成本和恢复效果。"] },
      narration: "选择标准应该回到任务本身。能拆分、能独立验证、需要并行或故障恢复时，Graph 才有价值；简单任务和强顺序任务，Loop 往往更直接。工程上应从能可靠完成任务的最小图开始，持续观察路由、状态、成本和恢复效果。",
    },
  ], options);
}

function createNeonRetrievalModelProject(
  item: HotItem,
  options?: { width?: number; height?: number; fps?: number; screenshots?: WebScreenshot[]; index?: number },
): VideoProject {
  const title = speechFriendlyTitle(item.title);
  return createCuratedNewsProject(item, [
    {
      scene: { type: "title", duration: 9, kicker: "开源检索模型", headline: title, subhead: "用途：让智能体更便宜地搜索企业文档；适合知识库和检索任务", sources: ["4B 参数", "文档搜索", "成本约为 1/100"] },
      narration: `${title}。这款四 B 模型专门让智能体更便宜地搜索文档，新闻日期：2026年8月7日。`,
    },
    {
      scene: { type: "briefing_points", duration: 13, headline: "它解决的是智能体搜索太贵", source: "公开信息", title: "从找到文档到找到正确上下文", summary: "模型负责判断该搜什么，文档库负责提供检索位置。", metrics: [{ label: "模型规模", value: "4B" }, { label: "任务", value: "文档搜索" }], points: ["把复杂问题拆成多个查询。", "根据搜索结果决定下一步。", "适合企业知识库和研究型 Agent。"] },
      narration: "它解决的是智能体搜索太贵：模型会把复杂问题拆成小查询，根据结果决定下一步，再找到能支撑答案的文档和段落。",
    },
    {
      scene: { type: "signal_chart", duration: 10, headline: "公开验证中，搜索质量超过对照模型", bars: [{ label: "后训练模型", value: 1.447, detail: "公开验证平均分 1.447。", color: "#18b7a5" }, { label: "GPT-5.6 Sol", value: 1.369, detail: "对照结果为 1.369。", color: "#7c6cff" }, { label: "GPT-5.4", value: 1.377, detail: "另一组对照为 1.377。", color: "#facc15" }] },
      narration: "在公开验证中，这款模型平均分一点四四七，高于 GPT 五点六 Sol 的一点三六九和 GPT 五点四的一点三七七；评测只针对文档搜索，不能代表所有任务。",
    },
    {
      scene: { type: "outro", duration: 9, headline: "适合知识库，不是通用模型替代品", bullets: ["先用自己的文档验证召回和引用。", "重点观察延迟、成本和答案准确率。", "复杂任务仍要保留人工复核。"] },
      narration: "它更适合企业知识库和检索型 Agent。落地前先用自己的文档验证召回、引用和延迟，别把一次专项评测直接当成通用能力证明。",
    },
  ], options);
}

function createChatGptFreeUpgradeProject(
  item: HotItem,
  options?: { width?: number; height?: number; fps?: number; screenshots?: WebScreenshot[]; index?: number },
): VideoProject {
  const title = speechFriendlyTitle(item.title);
  return createCuratedNewsProject(item, [
    {
      scene: { type: "title", duration: 9, kicker: "产品更新", headline: title, subhead: "免费用户可使用新版聊天模型，但图片和文件额度仍有限", sources: ["免费版", "聊天模式", "功能分批推送"] },
      narration: `${title}。免费用户现在可以使用新版聊天模型，聊天次数限制取消，但图片和文件额度仍然保留；新闻日期：2026年8月7日。`,
    },
    {
      scene: { type: "briefing_points", duration: 11, headline: "变化首先发生在免费聊天入口", source: "产品信息", title: "默认模型与聊天额度调整", summary: "免费用户获得新版模型的聊天访问，功能会在一周内陆续推送。", metrics: [{ label: "覆盖对象", value: "免费用户" }, { label: "聊天额度", value: "取消次数限制" }, { label: "推送方式", value: "分批开放" }], points: ["默认模型切换到新版。", "日常问答不再受原有次数限制。", "不同账号的到账时间可能不同。"] },
      narration: "变化首先发生在免费聊天入口：默认模型切换到新版，日常问答不再受原有次数限制，但功能会分批推送，不同账号的到账时间可能不同。",
    },
    {
      scene: { type: "briefing_points", duration: 10, headline: "付费用户得到的是更稳定的回答风格", source: "模型更新说明", title: "回答更聚焦，复杂任务更完整", summary: "新版会根据问题调整回答详细程度，减少格式堆砌和无效附和。", metrics: [{ label: "简单问题", value: "直接回答" }, { label: "复杂任务", value: "补充上下文" }, { label: "重点", value: "事实与质量" }], points: ["快速问题优先给结论。", "规划、研究和写作保留必要上下文。", "回答不再为了显得完整而堆格式。"] },
      narration: "新版的核心改进不是把每次回答写得更长，而是按问题调整详细程度：简单问题直接给结论，规划、研究和写作保留必要上下文，减少格式堆砌和无效附和。",
    },
    {
      scene: { type: "outro", duration: 8, headline: "免费不等于所有功能无限", bullets: ["聊天额度放开。", "图片生成和文件上传仍有限制。", "复杂任务仍要看实际稳定性。"] },
      narration: "结论很简单：免费聊天更宽松了，但图片生成、文件上传等功能仍有限制。它适合日常问答和轻量研究，重要结论仍要自己核对。",
    },
  ], options);
}

function createWan30DocumentVideoProject(
  item: HotItem,
  options?: { width?: number; height?: number; fps?: number; screenshots?: WebScreenshot[]; index?: number },
): VideoProject {
  const title = speechFriendlyTitle(item.title);
  return createCuratedNewsProject(item, [
    {
      scene: { type: "title", duration: 9, kicker: "视频生成模型", headline: title, subhead: "用途：把文档和演示材料变成带叙事的完整视频", sources: ["文档输入", "完整故事", "公测版本"] },
      narration: `${title}。它把文档和演示材料直接变成完整视频，新闻日期：2026年8月7日。`,
    },
    {
      scene: { type: "briefing_points", duration: 11, headline: "输入不再局限于提示词", source: "产品信息", title: "文档可以直接进入生成流程", summary: "支持 doc、xls、ppt、pdf 和 md 等常见格式。", metrics: [{ label: "输入格式", value: "DOC、XLS、PPT" }, { label: "补充格式", value: "PDF、MD" }, { label: "目标", value: "完整叙事" }], points: ["先读取文档结构和要点。", "再把内容组织成镜头和段落。", "适合课程、汇报和产品说明。"] },
      narration: "它的关键变化是输入方式：文档、表格、演示稿、PDF 和 Markdown 都能直接进入生成流程，系统先读取结构，再组织镜头和旁白，适合课程、汇报和产品说明。",
    },
    {
      scene: { type: "flow", duration: 10, headline: "从单个镜头走向连续故事", steps: [{ label: "读取", detail: "提取文档中的结构和重点。" }, { label: "规划", detail: "把重点安排成连续段落。" }, { label: "生成", detail: "保持人物和画面逻辑。" }, { label: "调整", detail: "按提示修改时长和节奏。" }] },
      narration: "生成流程会先读取内容，再规划段落和镜头，最后保持人物与画面逻辑。智能时长功能还能根据提示推荐更合适的片段长度，减少反复试错。",
    },
    {
      scene: { type: "outro", duration: 8, headline: "公测阶段先验证内容一致性", bullets: ["适合文档转视频和快速演示。", "复杂材料仍要检查事实和画面。", "人物、文字和节奏需要逐段复核。"] },
      narration: "它更适合把长文档快速变成可看的初稿。公测阶段不要只看画面是否清晰，还要逐段检查事实、文字、人物一致性和旁白节奏。",
    },
  ], options);
}

function createQwen38Project(
  item: HotItem,
  options?: { width?: number; height?: number; fps?: number; screenshots?: WebScreenshot[]; index?: number },
): VideoProject {
  const storyItem = { ...item, title: "阿里Qwen3.8正式发布，编程与办公再进化，推理更快更稳定" };
  return createCuratedNewsProject(storyItem, [
    {
      scene: { type: "title", duration: 10, kicker: "大模型更新", headline: storyItem.title, subhead: "视觉理解、百万上下文与长任务能力同步升级", sources: ["模型规模", "公开评测", "专业任务"] },
      narration: `${storyItem.title}。Qwen3.8-Max 是这次更新的旗舰模型，重点覆盖编程、办公、视觉理解和长时间智能体任务。公开信息给出的模型规模是总参数二点四万亿，单次激活九百五十亿参数。`,
    },
    {
      scene: { type: "briefing_points", duration: 18, headline: "模型规模与输入能力", source: "公开信息", title: "更大规模，同时支持视觉输入", summary: "支持视觉理解和一百万 Tokens 上下文。", metrics: [{ label: "总参数", value: "2.4T" }, { label: "激活参数", value: "95B" }, { label: "上下文", value: "1M Tokens" }], points: ["旗舰模型采用大规模稀疏激活结构。", "支持图像和视觉内容理解。", "长上下文可处理更大规模的材料与任务记录。"] },
      narration: "核心规格有三项：总参数二点四万亿，单次激活九百五十亿参数，并支持一百万 Tokens 的上下文。模型还能理解图像和视觉内容。这些能力让它可以同时处理更长资料、更多工具反馈和更复杂的办公内容。",
    },
    {
      scene: { type: "signal_chart", duration: 18, headline: "公开基准覆盖研究与智能体", bars: [{ label: "PaperBench", value: 93, detail: "公开结果为九十三点零。", color: "#18b7a5" }, { label: "WideSearch", value: 81.9, detail: "公开结果为八十一点九。", color: "#7c6cff" }, { label: "OSWorld", value: 86.1, detail: "公开结果为八十六点一。", color: "#facc15" }] },
      narration: "公开基准里，PaperBench 得分九十三点零，WideSearch 是八十一点九，OSWorld Verified 是八十六点一。Agent's Last Exam 为五十二点四，GPQA Diamond 为九十二点六。这些是发布方报告的评测结果，不能直接等同于每个真实业务的效果。",
    },
    {
      scene: { type: "flow", duration: 18, headline: "十六天编程与多类专业任务", steps: [{ label: "编程示例", detail: "持续约十六天，完成智能体执行框架。" }, { label: "文档工作", detail: "覆盖法律文档审查和多步骤办公任务。" }, { label: "分析任务", detail: "处理体育视频分析与量化研究。" }, { label: "落地检查", detail: "限制权限、保存过程并检查最终结果。" }] },
      narration: "更新强调的不只是单次问答。编程示例展示了持续约十六天的自动任务，用来完成一套智能体执行框架；专业任务还覆盖法律文档审查、体育视频分析、量化研究和视觉操作。真正落地时，仍要限制权限、保存过程并检查最终结果。",
    },
    {
      scene: { type: "outro", duration: 16, headline: "真实价值要在自己的任务里验证", bullets: ["用现有工作流测试稳定性与准确率。", "长上下文不等于关键信息不会遗漏。", "高风险任务保留人工复核和权限边界。"] },
      narration: "对使用者来说，最重要的不是追逐单项分数，而是拿自己的代码、文档和长任务验证稳定性、延迟与准确率。百万上下文不代表关键信息一定不会遗漏，长时间执行也需要预算、权限和停止条件。高风险结论仍应由专业人员复核。",
    },
  ], options);
}

function createQwenOpenPlatformProject(
  item: HotItem,
  options?: { width?: number; height?: number; fps?: number; screenshots?: WebScreenshot[]; index?: number },
): VideoProject {
  const title = speechFriendlyTitle(item.title);
  return createCuratedNewsProject(item, [
    {
      scene: { type: "title", duration: 10, kicker: "服务接入", headline: title, subhead: "把租房、寄快递和理财等服务放进对话流程", sources: ["手机", "PC", "AI 眼镜"] },
      narration: `${title}。真正的变化，是用户可以在对话里直接调用租房、寄快递和理财等服务，不必反复切换应用。`,
    },
    {
      scene: { type: "briefing_points", duration: 14, headline: "开放平台先解决服务入口问题", source: "平台信息", title: "生态伙伴可以接入独立智能体", summary: "平台面向生态伙伴和开发者开放手机、PC 与 AI 眼镜三类终端服务接入。", metrics: [{ label: "终端", value: "手机 / PC / AI 眼镜" }, { label: "伙伴", value: "十多个领域" }, { label: "入口", value: "@服务或智能体" }], points: ["第三方可以创建独立对话空间。", "用户可以通过 @相关服务或点击智能体进入。", "首批伙伴覆盖物流、居住、本地生活、理财和汽车等领域。"] },
      narration: "平台面向生态伙伴和开发者开放手机、PC、AI 眼镜三类终端接入。第三方可以创建独立对话空间，用户通过 @相关服务或点击智能体进入；首批覆盖物流、居住、本地生活、理财和汽车等十多个领域。",
    },
    {
      scene: { type: "flow", duration: 13, headline: "一次对话可以串起完整服务", steps: [{ label: "提出需求", detail: "直接说清楚要租房、寄件或查询服务。" }, { label: "理解规划", detail: "智能体结合上下文整理下一步。" }, { label: "调用服务", detail: "进入伙伴提供的专业流程。" }, { label: "完成办理", detail: "在授权范围内完成咨询、推荐或履约。" }] },
      narration: "它的实际用法不是多一个聊天窗口，而是把服务流程接进对话。用户先说清需求，智能体理解并规划，再调用伙伴的专业能力；例如寄件时，可以记住地址，减少重复填写，最后在授权范围内完成办理。",
    },
    {
      scene: { type: "outro", duration: 8, headline: "接入越深，权限边界越重要", bullets: ["适合已有服务和智能体的开发团队。", "先从一个低风险流程验证授权与履约。", "涉及账户、支付和订单时保留人工确认。"] },
      narration: "它适合已经有服务能力、想减少用户操作步骤的团队。接入账户、支付和订单前，要先用低风险流程验证授权、日志和履约结果，高风险动作仍需人工确认。",
    },
  ], options, { maxSeconds: 50, minSeconds: 45 });
}

function createSenseNovaU15Project(
  item: HotItem,
  options?: { width?: number; height?: number; fps?: number; screenshots?: WebScreenshot[]; index?: number },
): VideoProject {
  const storyItem = { ...item, title: "原生支持4K图像生成，商汤科技开源多模态模型SenseNova U1.5-Lite-Preview预览版本" };
  return createCuratedNewsProject(storyItem, [
    {
      scene: { type: "title", duration: 10, kicker: "多模态模型", headline: storyItem.title, subhead: "轻量统一架构加入原生 4K 图像生成", sources: ["8B-MoT", "4K 生成", "预览版本"] },
      narration: `${storyItem.title}。这是一个八十亿规模的轻量统一多模态模型，重点是原生四 K 图像生成、更准确的中英文文字，以及更稳定的图像编辑。需要注意，它目前仍是预览版本。`,
    },
    {
      scene: { type: "briefing_points", duration: 18, headline: "轻量模型加入原生 4K 生成", source: "模型信息", title: "SenseNova U1.5-Lite-Preview", summary: "八十亿规模的混合架构，同时处理理解、生成和编辑。", metrics: [{ label: "模型规模", value: "8B-MoT" }, { label: "图像分辨率", value: "4K" }, { label: "版本状态", value: "Preview" }], points: ["统一模型覆盖视觉理解与图像生成。", "原生输出四 K 图像，不依赖简单放大。", "轻量定位面向部署和试验场景。"] },
      narration: "这款模型采用八十亿规模的混合架构，把视觉理解、图像生成和编辑放进统一模型。它可以原生生成四 K 图像，不是先生成低分辨率再简单放大。轻量版本面向部署和试验场景，但实际资源需求仍要以模型说明为准。",
    },
    {
      scene: { type: "signal_chart", duration: 18, headline: "画面细节与文字生成得到加强", bars: [{ label: "原生图像", value: 4, detail: "支持原生四 K 图像生成。", color: "#18b7a5" }, { label: "模型规模", value: 8, detail: "八十亿规模的混合架构。", color: "#7c6cff" }, { label: "版本序列", value: 1.5, detail: "U1.5 Lite Preview 预览版本。", color: "#facc15" }] },
      narration: "U1.5 Lite Preview 是八十亿规模的混合架构，并支持原生四 K 图像生成。图像改进集中在局部纹理、细节和真实感，也包括中英文文字与复杂布局组织。具体效果仍受提示词、构图复杂度和输出场景影响。",
    },
    {
      scene: { type: "flow", duration: 18, headline: "编辑和视觉指令更稳定", steps: [{ label: "理解输入", detail: "识别画面主体、关系和编辑要求。" }, { label: "局部修改", detail: "尽量只改变指定区域或属性。" }, { label: "保持一致", detail: "保持主体身份和整体风格。" }, { label: "复核结果", detail: "检查文字、细节和未指定区域。" }] },
      narration: "图像编辑方面，模型强调更稳定的视觉指令跟随。理想流程是先理解主体和修改要求，只调整指定区域或属性，并尽量保持身份、布局和风格一致。实际使用仍要逐张检查文字、手部、局部细节和没有要求修改的区域。",
    },
    {
      scene: { type: "outro", duration: 16, headline: "预览版本适合验证，不宜过度承诺", bullets: ["适合海报、信息图和高分辨率内容试验。", "公开说明称多项生成与编辑指标超过上一代。", "正式生产前验证稳定性、资源占用与许可边界。"] },
      narration: "公开说明称，它在多项图像生成和编辑基准上超过上一代 U1，但这仍是模型方给出的结果。当前更适合用于海报、信息图和高分辨率内容试验。进入正式生产前，应继续验证稳定性、资源占用、文字准确率和模型许可边界。",
    },
  ], options);
}

function createSandMagi2Project(
  item: HotItem,
  options?: { width?: number; height?: number; fps?: number; screenshots?: WebScreenshot[]; index?: number },
): VideoProject {
  const storyItem: HotItem = {
    ...item,
    title: item.title,
    contentType: "technical-article",
  };
  return createCuratedNewsProject(storyItem, [
    {
      scene: { type: "title", duration: 9, kicker: "技术路线", headline: storyItem.title, subhead: "用途：统一生成视频、音频和文本，稀疏激活控制单次计算量", sources: ["114B 总参数", "6B 激活", "统一音视频"] },
      narration: `${storyItem.title}。模型已正式发布并开源。`,
    },
    {
      scene: { type: "briefing_points", duration: 13, headline: "视频模型撞上容量和成本两堵墙", source: "技术事实", title: "长序列放大计算压力", summary: "几秒视频就可能形成几十万到上百万视觉 Token。", metrics: [{ label: "总参数", value: "114B" }, { label: "单次激活", value: "6B" }], points: ["视频还要叠加音频和文本指令。", "稠密模型越大，每次调用参数量同步增加。", "MoE 用稀疏激活扩容量、控成本。"] },
      narration: "几秒视频就要处理几十万到上百万视觉 Token，还叠加声音和文本。稠密模型越大，每次调用越贵，容量和成本成为两堵墙。",
    },
    {
      scene: { type: "flow", duration: 13, headline: "统一单流让音画从生成开始协同", steps: [{ label: "同一上下文", detail: "文本、视频和音频进入同一个 Transformer。" }, { label: "持续交互", detail: "每层自注意力共同建模口型、动作和声音。" }, { label: "共享专家", detail: "处理场景语义与运动等共性。" }, { label: "专属专家", detail: "分别处理不同模态的差异。" }] },
      narration: "文本、画面和音频进入同一个 Transformer，从生成开始联合建模口型、动作和声音；共享专家处理共性，专属专家负责不同模态。",
    },
    {
      scene: { type: "signal_chart", duration: 13, headline: "细粒度路由重写通信方式", bars: [{ label: "隐藏表示", value: 3072, detail: "一个 Token 的完整表示。", color: "#18b7a5" }, { label: "子空间", value: 12, detail: "拆成十二个独立路由子空间。", color: "#7c6cff" }, { label: "每组维度", value: 256, detail: "每个子空间各自选择专家。", color: "#facc15" }] },
      narration: "细粒度路由重写通信方式：它把三千零七十二维表示拆成十二个二百五十六维子空间独立路由，三十六层网络配合 Head Parallel，让主要通信量取决于输入表示。",
    },
    {
      scene: { type: "outro", duration: 12, headline: "这是扩展路线验证，不是低成本保证", bullets: ["MagiMoE 优化路由与专家计算。", "MagiMuon 支撑分布式训练。", "榜单第六和开源证明路线可运行，实际成本仍需测试。"] },
      narration: "这是路线验证，不是低成本保证。MagiMoE 负责算子，MagiMuon 负责分布式优化；模型在 Artificial Analysis 图生视频榜单排第六并全面开源，实际成本仍需测试。",
    },
  ], options);
}

function createAiOfficeCompetitionProject(
  item: HotItem,
  options?: { width?: number; height?: number; fps?: number; screenshots?: WebScreenshot[]; index?: number },
): VideoProject {
  const storyItem: HotItem = { ...item, title: item.title, contentType: "technical-article" };
  return createCuratedNewsProject(storyItem, [
    {
      scene: { type: "title", duration: 9, kicker: "行业变化", headline: storyItem.title, subhead: "工作起点从打开软件变成直接交代任务", sources: ["独立 Agent", "嵌入流程", "任务交付"] },
      narration: `${storyItem.title}。真正变化是，用户不再先打开某个软件，而是直接告诉 Agent 要完成什么。`,
    },
    {
      scene: { type: "briefing_points", duration: 13, headline: "厂商同时押注两条路线", source: "公开产品信息", title: "新入口与旧流程并行", summary: "独立办公 Agent 从零建立入口，原有协同产品把 AI 嵌入聊天、文档和审批。", metrics: [{ label: "路线", value: "2 条" }, { label: "竞争单位", value: "任务" }], points: ["腾讯同时推进 WorkBuddy 和企业微信 AI 助理。", "字节同时推进豆包专业版与飞书内的企业版。", "金山和阿里也在独立入口与原有产品之间并行。"] },
      narration: "厂商同时押注两条路线：独立办公 Agent 从零建立入口，原有协同产品把 AI 嵌入聊天、文档和审批。两条路线服务的工作起点不同。",
    },
    {
      scene: { type: "signal_chart", duration: 13, headline: "用户愿意为完整任务付费", bars: [{ label: "豆包专业版", value: 68, detail: "标准档每月六十八元。", color: "#18b7a5" }, { label: "WorkBuddy", value: 99, detail: "标准档每月九十九元。", color: "#7c6cff" }, { label: "灵犀专业版", value: 50, detail: "预期月费五十元起。", color: "#facc15" }] },
      narration: "付费也开始围绕任务能力展开：豆包专业版标准档每月六十八元，WorkBuddy 标准档九十九元，灵犀专业版预期五十元起。",
    },
    {
      scene: { type: "flow", duration: 13, headline: "真正价值是接手重复劳动", steps: [{ label: "理解目标", detail: "用户直接描述要完成的业务结果。" }, { label: "调用工具", detail: "跨数据、文档和业务系统执行。" }, { label: "交付结果", detail: "完成报告、分析或整条工作链。" }, { label: "人工判断", detail: "把需要经验的决策留给人。" }] },
      narration: "真正价值是接手重复劳动：用户直接描述业务目标，Agent 跨数据、文档和业务系统调用工具，交付报告、分析或完整工作链；需要经验的判断仍然留给人。",
    },
    {
      scene: { type: "outro", duration: 12, headline: "文件不会消失，但不再是唯一入口", bullets: ["工作单位从文件转向完整任务。", "定价从席位逐步转向价值交付。", "稳定性和组织改造仍是落地门槛。"] },
      narration: "文件不会消失，但不再是唯一入口；定价也会从席位逐步转向任务和价值交付。当前 Agent 稳定性仍不足，企业落地更取决于流程和组织改造。",
    },
  ], options);
}

function createModelKillZoneProject(
  item: HotItem,
  options?: { width?: number; height?: number; fps?: number; screenshots?: WebScreenshot[]; index?: number },
): VideoProject {
  const storyItem: HotItem = { ...item, title: item.title, contentType: "technical-article" };
  return createCuratedNewsProject(storyItem, [
    {
      scene: { type: "title", duration: 9, kicker: "竞争指标", headline: storyItem.title, subhead: "能力更强、完成任务更便宜，才在安全区", sources: ["任务成功率", "端到端成本", "Agent Harness"] },
      narration: `${storyItem.title}。真正的斩杀线，不再看一次回答多便宜，而是看完整任务能否成功交付。`,
    },
    {
      scene: { type: "signal_chart", duration: 13, headline: "V4 Flash 0731把性价比边界推向左上", bars: [{ label: "0731 新版", value: 50, detail: "Intelligence Index 五十分。", color: "#18b7a5" }, { label: "上一版", value: 40, detail: "同一指数四十分。", color: "#7c6cff" }, { label: "最接近对手", value: 51, detail: "高一分，但每任务成本更高。", color: "#facc15" }] },
      narration: "DeepSeek V4 Flash 0731 的指数从四十分升到五十分。最接近的对手得五十一分，但降价后每任务成本仍高约百分之六十。",
    },
    {
      scene: { type: "flow", duration: 13, headline: "多步骤把小差距放大", steps: [{ label: "单步能力", detail: "准确率百分之九十五和百分之九十。" }, { label: "连续执行", detail: "二十步后约为百分之三十六和百分之十二。" }, { label: "失败重试", detail: "中途失败需要重新支付 Token。" }, { label: "最终成本", detail: "能力不足直接变成额外支出。" }] },
      narration: "Agent 会放大能力和成本差距。单步能力的准确率分别为百分之九十五和百分之九十，连续执行二十步后，成功率约为百分之三十六和百分之十二；失败重试会继续增加最终成本。",
    },
    {
      scene: { type: "briefing_points", duration: 13, headline: "模型只是系统中的一个部件", source: "评测方法", title: "Harness会改变结果", summary: "同一个模型接入不同 Agent，耗时和 Token 消耗可能明显不同。", metrics: [{ label: "测试框架", value: "4 个" }, { label: "消耗差距", value: "约 4 倍" }], points: ["真实 Bug 修复测试中，四个 Agent 的消耗与耗时相差约四倍。", "统一 Harness 才能比较模型本身。", "业务使用仍要用自己的工具链复测。"] },
      narration: "模型只是系统中的一个部件。同一模型接入四个 Agent，真实修复任务的耗时和 Token 消耗相差约四倍；统一 Harness 之后，模型比较才更可信。",
    },
    {
      scene: { type: "outro", duration: 12, headline: "斩杀线会继续上移", bullets: ["模型能力提高，基础设施成本下降。", "切换成本低，优势很难变成永久壁垒。", "基准结论必须回到真实任务验证。"] },
      narration: "斩杀线会继续上移，因为模型在进步，推理成本也在下降。但性价比优势需要持续投入才能维持，任何基准结论都必须回到自己的真实任务验证。",
    },
  ], options);
}

function createAiIndustrialDemandProject(
  item: HotItem,
  options?: { width?: number; height?: number; fps?: number; screenshots?: WebScreenshot[]; index?: number },
): VideoProject {
  const storyItem: HotItem = { ...item, title: item.title, contentType: "technical-article" };
  return createCuratedNewsProject(storyItem, [
    {
      scene: { type: "title", duration: 9, kicker: "产业链扩散", headline: storyItem.title, subhead: "服务器进机房前，先要平整土地、施工和接电", sources: ["工程机械", "备用发电", "工业设备"] },
      narration: `${storyItem.title}。真正变化是，算力需求开始外溢到实体基建；服务器进机房前，数据中心先需要土地、施工、电力和备用发电。`,
    },
    {
      scene: { type: "signal_chart", duration: 13, headline: "卡特彼勒财报出现基建信号", bars: [{ label: "季度营收", value: 205.4, detail: "二百零五点四亿美元，同比增长百分之二十四。", color: "#18b7a5" }, { label: "新增订单", value: 94, detail: "九十四亿美元。", color: "#7c6cff" }, { label: "积压订单", value: 721, detail: "七百二十一亿美元，创纪录。", color: "#facc15" }] },
      narration: "卡特彼勒第二季度营收二百零五点四亿美元，同比增长百分之二十四；新增订单九十四亿美元，积压订单达到创纪录的七百二十一亿美元。",
    },
    {
      scene: { type: "flow", duration: 13, headline: "算力建设沿实体链条传导", steps: [{ label: "土地开发", detail: "场地平整和厂房施工。" }, { label: "工程设备", detail: "挖掘机、推土机参与建设。" }, { label: "电力接入", detail: "扩建电网和能源系统。" }, { label: "备用发电", detail: "保障数据中心稳定运行。" }] },
      narration: "算力建设沿实体链条传导：土地开发带动工程机械，电力缺口带动能源系统和备用发电。芯片只是起点，数据中心本身是一项大型基建工程。",
    },
    {
      scene: { type: "briefing_points", duration: 13, headline: "传统制造商也在用 AI 改造设备", source: "企业实践", title: "从卖设备到提供智能系统", summary: "AI开始进入维护、供应链和自动化施工。", metrics: [{ label: "行业知识", value: "130 万+" }, { label: "业务场景", value: "700+" }], points: ["卡特彼勒推出设备助手并推进自动化设备。", "三一沉淀一百三十多万条行业知识。", "三一 AI 应用覆盖七百多个业务场景。"] },
      narration: "AI 也在改造设备本身。卡特彼勒推出设备助手；三一沉淀一百三十多万条行业知识，训练十余款行业模型，应用覆盖七百多个业务场景。",
    },
    {
      scene: { type: "outro", duration: 12, headline: "AI受益链正在向工业基础设施扩散", bullets: ["工程机械承接数据中心施工需求。", "能源设备承接供电与备用发电需求。", "订单能否持续仍取决于真实建设节奏。"] },
      narration: "AI 受益链正在从芯片扩散到工程机械、能源和工业制造。但财报只说明当前订单强劲，未来能否持续，还要看数据中心的真实建设和电力投入节奏。",
    },
  ], options);
}

function createShieldstralProject(
  item: HotItem,
  options?: { width?: number; height?: number; fps?: number; screenshots?: WebScreenshot[]; index?: number },
): VideoProject {
  const storyItem: HotItem = { ...item, title: item.title, contentType: "news" };
  return createCuratedNewsProject(storyItem, [
    {
      scene: { type: "title", duration: 8, kicker: "内容审核模型", headline: storyItem.title, subhead: "用途：审核文本和图像内容，审核政策可以直接写进输入", sources: ["3B 参数", "16GB 显存", "12 种语言"] },
      narration: `${storyItem.title}。新闻日期：2026年8月5日。`,
    },
    {
      scene: { type: "briefing_points", duration: 11, headline: "开放权重，面向本地部署", source: "公开规格", title: "小规模多模态审核", summary: "模型可处理文本，也可审核带可选文字的图像。", metrics: [{ label: "参数量", value: "3B" }, { label: "显存", value: "16GB" }, { label: "语言", value: "12 种" }], points: ["依据 Apache 2.0 许可证发布。", "单张十六 GB 显卡可运行。", "官方称效果可比七倍规模开放模型。"] },
      narration: "模型总参数三十亿，支持十二种语言，单张十六 GB 显卡可运行，并采用 Apache 二点零许可证。官方称其效果可比七倍规模开放模型。",
    },
    {
      scene: { type: "flow", duration: 11, headline: "三段输入定义审核任务", steps: [{ label: "Instruct", detail: "说明评估场景和严格程度。" }, { label: "Query", detail: "提出一个是或否的问题。" }, { label: "Document", detail: "提供提示词、回答或图像。" }] },
      narration: "每项审核都被改写成二元问题：Instruct 定义场景和严格程度，Query 提出是或否的问题，Document 放入提示词、回答或图像。",
    },
    {
      scene: { type: "outro", duration: 10, headline: "输出连续分数，再按阈值判断", bullets: ["读取是与否两个词元的逻辑值。", "通过 Softmax 转成连续安全分数。", "默认零点五阈值仍需按业务验证。"] },
      narration: "推理时只读取是和否两个词元，再用 Softmax 转成连续分数，以零点五作为默认阈值。它能覆盖提示词、回答、拒答和毒性检测，但正式使用仍要验证自己的政策和误判率。",
    },
  ], options);
}

function createDeepSeekV4FlashProject(
  item: HotItem,
  options?: { width?: number; height?: number; fps?: number; screenshots?: WebScreenshot[]; index?: number },
): VideoProject {
  const title = speechFriendlyTitle(item.title);
  const sections: Array<{ scene: VideoScene; narration: string }> = [
    {
      scene: { type: "title", duration: 10, kicker: "模型更新", headline: shortTitle(title, 42), subhead: "正式版 API 进入公测，Pro 版本仍待发布", sources: ["API 公测", "Agent 能力", "版本边界"] },
      narration: `${title}。DeepSeek-V4-Flash 正式版 API 进入公测，重点变化集中在 Agent 能力和开发接口。`,
    },
    {
      scene: {
        type: "briefing_points", duration: 18, headline: "Agent 基准成绩", source: "核心事实", title: "多项公开基准成绩",
        summary: "正式版公开了多项 Agent 与软件工程基准成绩。",
        metrics: [{ label: "Terminal Bench", value: "82.7" }, { label: "Toolathlon", value: "70.3" }, { label: "FullStack", value: "68.7" }],
        points: ["Terminal Bench 2.1 为 82.7。", "Toolathlon verified 为 70.3。", "DSBench-FullStack 为 68.7，DSBench-Hard 为 59.6。"],
      },
      narration: "多项公开基准成绩里，Terminal Bench 2.1 是 82.7，Toolathlon verified 是 70.3，DSBench FullStack 是 68.7，DSBench Hard 是 59.6。这些项目主要观察 Agent 和软件工程任务表现。",
    },
    {
      scene: {
        type: "flow", duration: 17, headline: "开发接口与模型训练变化",
        steps: [
          { label: "Responses API", detail: "正式版原生兼容该接口格式。" },
          { label: "Codex", detail: "针对代码智能体接入进行适配。" },
          { label: "模型结构", detail: "结构和尺寸与预览版保持一致。" },
          { label: "后训练", detail: "本次主要重新进行后训练。" },
        ],
      },
      narration: "开发接口与模型训练变化可以分成四点。正式版原生兼容 Responses API，并针对 Codex 接入做了适配。模型结构和尺寸与 Flash 预览版保持一致，这次更新主要来自重新进行的后训练。",
    },
    {
      scene: {
        type: "flow", duration: 16, headline: "本次更新范围要分清", steps: [
          { label: "已更新", detail: "DeepSeek-V4-Flash 正式版 API。" },
          { label: "未更新", detail: "DeepSeek-V4-Pro API。" },
          { label: "客户端不变", detail: "应用端和网页端模型本次没有调整。" },
          { label: "Pro 状态", detail: "V4-Pro 正式版仍在等待发布。" },
        ],
      },
      narration: "本次更新范围要分清：只升级了 DeepSeek-V4-Flash 的 API 接口。V4-Pro API 没有变化，应用端和网页端模型也没有调整。V4-Pro 正式版仍未发布，官方表述是将尽快推出。",
    },
    {
      scene: {
        type: "outro", duration: 15, headline: "公测阶段应该关注什么", bullets: [
          "先验证现有接口和参数兼容性。", "用真实任务比较工具调用与代码任务表现。", "上线前继续观察稳定性、延迟和服务边界。",
        ],
      },
      narration: "对开发者来说，当前最值得验证的是接口兼容性、工具调用和真实代码任务表现。公测成绩不能直接等同于所有业务场景，上线前仍要检查稳定性、延迟、限额和现有调用链路。",
    },
  ];
  const scenes = applySectionDurations(sections, Number(process.env.STORY_MAX_SECONDS ?? 80));
  const project = {
    meta: { title, createdAt: new Date().toISOString(), width: options?.width ?? Number(process.env.VIDEO_WIDTH ?? 1080), height: options?.height ?? Number(process.env.VIDEO_HEIGHT ?? 1920), fps: options?.fps ?? Number(process.env.VIDEO_FPS ?? 30), durationSeconds: scenes.reduce((sum, scene) => sum + scene.duration, 0), sourceCount: 1 },
    narration: sections.map((section) => section.narration).join("\n"),
    narrationSegments: sections.map((section, sceneIndex) => ({ sceneIndex, text: section.narration, ttsText: speechFriendlyText(section.narration) })),
    scenes,
    sources: [item],
    screenshots: options?.screenshots ?? [],
  } satisfies VideoProject;
  return withGroundedFactReferences(project);
}

function createSeedance25Project(
  item: HotItem,
  options?: { width?: number; height?: number; fps?: number; screenshots?: WebScreenshot[]; index?: number },
): VideoProject {
  const title = speechFriendlyTitle(item.title);
  const sections: Array<{ scene: VideoScene; narration: string }> = [
    {
      scene: { type: "title", duration: 10, kicker: "视频生成模型", headline: shortTitle(title, 42), subhead: "更长叙事、更多参考素材和更细粒度控制", sources: ["长叙事", "多模态参考", "可控生成"] },
      narration: `${title}。这次更新把重点放在三件事：单次生成更长，多模态参考更丰富，以及镜头和局部内容更可控。`,
    },
    {
      scene: {
        type: "briefing_points", duration: 18, headline: "单次三十秒，并可继续延长", source: "核心能力", title: "从短片段走向完整叙事",
        summary: "模型可在三十秒内组织多个有关联的镜头，并通过多轮延长继续衔接后续内容。",
        metrics: [{ label: "单次时长", value: "30 秒" }, { label: "延长方式", value: "多轮" }, { label: "目标", value: "连贯叙事" }],
        points: ["镜头可覆盖铺垫、推进、转折和收尾。", "延长时保持主体、场景和视听风格连贯。", "运镜衔接、音画一致性和运动质量经过优化。"],
      },
      narration: "单次三十秒，并可继续延长，是长叙事的第一项核心变化。模型可在三十秒内组织铺垫、推进、转折和收尾，再通过多轮延长衔接后续内容。延长时会保持主体、场景和视听风格连贯，运镜衔接、音画一致性和运动质量也经过优化。",
    },
    {
      scene: {
        type: "signal_chart", duration: 18, headline: "多模态参考素材扩展",
        bars: [
          { label: "图片参考", value: 30, detail: "单次最多三十张图片。", color: "#18b7a5" },
          { label: "视频参考", value: 10, detail: "单次最多十段视频。", color: "#7c6cff" },
          { label: "音频参考", value: 10, detail: "单次最多十段音频。", color: "#facc15" },
        ],
      },
      narration: "多模态参考素材扩展，是第二项核心变化。一次可输入最多三十张图片、十段视频和十段音频，这三类素材可共同约束人物、场景、动作、声音与镜头风格。白模还可以描述空间结构、主体姿态、运动轨迹和镜头机位。",
    },
    {
      scene: {
        type: "flow", duration: 17, headline: "生成前后都能细化控制", steps: [
          { label: "时间戳", detail: "指定某个时间段发生的剧情和镜头。" },
          { label: "视角运镜", detail: "约束镜头位置、节奏和景别变化。" },
          { label: "局部修改", detail: "针对角色、动作、声音或剧情片段调整。" },
          { label: "保持连贯", detail: "修改时维持前后主体和场景一致。" },
        ],
      },
      narration: "生成前后都能细化控制，是第三项核心变化。生成前可以用时间戳指定某段剧情、视角运镜和节奏；生成后还能针对角色、动作、声音或剧情片段进行局部修改，并保持修改前后的主体和场景连贯。",
    },
    {
      scene: {
        type: "outro", duration: 15, headline: "适合哪些创作任务", bullets: [
          "影视和广告中的多镜头叙事与预演。", "教学内容、工业流程和设备演示。", "复杂项目仍需人工核对人物一致性、物理效果和版权。",
        ],
      },
      narration: "它适合影视和广告中的多镜头叙事与预演，也适合教学内容、工业流程和设备演示。复杂项目仍需人工核对人物一致性、物理效果、声音和素材授权。三十秒生成与多轮延长也不代表所有片段都能直接使用，最终剪辑仍要人工检查。",
    },
  ];
  const scenes = applySectionDurations(sections, Number(process.env.STORY_MAX_SECONDS ?? 80));
  const project = {
    meta: { title, createdAt: new Date().toISOString(), width: options?.width ?? Number(process.env.VIDEO_WIDTH ?? 1080), height: options?.height ?? Number(process.env.VIDEO_HEIGHT ?? 1920), fps: options?.fps ?? Number(process.env.VIDEO_FPS ?? 30), durationSeconds: scenes.reduce((sum, scene) => sum + scene.duration, 0), sourceCount: 1 },
    narration: sections.map((section) => section.narration).join("\n"),
    narrationSegments: sections.map((section, sceneIndex) => ({ sceneIndex, text: section.narration, ttsText: speechFriendlyText(section.narration) })),
    scenes,
    sources: [item],
    screenshots: options?.screenshots ?? [],
  } satisfies VideoProject;
  return withGroundedFactReferences(project);
}

export function createProject(
  items: HotItem[],
  options?: { width?: number; height?: number; fps?: number; screenshots?: WebScreenshot[] },
): VideoProject {
  const topItems = items.slice(0, 8);
  const screenshots = options?.screenshots ?? [];
  const githubItems = topItems.filter((item) => item.kind === "github").slice(0, 3);
  const chartItems = topItems.slice(0, 5);
  const scenes: VideoScene[] = [
    {
      type: "title",
      duration: 7,
      kicker: "AI NEWS RADAR",
      headline: pickTopic(topItems),
      subhead: "自动抓取热点，生成可视化短视频",
      sources: [...new Set(topItems.slice(0, 4).map(sourceLabel))],
    },
    {
      type: "news_stack",
      duration: 12,
      headline: "今天最值得看的 3 个信号",
      items: topItems.slice(0, 3).map((item) => ({
        title: item.title,
        summary: item.summary,
        source: item.source,
        url: item.url,
        tags: item.tags,
      })),
    },
    ...(screenshots.length > 0
      ? [
          {
            type: "web_screenshot_zoom",
            duration: 14,
            headline: "来源网页自动截图",
            shots: screenshots,
          } satisfies VideoScene,
        ]
      : []),
    {
      type: "signal_chart",
      duration: 10,
      headline: "热度评分",
      bars: chartItems.map((item, index) => ({
        label: shortTitle(sourceLabel(item), 18),
        value: Math.min(100, Math.max(12, item.score)),
        detail: shortTitle(item.title, 28),
        color: palette[index % palette.length],
      })),
    },
    githubItems.length > 0
      ? {
          type: "github_pulse",
          duration: 9,
          headline: "开源项目释放的产品信号",
          repos: githubItems.map((item) => ({
            repo: sourceLabel(item),
            title: shortTitle(item.title, 36),
            summary: shortTitle(item.summary, 70),
            score: item.score,
          })),
        }
      : {
          type: "flow",
          duration: 9,
          headline: "程序化视频流水线",
          steps: [
            { label: "Hotspot", detail: "公开资讯与项目资料" },
            { label: "Script", detail: "LLM 生成镜头脚本" },
            { label: "Scene JSON", detail: "组件化画面协议" },
            { label: "Render", detail: "Remotion + TTS + FFmpeg" },
          ],
        },
  ];
  const durationSeconds = scenes.reduce((sum, scene) => sum + scene.duration, 0);

  return {
    meta: {
      title: `${pickTopic(topItems)} - ${new Date().toLocaleDateString("zh-CN")}`,
      createdAt: new Date().toISOString(),
      width: options?.width ?? Number(process.env.VIDEO_WIDTH ?? 1080),
      height: options?.height ?? Number(process.env.VIDEO_HEIGHT ?? 1920),
      fps: options?.fps ?? Number(process.env.VIDEO_FPS ?? 30),
      durationSeconds,
      sourceCount: topItems.length,
    },
    narration: buildNarration(topItems, screenshots),
    scenes,
    sources: topItems,
    screenshots,
  } satisfies VideoProject;
}
