import type { VideoProject } from "./types";

export async function improveWithOpenAI(
  project: VideoProject,
  options?: { targetSeconds?: number; forbidAttribution?: boolean },
) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return project;

  const model = process.env.OPENAI_MODEL ?? "gpt-4.1-mini";
  const baseUrl = process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";
  const maxChars = options?.targetSeconds ? Math.max(45, options.targetSeconds * 7) : 420;
  const guidance = [
    "你是 AI 科技竖屏短视频编导。",
    "只返回 JSON，字段为 title 和 narration。",
    "标题要短，旁白要中文口语化、信息密度高，不要夸张营销。",
    `旁白最多 ${maxChars} 个汉字。`,
    options?.targetSeconds ? `旁白节奏按约 ${options.targetSeconds} 秒视频控制。` : "旁白适合 60 秒竖屏视频。",
    options?.forbidAttribution
      ? "不要出现作者、编辑、量子位、QbitAI、qbitai.com、来源来自哪里等署名或站点归属字眼。"
      : "",
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
      temperature: 0.45,
      messages: [
        {
          role: "system",
          content: guidance,
        },
        {
          role: "user",
          content: JSON.stringify({
            currentTitle: project.meta.title,
            currentNarration: project.narration,
            sources: project.sources.map((item) => ({
              title: item.title,
              source: options?.forbidAttribution ? "核心事实" : item.source,
              summary: item.summary,
              content: item.content,
              tags: item.tags,
              score: item.score,
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

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = data.choices?.[0]?.message?.content;
  if (!content) return project;

  try {
    const parsed = JSON.parse(content) as { title?: string; narration?: string };
    return {
      ...project,
      meta: {
        ...project.meta,
        title: parsed.title || project.meta.title,
      },
      narration: parsed.narration || project.narration,
    };
  } catch {
    return project;
  }
}
