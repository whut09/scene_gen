import type { VideoProject, VideoScene } from "./types";

interface DirectedStory {
  title?: string;
  sections?: Array<{
    visual?: "title" | "briefing" | "chart" | "flow" | "outro";
    headline?: string;
    subhead?: string;
    summary?: string;
    narration?: string;
    keywords?: string[];
    metrics?: Array<{ label?: string; value?: string }>;
    points?: string[];
    bars?: Array<{ label?: string; value?: number; detail?: string }>;
    steps?: Array<{ label?: string; detail?: string }>;
    bullets?: string[];
  }>;
}

function cleanStrings(values: unknown, limit: number) {
  if (!Array.isArray(values)) return [];
  return values
    .filter((value): value is string => typeof value === "string" && Boolean(value.trim()))
    .map((value) => value.trim())
    .slice(0, limit);
}

function formatCoverHeadline(title: string) {
  return title
    .replace(/：/, "：\n")
    .replace(/，(?=价格|成本|售价)/, "\n");
}
function createDirectedProject(project: VideoProject, directed: DirectedStory) {
  const sections = directed.sections;
  if (!sections || sections.length !== 5 || sections.some((section) => !section.narration?.trim())) {
    return project;
  }

  const title = project.meta.title;
  const titleSection = sections[0];
  const briefingSection = sections[1];
  const chartSection = sections[2];
  const flowSection = sections[3];
  const outroSection = sections[4];
  const colors = ["#fff36a", "#72f0ff", "#ff8bd7", "#8aff9a"];
  const scenes: VideoScene[] = [
    {
      type: "title",
      duration: 12,
      kicker: /OpenAI|GPT/i.test(title) ? "OpenAI 新模型发布" : "AI 模型新进展",
      headline: formatCoverHeadline(title),
      subhead: titleSection.subhead?.trim() || titleSection.summary?.trim() || project.sources[0]?.summary || "",
      sources: cleanStrings(titleSection.keywords, 3).length
        ? cleanStrings(titleSection.keywords, 3)
        : ["模型能力", "科学推理", "开放边界"],
    },
    {
      type: "briefing_points",
      duration: 20,
      headline: briefingSection.headline?.trim() || "这次发布讲了什么",
      source: "核心事实",
      title,
      summary: briefingSection.summary?.trim() || project.sources[0]?.summary || "",
      metrics: (briefingSection.metrics ?? [])
        .filter((metric) => metric.label && metric.value)
        .slice(0, 3)
        .map((metric) => ({ label: metric.label!.trim(), value: metric.value!.trim() })),
      points: cleanStrings(briefingSection.points, 4),
    },
    {
      type: "signal_chart",
      duration: 20,
      headline: chartSection.headline?.trim() || "关键变化",
      bars: (chartSection.bars ?? [])
        .filter((bar) => bar.label && bar.detail)
        .slice(0, 4)
        .map((bar, index) => ({
          label: bar.label!.trim(),
          value: Math.max(10, Math.min(100, Number(bar.value ?? 70))),
          detail: bar.detail!.trim(),
          color: colors[index % colors.length],
        })),
    },
    {
      type: "flow",
      duration: 20,
      headline: flowSection.headline?.trim() || "影响路径",
      steps: (flowSection.steps ?? [])
        .filter((step) => step.label && step.detail)
        .slice(0, 4)
        .map((step) => ({ label: step.label!.trim(), detail: step.detail!.trim() })),
    },
    {
      type: "outro",
      duration: 18,
      headline: outroSection.headline?.trim() || "最后判断",
      bullets: cleanStrings(outroSection.bullets, 4),
    },
  ];
  if (
    scenes[1].type !== "briefing_points" ||
    scenes[1].metrics.length < 2 ||
    scenes[1].points.length < 2 ||
    scenes[2].type !== "signal_chart" ||
    scenes[2].bars.length < 3 ||
    scenes[3].type !== "flow" ||
    scenes[3].steps.length < 3 ||
    scenes[4].type !== "outro" ||
    scenes[4].bullets.length < 2
  ) {
    return project;
  }

  const narrationSegments = sections.map((section, sceneIndex) => ({
    sceneIndex,
    text: section.narration!.replace(/\s+/g, " ").trim(),
  }));
  const durationSeconds = scenes.reduce((sum, scene) => sum + scene.duration, 0);
  return {
    ...project,
    meta: {
      ...project.meta,
      title,
      durationSeconds,
    },
    narration: narrationSegments.map((segment) => segment.text).join("\n"),
    narrationSegments,
    scenes,
  } satisfies VideoProject;
}

