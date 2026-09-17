import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { deflateSync } from "node:zlib";
import { screenAssetFile } from "../../src/pipeline/asset-screening";
import { evaluateDraft } from "../../src/harness/quality/draft-rules";
import type { VideoProject } from "../../src/pipeline/types";

function crc32(value: Buffer) {
  let checksum = 0xffffffff;
  for (const byte of value) {
    checksum ^= byte;
    for (let bit = 0; bit < 8; bit += 1) checksum = (checksum >>> 1) ^ (checksum & 1 ? 0xedb88320 : 0);
    checksum >>>= 0;
  }
  return (checksum ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer) {
  const typeBuffer = Buffer.from(type, "ascii");
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  return Buffer.concat([length, typeBuffer, data, checksum]);
}

function plainPng() {
  const width = 64;
  const height = 64;
  const rows = Buffer.alloc((width + 1) * height, 255);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(rows)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

test("asset screening degrades to a pass when a scanner is unavailable instead of discarding every asset", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "scene-gen-asset-degraded-"));
  const filePath = path.join(directory, "interface.png");
  const previousPython = process.env.ASSET_FACE_DETECTOR_PYTHON;
  process.env.ASSET_FACE_DETECTOR_PYTHON = "scene-gen-missing-face-scanner";
  try {
    await writeFile(filePath, plainPng());
    const result = await screenAssetFile({ filePath, contentType: "image/png", url: "https://cdn.example.com/interface.png" });
    assert.equal(result.status, "passed");
    assert.ok(result.reasons.includes("visual_screen_degraded"));
    assert.ok(result.reasons.includes("human_face_scan_unavailable"));
  } finally {
    if (previousPython === undefined) delete process.env.ASSET_FACE_DETECTOR_PYTHON;
    else process.env.ASSET_FACE_DETECTOR_PYTHON = previousPython;
    await rm(directory, { recursive: true, force: true });
  }
});

function gateProject(metrics: Record<string, number>): VideoProject {
  return {
    meta: { title: "开源项目深度解读", createdAt: "2026-09-16T00:00:00.000Z", width: 1080, height: 1920, fps: 30, durationSeconds: 12, sourceCount: 1 },
    narration: "开源项目深度解读。介绍项目能力和使用边界。",
    narrationSegments: [{ sceneIndex: 0, text: "开源项目深度解读。介绍项目能力和使用边界。" }],
    scenes: [{ type: "title", duration: 12, kicker: "项目速览", headline: "开源项目深度解读", subhead: "能力与边界", sources: ["项目资料"] }],
    sources: [{
      id: "repo", kind: "github", title: "demo-repo", url: "https://github.com/example/demo-repo", source: "项目资料",
      summary: "介绍项目能力和使用边界", score: 1, tags: [], repo: "example/demo-repo", contentType: "repository",
      metrics: { visualAssetCandidates: 0, visualAssetAccepted: 0, ...metrics },
    }],
  } as VideoProject;
}

test("draft gate flags repository sources whose README images were all silently dropped", async () => {
  const result = await evaluateDraft(gateProject({ visualAssetCandidates: 6 }), 12, "");
  assert.equal(result.issues.some((issue) => issue.code === "visual_asset_missing"), true);
});

test("a page screenshot cannot mask dropped repository imagery", async () => {
  const project = gateProject({ visualAssetCandidates: 6 });
  project.screenshots = [{
    id: "page", title: "仓库页面", source: "GitHub", url: project.sources[0].url,
    src: "/generated/screenshots/page.png", width: 1200, height: 900,
    highlight: { x: 0, y: 0, width: 1200, height: 900 },
  }];
  const result = await evaluateDraft(project, 12, "");
  assert.equal(result.issues.some((issue) => issue.code === "visual_asset_missing"), true);
});

test("draft gate stays silent when the repository has no visual candidates or accepted assets", async () => {
  const withoutCandidates = await evaluateDraft(gateProject({}), 12, "");
  assert.equal(withoutCandidates.issues.some((issue) => issue.code === "visual_asset_missing"), false);
  const accepted = gateProject({ visualAssetCandidates: 6, visualAssetAccepted: 2 });
  accepted.assets = [{
    id: "shot", kind: "image", role: "evidence", title: "项目界面", sourceUrl: "https://example.com/ui.png",
    src: "/generated/assets/example-demo-repo/ui.png", contentType: "image/png", license: "test",
    screening: { status: "passed", reasons: ["metadata_screen_passed"], detectorVersion: "test" },
  }];
  const withAccepted = await evaluateDraft(accepted, 12, "");
  assert.equal(withAccepted.issues.some((issue) => issue.code === "visual_asset_missing"), false);
});
