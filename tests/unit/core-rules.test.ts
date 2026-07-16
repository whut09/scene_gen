import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { createHtmlVideoCacheKey, hashHtmlAssetContent } from "../../src/html-video/render-html-video";
import { evaluateDraft } from "../../src/harness/quality";
import { ensureTitleOpening } from "../../src/pipeline/llm";
import { prepareF5SynthesisText } from "../../src/pipeline/tts";
import { selectTemplateForScene } from "../../src/templates/template-registry";
import { createFixtureProject } from "../fixtures/project";

test("number pronunciation converts common Chinese news formats", () => {
  const text = prepareF5SynthesisText("2026年增长12.5%，覆盖1000+用户，版本4.0");
  assert.equal(/\d/.test(text), false);
  assert.match(text, /二零二六年/);
  assert.match(text, /百分之十二点五/);
  assert.match(text, /一千以上用户/);
  assert.match(text, /四点零/);
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
