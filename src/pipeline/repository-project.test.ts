import assert from "node:assert/strict";
import test from "node:test";
import { expectedVideoFileName, projectHomepageTitle } from "./output-naming";
import { ensureRepositoryProjectIdentity, repositoryProjectName } from "./repository-project";
import { ensureTitleSpokenFirst, projectRepositoryDate } from "./news-date";
import type { VideoProject } from "./types";

function fixture(): VideoProject {
  return {
    meta: { title: "中文项目标题", createdAt: "2026-07-22T00:00:00.000Z", width: 1080, height: 1920, fps: 30, durationSeconds: 10, sourceCount: 1 },
    narration: "中文项目标题。项目介绍。",
    narrationSegments: [{ sceneIndex: 0, text: "中文项目标题。项目介绍。" }],
    scenes: [{ type: "title", duration: 10, kicker: "项目速览", headline: "中文项目标题", subhead: "项目介绍", sources: ["事实"] }],
    sources: [{ id: "repo", kind: "github", title: "text-to-cad", url: "https://github.com/earthtojake/text-to-cad", source: "项目资料", summary: "项目介绍", score: 1, tags: [], repo: "earthtojake/text-to-cad", contentType: "repository" }],
  };
}

test("repository identity uses the original repository name", () => {
  const project = fixture();
  assert.equal(repositoryProjectName(project), "text-to-cad");
  const normalized = ensureRepositoryProjectIdentity(project);
  assert.equal(normalized.meta.title, "text-to-cad");
  assert.equal(normalized.scenes[0].type, "title");
  assert.equal((normalized.scenes[0] as Extract<typeof normalized.scenes[number], { type: "title" }>).headline, "今日开源热点趋势项目推荐：text-to-cad｜项目介绍");
  assert.match(normalized.narrationSegments![0].text, /^今日开源热点趋势项目推荐：text-to-cad｜项目介绍。/u);
  assert.equal(projectHomepageTitle(normalized), "今日开源热点趋势项目推荐：text-to-cad｜项目介绍");
  assert.equal(expectedVideoFileName(normalized), "今日开源热点趋势项目推荐：text-to-cad｜项目介绍.mp4");
  assert.equal(projectRepositoryDate(normalized), "2026年7月22日");
  assert.match(normalized.narrationSegments![0].ttsText ?? "", /^今日开源热点趋势项目推荐：Text To Cad｜项目介绍。/u);
  assert.doesNotMatch(normalized.narration, /2026年7月22日|推荐日期/u);
});

test("repository synthesis text is refreshed from the public project name", () => {
  const project = fixture();
  project.sources[0].repo = "MoonshotAI/kimi-code";
  project.narrationSegments![0].ttsText = "过期的中文别名";

  const normalized = ensureRepositoryProjectIdentity(project);

  assert.match(normalized.narrationSegments![0].ttsText ?? "", /^今日开源热点趋势项目推荐：Kimi Code｜项目介绍。/u);
  assert.doesNotMatch(normalized.narrationSegments![0].ttsText ?? "", /过期/u);
});

test("repository date remains available after display-date normalization", () => {
  const project = fixture();
  project.meta.createdAt = "2026年8月9日";
  assert.equal(projectRepositoryDate(project), "2026年8月9日");
});

test("repository synthesis alias survives the title-first normalization", () => {
  const project = fixture();
  project.sources[0].repo = "MoonshotAI/kimi-code";

  const normalized = ensureRepositoryProjectIdentity(ensureTitleSpokenFirst(project));

  assert.match(normalized.narrationSegments![0].ttsText ?? "", /^今日开源热点趋势项目推荐：Kimi Code｜项目介绍。/u);
});

test("title-first normalization preserves the canonical repository recommendation", () => {
  const project = fixture();
  project.sources[0].repo = "pingdotgg/t3code";

  const normalized = ensureTitleSpokenFirst(ensureRepositoryProjectIdentity(project));

  assert.match(normalized.narrationSegments![0].text, /^今日开源热点趋势项目推荐：t3code｜项目介绍。/u);
  assert.match(normalized.narrationSegments![0].ttsText ?? "", /^今日开源热点趋势项目推荐：T3code｜项目介绍。/u);
});

test("repository homepage title, file name, and narration share the same use summary", () => {
  const project = fixture();
  project.scenes[0] = { type: "title", duration: 10, kicker: "今日开源热点趋势项目推荐", headline: "今日开源热点趋势项目推荐：text-to-cad｜用文字生成三维模型", subhead: "用途：用文字生成三维模型；适用场景：快速建模", sources: ["项目资料"] };

  const normalized = ensureRepositoryProjectIdentity(project);

  assert.equal(projectHomepageTitle(normalized), "今日开源热点趋势项目推荐：text-to-cad｜用文字生成三维模型");
  assert.equal(expectedVideoFileName(normalized), "今日开源热点趋势项目推荐：text-to-cad｜用文字生成三维模型.mp4");
  assert.match(normalized.narrationSegments![0].text, /^今日开源热点趋势项目推荐：text-to-cad｜用文字生成三维模型。/u);
});

test("repository identity removes equivalent duplicate homepage titles", () => {
  const project = fixture();
  project.scenes[0] = { type: "title", duration: 10, kicker: "今日开源热点趋势项目推荐", headline: "今日开源热点趋势项目推荐：text-to-cad｜用文字生成三维模型", subhead: "用途：用文字生成三维模型；适用场景：快速建模", sources: ["项目资料"] };
  project.narrationSegments![0].text = "今日开源热点趋势项目推荐：text-to-cad｜用文字生成三维模型。今日开源热点趋势项目推荐：text-to-cad，用文字生成三维模型。它把文字描述转换成三维模型。";

  const normalized = ensureRepositoryProjectIdentity(project);
  const opening = "今日开源热点趋势项目推荐：text-to-cad｜用文字生成三维模型";

  assert.equal(normalized.narrationSegments![0].text, `${opening}。它把文字描述转换成三维模型。`);
  assert.equal((normalized.narrationSegments![0].text.match(/今日开源热点趋势项目推荐/gu) ?? []).length, 1);
  assert.equal((normalized.narrationSegments![0].ttsText?.match(/今日开源热点趋势项目推荐/gu) ?? []).length, 1);
  assert.equal(ensureRepositoryProjectIdentity(normalized).narrationSegments![0].text, normalized.narrationSegments![0].text);
});
