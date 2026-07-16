import assert from "node:assert/strict";
import test from "node:test";
import { createF5NarrationCacheKey, type F5NarrationCacheIdentity } from "../../src/pipeline/tts-cache";
import {
  applyTtsSpokenFallbacks,
  findTtsPronunciations,
  loadTtsPronunciationLexicon,
  parseTtsPronunciationLexicon,
  pronunciationCacheHash,
} from "../../src/pipeline/tts-pronunciation";
import { videoProjectSchema } from "../../src/pipeline/schemas";
import { createFixtureProject } from "../fixtures/project";

test("Chinese pronunciation lexicon defines required polyphones", () => {
  const loaded = loadTtsPronunciationLexicon();
  const entries = new Map(loaded.lexicon.entries.map((entry) => [entry.phrase, entry]));
  assert.deepEqual(entries.get("重构")?.pinyin, ["chong2", "gou4"]);
  assert.deepEqual(entries.get("重复")?.pinyin, ["chong2", "fu4"]);
  assert.deepEqual(entries.get("重要")?.pinyin, ["zhong4", "yao4"]);
  assert.deepEqual(entries.get("重量")?.pinyin, ["zhong4", "liang4"]);
  assert.deepEqual(entries.get("重启")?.pinyin, ["chong2", "qi3"]);
  assert.deepEqual(entries.get("重试")?.pinyin, ["chong2", "shi4"]);
  assert.deepEqual(entries.get("重载运输")?.pinyin, ["zhong4", "zai4", "yun4", "shu1"]);
  assert.equal(loaded.hash.length, 64);
  const changed = JSON.stringify({
    ...loaded.lexicon,
    version: loaded.lexicon.version + 1,
  });
  assert.notEqual(parseTtsPronunciationLexicon(changed).hash, loaded.hash);
});

test("pronunciation matching covers phrases inside longer narration", () => {
  assert.deepEqual(findTtsPronunciations("重构系统").map((entry) => entry.phrase), ["重构"]);
  assert.deepEqual(findTtsPronunciations("对代码进行重构").map((entry) => entry.phrase), ["重构"]);
  assert.deepEqual(findTtsPronunciations("重新构建").map((entry) => entry.phrase), []);
});

test("pronunciation cache hashes only entries relevant to the current text", () => {
  const loaded = loadTtsPronunciationLexicon();
  const target = loaded.lexicon.entries[0];
  const unrelated = loaded.lexicon.entries[1];
  const targetText = `系统完成${target.phrase}`;
  const baseHash = pronunciationCacheHash(targetText, loaded);
  const unrelatedChanged = parseTtsPronunciationLexicon(JSON.stringify({
    ...loaded.lexicon,
    version: loaded.lexicon.version + 1,
    entries: loaded.lexicon.entries.map((entry) => entry.phrase === unrelated.phrase
      ? { ...entry, spokenFallback: `${entry.spokenFallback}更新` }
      : entry),
  }));
  assert.equal(pronunciationCacheHash(targetText, unrelatedChanged), baseHash);
  const targetChanged = parseTtsPronunciationLexicon(JSON.stringify({
    ...loaded.lexicon,
    version: loaded.lexicon.version + 1,
    entries: loaded.lexicon.entries.map((entry) => entry.phrase === target.phrase
      ? { ...entry, spokenFallback: `${entry.spokenFallback}更新` }
      : entry),
  }));
  assert.notEqual(pronunciationCacheHash(targetText, targetChanged), baseHash);
});

test("spoken fallback changes only synthesis text when explicitly enabled", () => {
  const source = "系统完成核心模块重构";
  assert.equal(applyTtsSpokenFallbacks(source, { enabled: false }), source);
  assert.equal(applyTtsSpokenFallbacks(source, { enabled: true }), "系统完成核心模块重新构建");
});

test("narration ttsText is validated without changing display text", () => {
  const project = createFixtureProject();
  const text = project.narrationSegments?.[0].text ?? "";
  const parsed = videoProjectSchema.parse({
    ...project,
    narrationSegments: [{ ...project.narrationSegments?.[0], ttsText: "开源视频生成工具发布新版本。它完成了核心模块重新构建。" }],
  });
  assert.equal(parsed.narrationSegments?.[0].text, text);
  assert.match(parsed.narrationSegments?.[0].ttsText ?? "", /重新构建/);
});

test("F5 narration cache key includes every pronunciation input", () => {
  const base: F5NarrationCacheIdentity = {
    provider: "f5",
    model: "F5TTS_v1_Base",
    normalizedTtsText: "系统完成核心模块重构",
    pronunciationLexiconHash: "a".repeat(64),
    refAudioHash: "b".repeat(64),
    refTextHash: "c".repeat(64),
    speed: "1.25",
    nfeStep: "16",
    frontendVersion: "frontend-v1",
  };
  const baseKey = createF5NarrationCacheKey(base);
  const changes: Array<Partial<F5NarrationCacheIdentity>> = [
    { model: "F5TTS_v1_Custom" },
    { normalizedTtsText: "系统完成核心模块重新构建" },
    { pronunciationLexiconHash: "d".repeat(64) },
    { refAudioHash: "e".repeat(64) },
    { refTextHash: "f".repeat(64) },
    { speed: "1.20" },
    { nfeStep: "32" },
    { frontendVersion: "frontend-v2" },
    { cacheSalt: "pronunciation-repair-v2" },
  ];
  for (const change of changes) assert.notEqual(createF5NarrationCacheKey({ ...base, ...change }), baseKey);
});
