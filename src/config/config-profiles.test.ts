import assert from "node:assert/strict";
import test from "node:test";
import { applyConfigProfile, loadConfigProfile } from "./config-profiles";

test("config profiles load without mutating the global environment", async () => {
  const profile = await loadConfigProfile("fast-preview");
  assert.equal(profile.env.VIDEO_RENDER_ENGINE, "remotion");
  const previousEngine = process.env.VIDEO_RENDER_ENGINE;
  const previousProfile = process.env.SCENE_GEN_PROFILE;
  process.env.VIDEO_RENDER_ENGINE = "html-video";
  try {
    const applied = await applyConfigProfile("fast-preview");
    assert.equal(applied.name, "fast-preview");
    assert.equal(process.env.VIDEO_RENDER_ENGINE, "html-video");
    assert.equal(process.env.SCENE_GEN_PROFILE, previousProfile);
  } finally {
    if (previousEngine === undefined) delete process.env.VIDEO_RENDER_ENGINE;
    else process.env.VIDEO_RENDER_ENGINE = previousEngine;
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
