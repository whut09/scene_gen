import type { HotItem, VideoProject, VideoScene, WebScreenshot } from "./types";

const palette = ["#42d392", "#7dd3fc", "#f97316", "#f43f5e", "#a78bfa", "#facc15"];

function shortTitle(title: string, max = 34) {
  return title.length > max ? `${title.slice(0, max - 1)}...` : title;
}

function sourceLabel(item: HotItem) {
  if (item.repo) return item.repo;
  return item.source || item.domain || "AI Signal";
}

function pickTopic(items: HotItem[]) {
  const tags = new Map<string, number>();
  for (const item of items) {
    for (const tag of item.tags) tags.set(tag, (tags.get(tag) ?? 0) + item.score);
  }
  const top = [...tags.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  return top ? `${top.toUpperCase()} 热点` : "AI 今日热点";
}

function buildNarration(items: HotItem[], screenshots: WebScreenshot[]) {
  const top = items[0];
  const second = items[1];
  const third = items[2];
  return [
    `今天的 AI 信号，可以先看这条：${top?.title ?? "模型和 Agent 的更新正在加速"}。`,
    top?.summary ?? "它适合用数据、流程和界面变化来解释，而不是只做字幕堆叠。",
    second ? `第二个值得注意的是：${second.title}。${second.summary}` : "",
    screenshots.length > 0
      ? `接下来直接看网页截图。系统已经自动打开来源页面，截取标题区域，并在画面里做放大和高亮。`
      : "",
    third ? `第三个信号来自 ${third.source}：${third.title}。` : "",
    "如果把这些信息变成视频，核心不是找很多图片，而是把热点拆成四类画面：网页截图、排行榜、时间线和工作流。",
    "这也是程序化视频的优势：抓取内容以后，自动生成结构化场景，再用浏览器渲染成动画。",
    "最后给一个判断：AI 自媒体真正稀缺的能力，是持续把抽象信息变成清晰的动态可视化。",
  ]
    .filter(Boolean)
    .join("\n");
}

function metricValue(item: HotItem, key: string) {
  const value = item.metrics?.[key];
  if (value === undefined || value === null || value === "") return null;
  return String(value);
}

function storyPoints(item: HotItem) {
  const tags = item.tags.length > 0 ? item.tags.join(" / ") : "AI product signal";
  return [
    `核心信号：${item.summary}`,
    `来源类型：${item.source}，这决定了它更像新闻、社区讨论还是产品发布。`,
    `内容标签：${tags}。这条适合拆成网页截图、关键事实和影响判断。`,
  ];
}

function storyNarration(item: HotItem, screenshots: WebScreenshot[]) {
  const points = storyPoints(item);
  const screenshotLine =
    screenshots.length > 0
      ? "我们先看来源页面。画面里高亮的是标题和核心信息区域，这比单纯复述新闻更容易建立信任。"
      : "这条新闻的来源页面暂时没有稳定截图，所以我们直接进入事实拆解。";
  return [
    `这条热点单独拿出来看：${item.title}。`,
    screenshotLine,
    points[0],
    points[1],
    `为什么它值得做成一条独立视频？因为它不是泛泛的 AI 焦虑，而是一个可以被验证的具体信号。`,
    `第一，看它来自哪里：${item.source}。第二，看它和哪些关键词有关：${
      item.tags.length > 0 ? item.tags.join("、") : "模型、产品和开发者生态"
    }。第三，看它有没有后续扩散空间。`,
    "如果你要做 AI 自媒体，这类新闻最适合的画面不是素材堆叠，而是来源截图、事实卡片、影响路径和下一步观察点。",
    "结论是：这条可以作为单条热点视频发布，重点放在事实来源和影响判断，不要做成今日总结里的一个小 bullet。",
  ].join("\n");
}

export function createStoryProject(
  item: HotItem,
  options?: { width?: number; height?: number; fps?: number; screenshots?: WebScreenshot[]; index?: number },
): VideoProject {
  const screenshots = options?.screenshots ?? [];
  const points = storyPoints(item);
  const metrics = [
    { label: "Heat", value: String(Math.min(100, Math.max(12, item.score))) },
    metricValue(item, "points") ? { label: "HN Points", value: metricValue(item, "points") as string } : null,
    metricValue(item, "comments") ? { label: "Comments", value: metricValue(item, "comments") as string } : null,
    item.publishedAt
      ? {
          label: "Date",
          value: new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit" }).format(
            new Date(item.publishedAt),
          ),
        }
      : null,
  ].filter((metric): metric is { label: string; value: string } => Boolean(metric));

  const scenes: VideoScene[] = [
    {
      type: "title",
      duration: 7,
      kicker: `HOT STORY ${String(options?.index ?? 1).padStart(2, "0")}`,
      headline: shortTitle(item.title, 42),
      subhead: `${item.source} · ${item.domain ?? "AI news"}`,
      sources: [item.source, ...(item.tags.length > 0 ? item.tags.slice(0, 3) : ["AI"])],
    },
    ...(screenshots.length > 0
      ? [
          {
            type: "web_screenshot_zoom",
            duration: 12,
            headline: "先看来源页面",
            shots: screenshots,
          } satisfies VideoScene,
        ]
      : []),
    {
      type: "briefing_points",
      duration: 15,
      headline: "这条新闻具体说了什么",
      source: item.source,
      title: item.title,
      summary: item.summary,
      points,
      metrics,
    },
    {
      type: "flow",
      duration: 12,
      headline: "为什么它值得单独成片",
      steps: [
        { label: "Fact", detail: "先展示来源截图和原始标题" },
        { label: "Signal", detail: "抽取产品、模型或社区变化" },
        { label: "Impact", detail: "说明影响开发者、用户或行业叙事" },
        { label: "Watch", detail: "给出后续观察点" },
      ],
    },
    {
      type: "signal_chart",
      duration: 8,
      headline: "热度和扩散空间",
      bars: [
        {
          label: "Heat",
          value: Math.min(100, Math.max(12, item.score)),
          detail: shortTitle(item.title, 28),
          color: palette[0],
        },
        {
          label: item.tags[0] ?? "AI",
          value: Math.min(100, Math.max(28, item.tags.length * 22)),
          detail: item.tags.length > 0 ? item.tags.join(" / ") : "source verified",
          color: palette[1],
        },
      ],
    },
    {
      type: "outro",
      duration: 8,
      headline: "发布角度",
      bullets: ["单条热点", "来源可验证", "讲影响，不做泛总结"],
    },
  ];
  const durationSeconds = scenes.reduce((sum, scene) => sum + scene.duration, 0);

  return {
    meta: {
      title: item.title,
      createdAt: new Date().toISOString(),
      width: options?.width ?? Number(process.env.VIDEO_WIDTH ?? 1080),
      height: options?.height ?? Number(process.env.VIDEO_HEIGHT ?? 1920),
      fps: options?.fps ?? Number(process.env.VIDEO_FPS ?? 30),
      durationSeconds,
      sourceCount: 1,
    },
    narration: storyNarration(item, screenshots),
    scenes,
    sources: [item],
    screenshots,
  } satisfies VideoProject;
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
    {
      type: "timeline",
      duration: 11,
      headline: "信息流如何变成镜头",
      events: topItems.slice(0, 4).map((item) => ({
        date: item.publishedAt
          ? new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit" }).format(
              new Date(item.publishedAt),
            )
          : "Now",
        title: shortTitle(item.title, 36),
        source: sourceLabel(item),
      })),
    },
    githubItems.length > 0
      ? {
          type: "github_pulse",
          duration: 9,
          headline: "GitHub 释放的产品信号",
          repos: githubItems.map((item) => ({
            repo: item.repo ?? sourceLabel(item),
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
            { label: "Hotspot", detail: "RSS / GitHub / Webpage" },
            { label: "Script", detail: "LLM 生成镜头脚本" },
            { label: "Scene JSON", detail: "组件化画面协议" },
            { label: "Render", detail: "Remotion + TTS + FFmpeg" },
          ],
        },
    {
      type: "outro",
      duration: 10,
      headline: "结论",
      bullets: ["不要堆字幕", "优先做结构化可视化", "先跑通日产能力，再优化爆款"],
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
