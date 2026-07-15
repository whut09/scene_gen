import assert from "node:assert/strict";
import test from "node:test";
import { applyConfigProfile, loadConfigProfile } from "./config-profiles";

test("config profiles load and only fill missing environment values", async () => {
  const profile = await loadConfigProfile("fast-preview");
  assert.equal(profile.env.VIDEO_RENDER_ENGINE, "remotion");
  const previous = Object.fromEntries([...Object.keys(profile.env), "SCENE_GEN_PROFILE"].map((key) => [key, process.env[key]]));
  process.env.VIDEO_RENDER_ENGINE = "html-video";
  try {
    await applyConfigProfile("fast-preview");
    assert.equal(process.env.VIDEO_RENDER_ENGINE, "html-video");
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("HTML rendering profiles define bounded concurrency and encoding presets", async () => {
  const expected = {
    "fast-preview": ["3", "ultrafast"],
    "local-f5": ["2", "veryfast"],
    production: ["2", "medium"],
    "ci-offline": ["1", "ultrafast"],
  } as const;
  for (const [name, [concurrency, preset]] of Object.entries(expected)) {
    const profile = await loadConfigProfile(name);
    assert.equal(profile.env.HTML_RENDER_CONCURRENCY, concurrency);
    assert.equal(profile.env.HTML_RENDER_PRESET, preset);
  }
});
