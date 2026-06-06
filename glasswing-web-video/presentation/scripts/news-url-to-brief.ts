import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { loadLocalConfig } from "./config";

loadLocalConfig();

const url = process.argv[2];
if (!url) {
  console.error("Usage: npm run news:url -- <news-url>");
  process.exit(1);
}

const outDir = resolve("..", "url-news");
const screenshotPath = resolve("public", "assets", "url-news-source.png");

function compact(text: string) {
  return text.replace(/\s+/g, " ").trim();
}

async function callLLM(article: { title: string; url: string; text: string }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  const baseUrl = process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";
  const model = process.env.OPENAI_MODEL ?? "gpt-5.5";
  const prompt = `
你是中文科技短视频编导。请基于下面新闻，生成适合 9:16 竖屏短视频的内容方案。

要求：
- 输出 JSON，不要 Markdown。
- 语言为中文。
- 保留事实、数字、时间、公司名。
- 结构固定为 4 章，总步数 18 到 26。
- 每一步给一句口播、一句屏幕主文案、一个视觉建议。
- 不要编造原文没有的数据；不确定就写“原文未说明”。

新闻标题：${article.title}
新闻 URL：${article.url}
正文：
${article.text.slice(0, 14000)}

JSON schema:
{
  "title": string,
  "sourceUrl": string,
  "summary": string,
  "chapters": [
    {
      "id": string,
      "title": string,
      "steps": [
        {
          "narration": string,
          "screenText": string,
          "visual": string,
          "facts": string[]
        }
      ]
    }
  ]
}
`;

  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: "你只输出严格 JSON。" },
        { role: "user", content: prompt },
      ],
      response_format: { type: "json_object" },
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`LLM request failed: ${response.status} ${body}`);
  }
  const json = await response.json() as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = json.choices?.[0]?.message?.content;
  return content ? JSON.parse(content) : null;
}

const browser = await chromium.launch({
  headless: true,
  executablePath: "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
});
const page = await browser.newPage({
  viewport: { width: 1440, height: 1800 },
  deviceScaleFactor: 1,
});
await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 });
await page.waitForTimeout(3000);
await page.screenshot({ path: screenshotPath, fullPage: false });

const article = await page.evaluate((sourceUrl) => {
  const title =
    document.querySelector("meta[property='og:title']")?.getAttribute("content") ||
    document.querySelector("h1")?.textContent ||
    document.title;
  const description =
    document.querySelector("meta[name='description']")?.getAttribute("content") ||
    document.querySelector("meta[property='og:description']")?.getAttribute("content") ||
    "";
  const candidates = [
    ...Array.from(document.querySelectorAll("article p")),
    ...Array.from(document.querySelectorAll("main p")),
    ...Array.from(document.querySelectorAll("p")),
  ];
  const seen = new Set<string>();
  const paragraphs = candidates
    .map((node) => node.textContent?.trim() ?? "")
    .filter((text) => text.length > 30)
    .filter((text) => {
      if (seen.has(text)) return false;
      seen.add(text);
      return true;
    });
  return {
    title,
    description,
    url: sourceUrl,
    text: paragraphs.join("\n\n"),
  };
}, url);
await browser.close();

const cleaned = {
  ...article,
  title: compact(article.title),
  description: compact(article.description),
  text: article.text.trim(),
};

await mkdir(outDir, { recursive: true });
await writeFile(
  resolve(outDir, "article.md"),
  `# ${cleaned.title}\n\nSource: ${cleaned.url}\n\n${cleaned.description}\n\n${cleaned.text}\n`,
  "utf8",
);

const story = await callLLM(cleaned);
if (story) {
  await writeFile(resolve(outDir, "story.json"), JSON.stringify(story, null, 2) + "\n", "utf8");
  const script = story.chapters
    .flatMap((chapter: { steps: Array<{ narration: string }> }) =>
      chapter.steps.map((step) => step.narration),
    )
    .join("\n---\n");
  const outline = story.chapters
    .map((chapter: { id: string; title: string; steps: Array<{ screenText: string; visual: string; facts: string[] }> }, index: number) => {
      const steps = chapter.steps
        .map((step, stepIndex) => `- step ${stepIndex + 1}: ${step.screenText}\n  visual: ${step.visual}\n  facts: ${step.facts.join("；")}`)
        .join("\n");
      return `## ${index + 1}. ${chapter.id} — ${chapter.title}\n${steps}`;
    })
    .join("\n\n");
  await writeFile(resolve(outDir, "script.md"), `# 口播稿\n\n${script}\n`, "utf8");
  await writeFile(resolve(outDir, "outline.md"), `# Video Outline\n\n${outline}\n`, "utf8");
}

await writeFile(
  resolve(outDir, "README.md"),
  [
    "# URL News Input",
    "",
    `Source: ${cleaned.url}`,
    `Screenshot: ${screenshotPath}`,
    "",
    "- article.md: 抓取到的新闻正文",
    "- story.json: LLM 生成的结构化视频方案，未配置 OPENAI_API_KEY 时不会生成",
    "- script.md / outline.md: 从 story.json 派生的口播稿和开发计划",
  ].join("\n") + "\n",
  "utf8",
);

console.log(`article saved: ${resolve(outDir, "article.md")}`);
console.log(`source screenshot saved: ${screenshotPath}`);
console.log(story ? `story saved: ${resolve(outDir, "story.json")}` : "OPENAI_API_KEY not set; skipped LLM story generation");
