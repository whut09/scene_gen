import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { createHtmlVideoCacheKey, hashHtmlAssetContent } from "../../src/html-video/render-html-video";
import { evaluateDraft } from "../../src/harness/quality";
import { extraNarrationNumbers } from "../../src/harness/quality/draft-rules";
import { ensureTitleOpening } from "../../src/pipeline/llm";
import { prepareF5SynthesisText } from "../../src/pipeline/tts";
import { narrationSynthesisText } from "../../src/pipeline/tts/segmentation";
import { selectTemplateForScene } from "../../src/templates/template-registry";
import { syncCueCandidates } from "../../src/production/visual-planner";
import { createFixtureProject } from "../fixtures/project";
import { containsForbiddenPlatformPromotion, scrubAttribution, scrubGithubReference } from "../../src/pipeline/story";
import { expectedVideoFileName, homepageTitleBasedVideoPath, projectHomepageTitle, provisionalVideoFileName, titleBasedVideoPath, videoFileNameFromTitle } from "../../src/pipeline/output-naming";

test("number pronunciation converts common Chinese news formats", () => {
  const text = prepareF5SynthesisText("2026年发布，版本编号2026，增长12.5%，覆盖1000+用户，版本4.0");
  assert.equal(/\d/.test(text), false);
  assert.match(text, /二零二六年/);
  assert.equal((text.match(/二零二六/g) ?? []).length, 2);
  assert.match(text, /百分之十二点五/);
  assert.match(text, /一千以上用户/);
  assert.match(text, /四点零/);
});

test("cloud narration keeps a leading AI acronym without expanding it", () => {
  const segment = { sceneIndex: 0, text: "AI 圈又在造新词。" };
  assert.equal(narrationSynthesisText(segment), "AI 圈又在造新词。");
  assert.equal(segment.text, "AI 圈又在造新词。");
});

test("TTS normalization preserves Agent product names and AI Agent", () => {
  assert.equal(
    prepareF5SynthesisText("Agent-Reach 为 AI Agent 提供联网能力。"),
    "Agent-Reach 为 AI Agent 提供联网能力。",
  );
});

test("cloud narration repairs a stale AI expansion in ttsText", () => {
  const segment = { sceneIndex: 0, text: "AI 系统完成更新。", ttsText: "人工智能系统完成更新。" };
  assert.equal(narrationSynthesisText(segment), "AI 系统完成更新。");
  assert.equal(segment.text, "AI 系统完成更新。");
});

test("public narration removes third-party platform promotion", () => {
  const text = "Seed Audio 已在火山方舟体验中心上线，附相关链接。核心能力保持不变。";
  assert.equal(containsForbiddenPlatformPromotion(text), true);
  assert.equal(scrubAttribution(text).includes("火山方舟"), false);
  assert.equal(scrubAttribution(text).includes("附相关链接"), false);
});

test("cloud narration uses stable Mandarin-friendly technical acronyms", () => {
  const text = prepareF5SynthesisText("Seed Audio 1.0 在 AB 评测和 MOS 指标中表现稳定。");
  assert.match(text, /Seed Audio\s+一点零/);
  assert.match(text, /A、B/);
  assert.match(text, /M、O、S/);
});

test("title opening is inserted once and remains idempotent", () => {
  const title = "开源视频生成工具发布新版本";
  const narration = "这次更新重点改进离线测试。";
  const opened = ensureTitleOpening(title, narration);
  assert.equal(opened.startsWith(title), true);
  assert.equal(ensureTitleOpening(title, opened), opened);
});

test("draft quality catches a narration that does not open with the title", async () => {
  const narration = "这次更新重点改进离线测试。";
  const project = createFixtureProject({
    narration,
    narrationSegments: [{ sceneIndex: 0, text: narration, audioStartSeconds: 0, durationSeconds: 10 }],
  });
  const result = await evaluateDraft(project, 10, "");
  assert.equal(result.issues.some((issue) => issue.code === "title_not_spoken_first"), true);
});

