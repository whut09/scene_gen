import path from "node:path";
import type { VideoProject, VideoScene } from "../pipeline/types";
import { loadDotEnv, parseArgs, readJson, writeJson } from "../pipeline/utils";

interface SceneRevision { sceneIndex: number; scene: VideoScene; narration: string; }

loadDotEnv();
const args = parseArgs(process.argv.slice(2));
if (typeof args.project !== "string" || typeof args.scenes !== "string") throw new Error("Usage: revise-scenes --project <project.json> --scenes 0,2 [--issues text]");
const projectPath = path.resolve(args.project);
const project = await readJson<VideoProject>(projectPath);
const sceneIndexes = [...new Set(args.scenes.split(",").map(Number).filter((value) => Number.isInteger(value) && value >= 0 && value < project.scenes.length))];
if (sceneIndexes.length === 0) throw new Error("No valid scene indexes were provided.");

const apiKey = process.env.NEWS_LLM_API_KEY ?? process.env.OPENAI_API_KEY;
const baseUrl = process.env.NEWS_LLM_BASE_URL ?? process.env.OPENAI_BASE_URL;
const model = process.env.NEWS_LLM_MODEL ?? process.env.OPENAI_MODEL;
if (!apiKey || !baseUrl || !model) throw new Error("NEWS_LLM_API_KEY, NEWS_LLM_BASE_URL and NEWS_LLM_MODEL are required.");

const selected = sceneIndexes.map((sceneIndex) => ({ sceneIndex, scene: project.scenes[sceneIndex], narration: project.narrationSegments?.[sceneIndex]?.text ?? "" }));
const response = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
  method: "POST",
  headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
  body: JSON.stringify({
    model, temperature: 0.18, response_format: { type: "json_object" },
    messages: [
      { role: "system", content: [
        "你是视频分镜局部修订器。只修改指定 sceneIndex，禁止修改其他屏、项目标题、来源事实和场景数量。",
        "每个返回项必须包含 sceneIndex、完整 scene 对象和 narration。scene.type 必须与原场景相同。",
        "旁白只复述该屏可见字段；第一屏第一句话必须逐字念项目标题。不得增加来源中没有的数字。",
        "返回 JSON：{ revisions: [{ sceneIndex, scene, narration }] }。"
      ].join("\n") },
      { role: "user", content: JSON.stringify({ title: project.meta.title, issues: typeof args.issues === "string" ? args.issues : "", source: project.sources, selected }) }
    ]
  })
});
if (!response.ok) throw new Error(`Scene revision failed: ${response.status} ${await response.text()}`);
const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
const content = payload.choices?.[0]?.message?.content;
if (!content) throw new Error("Scene revision returned no content.");
const parsed = JSON.parse(content) as { revisions?: SceneRevision[] };
const revisions = parsed.revisions ?? [];
const scenes = [...project.scenes];
const narrationSegments = [...(project.narrationSegments ?? project.scenes.map((_, sceneIndex) => ({ sceneIndex, text: "" })))];
for (const revision of revisions) {
  if (!sceneIndexes.includes(revision.sceneIndex)) throw new Error(`Revision attempted unrequested scene ${revision.sceneIndex}.`);
  if (!revision.scene || revision.scene.type !== project.scenes[revision.sceneIndex].type) throw new Error(`Revision changed scene type at ${revision.sceneIndex}.`);
  if (!revision.narration?.trim()) throw new Error(`Revision returned empty narration at ${revision.sceneIndex}.`);
  scenes[revision.sceneIndex] = revision.scene;
  narrationSegments[revision.sceneIndex] = { sceneIndex: revision.sceneIndex, text: revision.narration.trim() };
}
if (new Set(revisions.map((item) => item.sceneIndex)).size !== sceneIndexes.length) throw new Error("Scene revision did not return every requested scene.");
const updated: VideoProject = {
  ...project,
  scenes,
  narrationSegments,
  narration: narrationSegments.map((segment) => segment.text).join("\n"),
  audio: undefined,
  revision: { changedSceneIndexes: sceneIndexes, updatedAt: new Date().toISOString() },
};
await writeJson(projectPath, updated);
console.log(`Revised scenes: ${sceneIndexes.map((index) => index + 1).join(", ")}`);
