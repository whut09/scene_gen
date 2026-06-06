import type { VideoProject } from "./types";

export async function improveWithOpenAI(project: VideoProject) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return project;

  const model = process.env.OPENAI_MODEL ?? "gpt-4.1-mini";
  const baseUrl = process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      temperature: 0.5,
      messages: [
        {
          role: "system",
          content:
            "你是 AI 科技短视频编导。只返回 JSON，字段为 title 和 narration。旁白要中文口语化，信息密度高，适合 60 秒竖屏视频，不要夸张营销。",
        },
        {
          role: "user",
          content: JSON.stringify({
            currentTitle: project.meta.title,
            currentNarration: project.narration,
            sources: project.sources.map((item) => ({
              title: item.title,
              source: item.source,
              summary: item.summary,
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