test("draft release status accepts the source wording 对外推出 without upgrading it", async () => {
  const project = createFixtureProject();
  const narration = `${project.meta.title}。主产品对外推出三款模型。`;
  project.sources[0].content = "主产品对外推出三款模型。另一产品随后正式发布。";
  project.narration = narration;
  project.narrationSegments = [{ sceneIndex: 0, text: narration }];
  const result = await evaluateDraft(project, 10, "");
  assert.equal(result.issues.some((issue) => issue.code === "release_status_weakened"), false);
});

test("draft quality blocks unmatched punctuation before TTS", async () => {
  const project = createFixtureProject();
  project.narrationSegments!.at(-1)!.text += "(";
  project.narration = project.narrationSegments!.map((segment) => segment.text).join("\n");
  const result = await evaluateDraft(project, 100);
  assert.ok(result.issues.some((issue) => issue.code === "narration_punctuation_unbalanced"));
});

test("draft number checks ignore model identifiers but keep factual numbers", () => {
  assert.deepEqual(extraNarrationNumbers("K3 新模型", "K3 定价更低"), []);
  assert.deepEqual(extraNarrationNumbers("K3 新模型", "K3 拥有 2.8 万亿参数"), ["2.8"]);
  assert.deepEqual(extraNarrationNumbers("版本 v2.2", "版本 v2.2 已发布"), []);
});

test("web screenshot scenes expose their headline and evidence title to sync cues", () => {
  const cues = syncCueCandidates({
    type: "web_screenshot_zoom",
    duration: 10,
    headline: "Kimi K3面向四类复杂任务",
    shots: [{ id: "shot", title: "美媒：中国K3大模型震惊AI界", source: "fixture", url: "https://example.com", src: "/shot.png", width: 1080, height: 1920 }],
  });
  assert.deepEqual(cues, ["KimiK3面向四类复杂任务", "美媒中国K3大模型震惊AI界"]);
});

test("template selection is deterministic and supports the scene", () => {
  const project = createFixtureProject();
  const first = selectTemplateForScene(project.scenes[0], project, { sceneIndex: 0 });
  const second = selectTemplateForScene(project.scenes[0], project, { sceneIndex: 0 });
  assert.equal(first.template.id, second.template.id);
  assert.equal(first.variantId, second.variantId);
  assert.equal(first.template.supportedScenes.includes(project.scenes[0].type), true);
});

test("no-progress template exclusions select an alternate template or variant", () => {
  const project = createFixtureProject();
  const previous = process.env.HTML_TEMPLATE_EXCLUSIONS;
  try {
    const first = selectTemplateForScene(project.scenes[0], project, { sceneIndex: 0 });
    process.env.HTML_TEMPLATE_EXCLUSIONS = JSON.stringify({ 0: [`${first.template.id}:${first.variantId}`] });
    const alternate = selectTemplateForScene(project.scenes[0], project, { sceneIndex: 0 });
    assert.notEqual(`${alternate.template.id}:${alternate.variantId}`, `${first.template.id}:${first.variantId}`);
  } finally {
    if (previous === undefined) delete process.env.HTML_TEMPLATE_EXCLUSIONS; else process.env.HTML_TEMPLATE_EXCLUSIONS = previous;
  }
});

test("HTML video cache keys ignore duration but include rendering inputs", () => {
  const project = createFixtureProject();
  const scene = project.scenes[0];
  const base = {
    scene,
    templateId: "kinetic-title",
    templateVersion: "1.3.0",
    variantId: "launch-impact",
    width: 1080,
    height: 1920,
    fps: 30,
  };
  const key = createHtmlVideoCacheKey(base);
  assert.equal(createHtmlVideoCacheKey({ ...base, scene: { ...scene, duration: 15 } }), key);
  assert.notEqual(createHtmlVideoCacheKey({ ...base, width: 720 }), key);
  assert.notEqual(createHtmlVideoCacheKey({ ...base, variantId: "research-stack" }), key);
  assert.notEqual(createHtmlVideoCacheKey({ ...base, globalCssHash: "css-v2" }), key);
  assert.notEqual(createHtmlVideoCacheKey({ ...base, assetContentHash: "asset-v2" }), key);
  assert.notEqual(createHtmlVideoCacheKey({ ...base, encoderProfile: "medium" }), key);
  assert.notEqual(createHtmlVideoCacheKey({
    ...base,
    syncCues: [{ text: "Worker", startRatio: 0.2, endRatio: 0.4, timingSource: "forced-alignment", emphasis: "primary" }],
  }), key);
});