export async function improveWithOpenAI(
  project: VideoProject,
  options?: { targetSeconds?: number; forbidAttribution?: boolean; editorialNotes?: string },
) {
  const apiKey = process.env.NEWS_LLM_API_KEY ?? process.env.OPENAI_API_KEY;
  if (!apiKey) return project;

  const model = process.env.NEWS_LLM_MODEL ?? process.env.OPENAI_MODEL ?? "gpt-4.1-mini";
  const baseUrl = process.env.NEWS_LLM_BASE_URL ?? process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";
  const targetSeconds = options?.targetSeconds ?? 90;
  const targetChars = Math.max(900, Math.round(targetSeconds * 13.6));
  const guidance = [
    "你是 AI 科技竖屏短视频的资深新闻编导。",
    "只返回 JSON，不要 Markdown。",
    `总旁白约 ${targetChars} 个汉字，目标成片约 ${targetSeconds} 秒。`,
    "必须输出 title 和 sections；sections 恰好 5 个，visual 顺序固定为 title、briefing、chart、flow、outro。",
    "每个 section 必须有 narration，每段约 250 到 290 个汉字；旁白只讲新闻事实、重要性、边界和可验证结论。",
    "不要出现新闻怎么跟进、如何发布、适合做视频、作者、编辑、站点、媒体来源等无关内容。",
    "sourceArticle 是唯一新闻依据。忠实总结文章中的发布状态、开放范围、模型能力、价格和数据，不得主动引入站外信息推翻或改写原文。",
    "如果文章明确写正式发布、正式推出或即日起开放，首段必须直接使用对应表述，并说明开放渠道和用户范围，不得弱化。",
    "不要照抄长原文，不要虚构文章中没有的数据；只有用户明确传入事实校正备注时，才按备注调整。",
    "title 场景提供 subhead 和 3 个 keywords。",
    "briefing 场景提供 summary、3 个 metrics、3 到 4 个 points。",
    "chart 场景提供 4 个 bars，每个含 label、value、detail；value 只表示视觉权重，不冒充官方分数。",
    "flow 场景提供 4 个 steps，每个含 label、detail。",
    "outro 场景提供 3 个 bullets，必须包含限制条件或后续验证项。",
    options?.forbidAttribution
      ? "所有画面和旁白都不得出现作者、编辑、量子位、QbitAI、新浪、腾讯新闻或来源归属字眼。"
      : "",
    options?.editorialNotes ? `用户明确要求（包含历史反馈和本轮修订项）：${options.editorialNotes}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      temperature: 0.28,
      messages: [
        { role: "system", content: guidance },
        {
          role: "user",
          content: JSON.stringify({
            currentTitle: project.meta.title,
            sourceArticle: project.sources.map((item) => ({
              title: item.title,
              summary: item.summary,
              content: item.content,
              publishedAt: item.publishedAt,
              tags: item.tags,
            })),
          }),
        },
      ],
      response_format: { type: "json_object" },
    }),
  });

  if (!response.ok) {
    console.warn(`[llm] OpenAI failed: ${response.status} ${await response.text()}`);
    return project;
  }

  const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const content = data.choices?.[0]?.message?.content;
  if (!content) return project;

  try {
    return createDirectedProject(project, JSON.parse(content) as DirectedStory);
  } catch (error) {
    console.warn(`[llm] invalid directed story: ${(error as Error).message}`);
    return project;
  }
}