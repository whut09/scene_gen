import type { HotItem, VideoProject, VideoScene, WebScreenshot } from "./types";

import { buildFactLedger } from "./fact-ledger";
import { contentTypeForItem } from "./content-type";

const palette = ["#42d392", "#7dd3fc", "#f97316", "#f43f5e", "#a78bfa", "#facc15"];

function shortTitle(title: string, max = 34) {
  return title.length > max ? `${title.slice(0, max - 1)}...` : title;
}

function speechFriendlyText(text: string) {
  return text
    .replace(/\bAI\b/gi, "人工智能")
    .replace(/\bCOO\b/gi, "首席运营官")
    .replace(/HappyHorse/gi, "活动主办方")
    .replace(/HorsePower/gi, "人工智能影像大赛");
}

function speechFriendlyTitle(title: string) {
  return speechFriendlyText(title.replace(/^.{4,24}[？?](?=.{2,30}[：:])/u, ""));
}

const danglingClauseEnding = /(?:\u6b63\u662f\u56e0\u4e3a|\u56e0\u4e3a|\u4f46\u662f|\u800c\u4e14|\u4ee5\u53ca|\u5e76\u4e14|\u4ece\u800c|\u6240\u4ee5|\u5305\u62ec|\u4f8b\u5982)[\uff0c,:\s]*$/u;

export function splitArticleIntoSemanticChunks(text: string, maxCharacters = 72) {
  const clauses = scrubAttribution(text).match(/[^\uff0c\uff1b\uff1a\u3002\uff01\uff1f]+[\uff0c\uff1b\uff1a\u3002\uff01\uff1f]?/gu) ?? [];
  const chunks: string[] = [];
  let current = "";
  for (const rawClause of clauses) {
    const clause = rawClause.trim();
    if (!clause) continue;
    if (current && [...current, ...clause].length > maxCharacters && !danglingClauseEnding.test(current)) {
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
      const complete = danglingClauseEnding.test(chunk) ? chunk.replace(danglingClauseEnding, "") : chunk;
      return /[\u3002\uff01\uff1f\uff1b]$/u.test(complete) ? complete : `${complete.replace(/[\uff0c\uff1a]+$/u, "")}\u3002`;
    })
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

const forbiddenSourceAttribution = /(?:来自|据|援引|转引)?\s*(?:IT之家|ITHome|QbitAI|qbitai[.]com|量子位|腾讯新闻|腾讯网|36氪|TechWeb|钛媒体官方网站|钛媒体|新浪科技|搜狐科技|潮新闻客户端|潮新闻|新华网|同花顺财经|同花顺|百度百家号|百家号)(?:的?(?:消息|报道|获悉|文章|网站))?/gi;
const forbiddenGithubPlatformReference = /(?:https?:\/\/)?(?:www\.)?github\.com(?:\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)?)?|\bgithub(?:\s+release)?\b/gi;

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

export function scrubAttribution(text: string) {
  forbiddenSourceAttribution.lastIndex = 0;
  return text
    .replace(forbiddenSourceAttribution, "")
    .replace(/作者\s*[：:|｜]?\s*[\u4e00-\u9fa5A-Za-z0-9_ -]{0,24}/g, "")
    .replace(/编辑\s*[：:|｜]?\s*[\u4e00-\u9fa5A-Za-z0-9_ -]{0,24}/g, "")
    .replace(/来源\s*[：:|｜]?\s*[\u4e00-\u9fa5A-Za-z0-9_. -]{0,32}/g, "")
    .replace(/图源\s*[：:|｜]?\s*[^，。！？；;\s]{0,32}/g, "")
    .replace(/(?:^|[。！？\s])记者\s+[\u4e00-\u9fa5]{2,4}(?=$|[“”"'，,。！？\s])/gu, " ")
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

function applySectionDurations(sections: Array<{ scene: VideoScene; narration: string }>, maxSeconds?: number) {
  const narrationChars = sections.map((section) => section.narration.length);
  const totalChars = narrationChars.reduce((sum, count) => sum + count, 0);
  const target = Math.min(maxSeconds ?? 96, 115);
  const seconds = Math.max(55, Math.min(target, Math.ceil(totalChars / 5.4)));
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

export function createStoryProject(
  item: HotItem,
  options?: { width?: number; height?: number; fps?: number; screenshots?: WebScreenshot[]; index?: number },
): VideoProject {
  const clean = cleanItem(item);
  const joinedContent = `${clean.title} ${clean.summary} ${clean.content ?? ""}`;
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
    narration: sections.map((section) => scrubAttribution(section.narration)).join("\n"),
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
    !/发布.*模型|推出.*模型|模型.*发布|模型.*上线/i.test(item.title);
  const title = speechFriendlyTitle(item.title);
  const summary =
    item.summary && item.summary !== item.title
      ? item.summary
      : isChipStory
        ? "头部模型公司开始把竞争从模型能力，推进到底层算力和推理成本控制。"
        : "这条新闻的关键，是一个行业变量正在从表层事件变成结构性变化。";
  const articleSentences = splitArticleIntoSemanticChunks(item.content ?? item.summary);
  const sentenceAt = (index: number) => articleSentences[index] ?? articleSentences[index % Math.max(1, articleSentences.length)] ?? summary;
  const narrationAt = (start: number, count = 2) => Array.from({ length: count }, (_, offset) => sentenceAt(start + offset)).join("");
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
          narration: `\u8fd9\u7bc7\u6280\u672f\u6587\u7ae0\u8ba8\u8bba\u7684\u662f\uff1a${title}\u3002${coverSummary}`,
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
          narration: `这条新闻讲的是：${title}。${coverSummary}`,
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

  const scenes = applySectionDurations(sections, Number(process.env.STORY_MAX_SECONDS ?? 96));
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
    narration: sections.map((section) => scrubAttribution(section.narration)).join("\n"),
    narrationSegments: sections.map((section, sceneIndex) => ({
      sceneIndex,
      text: scrubAttribution(section.narration),
      ttsText: sceneIndex === 0
        ? isTechnicalArticle ? `\u8fd9\u7bc7\u6280\u672f\u6587\u7ae0\u8ba8\u8bba\u7684\u662f\uff0c${title}\u3002` : `\u8fd9\u6761\u65b0\u95fb\u8bb2\u7684\u662f\uff0c${title}\u3002`
        : speechFriendlyText(scrubAttribution(section.narration)),
    })),
    scenes,
    sources: [item],
    screenshots: options?.screenshots ?? [],
  } satisfies VideoProject;
  const factLedger = buildFactLedger(project.sources);
  const claimIdsForScene = (sceneIndex: number) => {
    const selected = factLedger.claims.slice(sceneIndex * 2, sceneIndex * 2 + 2).map((claim) => claim.id);
    return selected.length ? selected : factLedger.claims.slice(0, 1).map((claim) => claim.id);
  };
  return {
    ...project,
    factLedger,
    titleClaimIds: claimIdsForScene(0),
    scenes: project.scenes.map((scene, sceneIndex) => ({ ...scene, claimIds: claimIdsForScene(sceneIndex) })) as VideoScene[],
    narrationSegments: project.narrationSegments?.map((segment) => ({ ...segment, claimIds: claimIdsForScene(segment.sceneIndex) })),
  };
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
