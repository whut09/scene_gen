import type { HotItem, VideoProject, VideoScene, WebScreenshot } from "./types";

import { buildFactLedger, claimIdsForText, sceneFactText } from "./fact-ledger";
import { contentTypeForItem } from "./content-type";
import { repositorySynthesisText } from "./repository-project";

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

const forbiddenSourceAttribution = /(?:来自|据|援引|转引)?\s*(?:IT之家|ITHome|QbitAI|qbitai[.]com|量子位|腾讯新闻|腾讯网|36氪|TechWeb|钛媒体官方网站|钛媒体|新浪科技|搜狐科技|潮新闻客户端|潮新闻|新华网|同花顺财经|同花顺|百度百家号|百家号)(?:的?(?:消息|报道|获悉|文章|网站))?/gi;
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
    .replace(/编辑\s*[：:|｜]?\s*[\u4e00-\u9fa5A-Za-z0-9_ -]{0,24}/g, "")
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

function limitNarration(text: string, maxCharacters = 110) {
  if (text.length <= maxCharacters) return text;
  const chunks = splitArticleIntoSemanticChunks(text, maxCharacters);
  const selected: string[] = [];
  let length = 0;
  for (const chunk of chunks) {
    if (selected.length && length + chunk.length > maxCharacters) break;
    selected.push(chunk);
    length += chunk.length;
  }
  return selected.join("") || `${text.slice(0, maxCharacters).replace(/[，、：；]+$/u, "")}。`;
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
}

function repositoryProfile(item: HotItem): RepositoryProfile {
  const content = item.content ?? "";
  const name = repositoryName(item);
  const topics = repositoryTopics(content);
  if (/freerouting|autorout(?:er|ing)|printed circuit board|\bpcb\b/i.test(`${name} ${item.title} ${content}`)) {
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
  if (!/\baisuite\b/i.test(`${name} ${item.title}`) && /officecli|office suite|word|excel|powerpoint|spreadsheet|presentation/i.test(`${name} ${item.title} ${content}`)) {
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
  if (/\bt3code\b|minimal web gui for coding agents|codex.*claude.*cursor.*opencode/i.test(`${name} ${item.title} ${content}`)) {
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
  if (/build-your-own|re-creat(?:e|ing).*from scratch/i.test(`${item.title} ${content}`)) {
    return {
      theme: "通过从零实现理解技术原理",
      capability: "把不同技术主题的逐步实践资料集中整理",
      workflow: "先选定一个具体主题，再沿着从基础概念到可运行实现的顺序推进",
      boundaries: "它提供的是学习路径和参考资料，真正的理解仍要来自动手实现、调试和复盘",
      topics: topics.length ? topics : ["三维渲染", "人工智能模型", "数据库", "网络协议栈", "操作系统", "编程语言"],
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
  const topics = profile.topics;
  const isBifrost = name.toLowerCase() === "bifrost";
  const hasDetailedWorkflow = profile.steps?.length === 4;
  const sections: Array<{ scene: VideoScene; narration: string }> = [
    {
      scene: { type: "title", duration: 11, kicker: "开源项目推荐", headline: `开源项目推荐：${name}`, subhead: profile.theme, sources: ["项目定位", "核心能力", "适用边界"] },
      narration: `开源项目推荐：${name}。它${profile.theme}。${isBifrost ? "应用只需接一套接口，就能统一管理模型调用。" : ""}`,
    },
    {
      scene: {
        type: "briefing_points", duration: 15, headline: "先看它解决什么问题", source: "项目资料", title: name, summary: profile.capability,
        metrics: profile.metrics ?? (isBifrost ? [{ label: "统一入口", value: "23+ 服务" }, { label: "兼容方式", value: "一套 API" }] : [{ label: "主要定位", value: "开发实践" }, { label: "组织方式", value: "分步理解" }]),
        points: profile.problemPoints ?? (isBifrost ? [profile.capability, "应用无需分别适配每一家模型服务。", "服务异常时可以按规则自动切换备用模型。"] : [profile.capability, "内容围绕实际任务组织，而不是只给出结论。", "每个主题都需要结合自己的工程上下文判断。"]),
      },
      narration: isBifrost ? `Bifrost 的核心作用，是${profile.capability}。应用不用分别适配每一家服务，模型异常时还能自动切换备用方案。` : `它的主要作用是${profile.capability}。先用一个边界清晰的小任务，验证它是否适合你的工作。`,
    },
    {
      scene: {
        type: "signal_chart", duration: 15, headline: "使用时关注哪些环节",
        bars: topics.slice(0, 4).map((topic, index) => ({ label: topic, value: 1, detail: "项目资料列出的实践主题", color: ["#18b7a5", "#7c6cff", "#facc15", "#ff6b6b"][index] })),
      },
      narration: `重点环节是${topics.slice(0, 4).join("、")}。先确认输入、规则和预期结果，再检查每一步输出。`,
    },
    {
      scene: {
        type: "flow", duration: 17, headline: "四步开始使用", steps: [
          ...(profile.steps ?? (isBifrost ? [
            { label: "启动网关", detail: "在本地或服务器运行统一入口。" },
            { label: "配置服务", detail: "在管理界面填写模型服务和密钥。" },
            { label: "修改地址", detail: "把应用接口地址指向网关。" },
            { label: "验证策略", detail: "检查切换、延迟、缓存和成本。" },
          ] : [
            { label: "选择主题", detail: "从当前问题出发确定一个具体方向。" },
            { label: "阅读结构", detail: "确认目标、输入和关键约束。" },
            { label: "动手验证", detail: "用最小实现观察每一步的结果。" },
            { label: "复盘验证", detail: "保留检查结果并定位异常。" },
          ])),
        ],
      },
      narration: isBifrost ? `上手分四步：启动网关，配置模型服务和密钥，把应用接口地址改到 Bifrost，再验证故障切换、延迟、缓存和成本。` : hasDetailedWorkflow ? `上手可以分四步。${profile.workflow}。` : `实际使用分四步：选择主题、阅读结构、动手验证、复盘验证。${profile.workflow}。每次只改变一个关键条件并保留检查结果。`,
    },
    {
      scene: {
        type: "outro", duration: 14, headline: "适合谁，以及如何使用", bullets: [
          `适合希望${profile.theme}的使用者。`,
          isBifrost ? "适合同时使用多个模型服务的应用和团队。" : "从一个主题和最小验证开始，再逐步扩展。",
          isBifrost ? "它管理调用入口，不替你选择业务模型。" : "关键工程决策仍要结合测试、评审与实际环境确认。",
        ],
      },
      narration: isBifrost ? `它适合同时使用多个模型服务、需要稳定性和成本治理的应用。它管理的是调用入口，不会替你选择业务模型。生产使用前要验证权限、兼容性和切换规则。` : `它适合希望${profile.theme}的使用者。${profile.boundaries}。先跑通一个小问题，核对结果后再扩展。`,
    },
  ];
  const scenes = applySectionDurations(sections, Math.min(100, Math.max(60, Number(process.env.STORY_MAX_SECONDS ?? 80))));
  const factLedger = buildFactLedger([item]);
  const claimIds = (sceneIndex: number) => factLedger.claims.slice(sceneIndex * 2, sceneIndex * 2 + 2).map((claim) => claim.id).concat(
    factLedger.claims.length ? [] : [],
  );
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
