import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { deflateSync } from "node:zlib";
import { screenAssetFile, screenAssetMetadata } from "../../src/pipeline/asset-screening";
import { assetPromotionIssues } from "../../src/harness/quality/video-rules";
import type { VideoProject } from "../../src/pipeline/types";

function crc32(value: Buffer) {
  let checksum = 0xffffffff;
  for (const byte of value) {
    checksum ^= byte;
    for (let bit = 0; bit < 8; bit += 1) checksum = (checksum >>> 1) ^ (checksum & 1 ? 0xedb88320 : 0);
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

function qrLikePng() {
  const width = 256;
  const height = 256;
  const rows = Buffer.alloc((width + 1) * height, 255);
  for (let row = 0; row < height; row += 1) rows[row * (width + 1)] = 0;
  const drawFinder = (originX: number, originY: number) => {
    for (let row = 0; row < 49; row += 1) {
      for (let column = 0; column < 49; column += 1) {
        const moduleRow = Math.floor(row / 7);
        const moduleColumn = Math.floor(column / 7);
        const dark = moduleRow === 0 || moduleRow === 6 || moduleColumn === 0 || moduleColumn === 6 || (moduleRow >= 2 && moduleRow <= 4 && moduleColumn >= 2 && moduleColumn <= 4);
        if (dark) rows[(originY + row) * (width + 1) + 1 + originX + column] = 0;
      }
    }
  };
  drawFinder(24, 24);
  drawFinder(183, 24);
  drawFinder(24, 183);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 0;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(rows)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

test("asset screening rejects QR and promotional metadata", () => {
  assert.equal(screenAssetMetadata({ alt: "扫码关注公众号", url: "https://cdn.example.com/demo.png" }).status, "rejected");
  assert.equal(screenAssetMetadata({ alt: "产品操作界面", url: "https://cdn.example.com/dashboard.png" }).status, "passed");
});

test("asset screening rejects promotional SVG text", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "scene-gen-asset-screen-"));
  const filePath = path.join(directory, "asset.svg");
  try {
    await writeFile(filePath, "<svg><text>扫码关注公众号</text></svg>", "utf8");
    const result = await screenAssetFile({ filePath, contentType: "image/svg+xml", url: "https://cdn.example.com/asset.svg" });
    assert.equal(result.status, "rejected");
    assert.ok(result.reasons.includes("call_to_action_metadata"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("asset screening rejects a QR-like raster pattern", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "scene-gen-qr-screen-"));
  const filePath = path.join(directory, "interface.png");
  try {
    await writeFile(filePath, qrLikePng());
    const result = await screenAssetFile({ filePath, contentType: "image/png", url: "https://cdn.example.com/interface.png" });
    assert.equal(result.status, "rejected");
    assert.ok(result.reasons.includes("qr_code_visual_pattern"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("video asset gate blocks rejected or promotional assets", () => {
  const issues = assetPromotionIssues({ assets: [
    { id: "qr", kind: "image", role: "evidence", title: "产品界面", sourceUrl: "https://cdn.example.com/qr-code.png", src: "/generated/qr.png", contentType: "image/png", license: "test" },
    { id: "ad", kind: "image", role: "evidence", title: "扫码关注", sourceUrl: "https://cdn.example.com/demo.png", src: "/generated/ad.png", contentType: "image/png", license: "test" },
  ] } as VideoProject);
  assert.equal(issues.length, 2);
  assert.ok(issues.every((issue) => issue.code === "asset_promotional_content_exposed"));
});