test("HTML video asset fingerprints use file content instead of path or mtime", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "scene-gen-asset-hash-"));
  const assetPath = path.join(directory, "asset.png");
  try {
    await writeFile(assetPath, "first", "utf8");
    const html = `<img src="${pathToFileURL(assetPath).href}">`;
    const first = await hashHtmlAssetContent(html);
    await writeFile(assetPath, "second", "utf8");
    assert.notEqual(await hashHtmlAssetContent(html), first);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("published video filename is derived from the Chinese homepage title", () => {
  assert.equal(videoFileNameFromTitle("英伟达发布新一代检索模型"), "英伟达发布新一代检索模型.mp4");
  assert.equal(titleBasedVideoPath("E:/output/news-qbitai-v2.mp4", "数字员工正式进入企业流程"), path.join("E:/output", "数字员工正式进入企业流程.mp4"));
  assert.equal(provisionalVideoFileName("OpenRouter", "cached-project"), "openrouter.mp4");
  assert.throws(() => videoFileNameFromTitle("OpenRouter"), /Chinese characters/);
  assert.equal(homepageTitleBasedVideoPath("E:/output/old.mp4", "开源项目推荐：ai-agent-book"), path.join("E:/output", "开源项目推荐：ai-agent-book.mp4"));
  const project = createFixtureProject();
  project.meta.title = "内部项目标题";
  project.scenes[0] = { ...project.scenes[0], type: "title", headline: "视频首页标题" };
  assert.equal(projectHomepageTitle(project), "视频首页标题");
  assert.equal(expectedVideoFileName(project), "视频首页标题.mp4");
});

test("news source websites are scrubbed and blocked by the draft gate", async () => {
  assert.equal(scrubAttribution("据IT之家消息，模型今天正式发布。"), "模型今天正式发布。");
  assert.equal(scrubAttribution("这是来自IT之家的报道。"), "这是。");
  assert.equal(scrubAttribution("潮新闻客户端 记者 李稀“零基础月入过万”"), "“零基础月入过万”");
  assert.equal(scrubAttribution("图源：网络截图 烧钱的真相"), "烧钱的真相");
  const project = createFixtureProject();
  project.sources[0] = { ...project.sources[0], url: "https://www.ithome.com/0/978/453.htm", contentType: "news" };
  project.narration = `${project.narration} 来自IT之家的报道。`;
  const result = await evaluateDraft(project, project.meta.durationSeconds, "");
  assert.equal(result.issues.some((issue) => issue.code === "source_attribution_exposed"), true);
});

test("repository videos hide hosting platforms and repository addresses", async () => {
  assert.equal(scrubGithubReference("GitHub 仓库：https://github.com/HKUDS/DeepTutor，地址 HKUDS/DeepTutor", ["HKUDS/DeepTutor"]), "开源项目 仓库：开源项目，地址 DeepTutor");
  const project = createFixtureProject();
  project.sources[0] = { ...project.sources[0], kind: "github", contentType: "repository", repo: "HKUDS/DeepTutor", url: "https://github.com/HKUDS/DeepTutor" };
  project.narration = `${project.narration} 项目托管在 GitHub，仓库地址是 HKUDS/DeepTutor。`;
  const result = await evaluateDraft(project, project.meta.durationSeconds, "");
  assert.equal(result.issues.some((issue) => issue.code === "external_platform_reference_exposed"), true);
});
