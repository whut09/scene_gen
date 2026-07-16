import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { diagnoseVideoDurationDrift } from "./quality";

async function fixture(durations: Record<string, number>) {
  const workDir = await mkdtemp(path.join(tmpdir(), "scene-gen-duration-diagnosis-"));
  const graphPath = path.join(workDir, "content-graph.json");
  const nodes = [0, 1].map((sceneIndex) => ({
    id: `scene-0${sceneIndex + 1}`,
    sceneIndex,
    sceneType: "title",
    templateId: "fixture",
    durationSec: 1,
    data: { type: "title", duration: 1, kicker: "Fixture", headline: `Duration fixture ${sceneIndex + 1}`, subhead: "Migration-aware diagnosis", sources: ["test"] },
  }));
  await writeFile(graphPath, JSON.stringify({
    specVersion: 1,
    engine: "html-video-compatible",
    sourceProject: { title: "Duration fixture", createdAt: "2026-07-16T00:00:00.000Z", width: 1080, height: 1920, fps: 30 },
    nodes,
    edges: [{ from: "scene-01", to: "scene-02", type: "sequence" }],
  }), "utf8");
  for (const node of nodes) await writeFile(path.join(workDir, `${node.id}-${node.templateId}.mp4`), "fixture", "utf8");
  await writeFile(path.join(workDir, "video-no-audio.mp4"), "fixture", "utf8");
  return { workDir, graphPath, probeDuration: async (filePath: string) => durations[path.basename(filePath)] ?? 0 };
}

test("duration diagnosis separates mux, concat and scene failures", async () => {
  const mux = await fixture({ "scene-01-fixture.mp4": 1, "scene-02-fixture.mp4": 1, "video-no-audio.mp4": 2 });
  const concat = await fixture({ "scene-01-fixture.mp4": 1, "scene-02-fixture.mp4": 1, "video-no-audio.mp4": 2.5 });
  const scene = await fixture({ "scene-01-fixture.mp4": 1, "scene-02-fixture.mp4": 1.5, "video-no-audio.mp4": 2.5 });
  try {
    assert.equal((await diagnoseVideoDurationDrift({ htmlVideoGraphPath: mux.graphPath, expectedDuration: 2, probeDuration: mux.probeDuration })).likelySource, "mux");
    assert.equal((await diagnoseVideoDurationDrift({ htmlVideoGraphPath: concat.graphPath, expectedDuration: 2, probeDuration: concat.probeDuration })).likelySource, "concat");
    const sceneDiagnosis = await diagnoseVideoDurationDrift({ htmlVideoGraphPath: scene.graphPath, expectedDuration: 2, probeDuration: scene.probeDuration });
    assert.equal(sceneDiagnosis.likelySource, "scene");
    assert.deepEqual(sceneDiagnosis.invalidSceneIndexes, ["1"]);
  } finally {
    await Promise.all([mux.workDir, concat.workDir, scene.workDir].map((directory) => rm(directory, { recursive: true, force: true })));
  }
});
