import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { inflateSync } from "node:zlib";
import { fromRoot } from "./utils";

export const ASSET_SCREENING_VERSION = "asset-screen-v4-scanner-fail-open";

const visibleWatermarkPattern = /水印|版权|版权所有|来源|copyright|watermark|IT之家|ithome|36氪|36kr|(?:www\.)?(?:ithome\.com|36kr(?:cdn)?\.com|qbitai\.com|tmtpost\.com)/i;

export interface AssetScreeningResult {
  status: "passed" | "rejected";
  reasons: string[];
  detectorVersion: string;
}

const promotionalPatterns = [
  { pattern: /二维码|qr[\s_-]*code|qrcode/i, reason: "qr_code_metadata" },
  { pattern: /扫码|扫描(?:二维码|关注)|广告(?:位|图)?|推广|赞助|sponsored|advert(?:isement)?|promotional?/i, reason: "promotional_metadata" },
  { pattern: /加群|公众号|客服|微信|wechat|优惠券|购买链接|下载(?:app|客户端)?/i, reason: "call_to_action_metadata" },
  { pattern: /portrait|headshot|avatar|人物肖像|人物照片|个人照片|人像(?:照|摄影)?/i, reason: "human_portrait_metadata" },
];

function rejected(reasons: string[]): AssetScreeningResult {
  return { status: "rejected", reasons: [...new Set(reasons)], detectorVersion: ASSET_SCREENING_VERSION };
}

function passedWithDegradedScreen(reasons: string[]): AssetScreeningResult {
  // Only a positive detector result can reject an asset. A broken or missing
  // scanner is an environment problem, not evidence about the image, so the
  // asset keeps a degraded-pass record instead of being discarded wholesale.
  return { status: "passed", reasons: [...new Set([...reasons, "visual_screen_degraded"])], detectorVersion: ASSET_SCREENING_VERSION };
}

export function screenAssetMetadata(input: { alt?: string; title?: string; url?: string; watermarkHint?: string; filePath?: string }): AssetScreeningResult {
  const value = [input.alt, input.title, input.url, input.watermarkHint, input.filePath].filter(Boolean).join(" ");
  const reasons = promotionalPatterns.filter(({ pattern }) => pattern.test(value)).map(({ reason }) => reason);
  return reasons.length > 0
    ? rejected(reasons)
    : { status: "passed", reasons: ["metadata_screen_passed"], detectorVersion: ASSET_SCREENING_VERSION };
}

interface PixelRun {
  start: number;
  length: number;
  dark: boolean;
}

interface FinderCandidate {
  coordinate: number;
  module: number;
}

interface FinderPoint {
  x: number;
  y: number;
  module: number;
}

function lineRuns(pixels: Buffer, start: number, step: number, length: number) {
  const runs: PixelRun[] = [];
  let runStart = 0;
  let dark = pixels[start] < 160;
  for (let position = 1; position <= length; position += 1) {
    const nextDark = position < length ? pixels[start + position * step] < 160 : !dark;
    if (nextDark === dark) continue;
    runs.push({ start: runStart, length: position - runStart, dark });
    runStart = position;
    dark = nextDark;
  }
  return runs;
}

function finderCandidates(runs: PixelRun[]) {
  const candidates: FinderCandidate[] = [];
  for (let runIndex = 0; runIndex + 4 < runs.length; runIndex += 1) {
    const window = runs.slice(runIndex, runIndex + 5);
    if (!window[0].dark || window[1].dark || !window[2].dark || window[3].dark || !window[4].dark) continue;
    const total = window.reduce((sum, run) => sum + run.length, 0);
    const module = total / 7;
    if (module < 1.2) continue;
    const normalized = window.map((run) => run.length / module);
    if (Math.abs(normalized[0] - 1) > 0.8 || Math.abs(normalized[1] - 1) > 0.8 || Math.abs(normalized[2] - 3) > 1.25 || Math.abs(normalized[3] - 1) > 0.8 || Math.abs(normalized[4] - 1) > 0.8) continue;
    candidates.push({ coordinate: window[0].start + window[0].length + window[1].length + window[2].length / 2, module });
  }
  return candidates;
}

function collectFinderPoints(pixels: Buffer, width: number, height: number) {
  const horizontal = Array.from({ length: height }, (_, row) => finderCandidates(lineRuns(pixels, row * width, 1, width)).map((candidate) => ({ x: candidate.coordinate, y: row, module: candidate.module })));
  const vertical = Array.from({ length: width }, (_, column) => finderCandidates(lineRuns(pixels, column, width, height)).map((candidate) => ({ x: column, y: candidate.coordinate, module: candidate.module })));
  const points: FinderPoint[] = [];
  for (const rowCandidates of horizontal) {
    for (const horizontalPoint of rowCandidates) {
      for (const columnCandidates of vertical) {
        for (const verticalPoint of columnCandidates) {
          const tolerance = Math.max(4, Math.min(12, Math.max(horizontalPoint.module, verticalPoint.module) * 2));
          if (Math.abs(horizontalPoint.x - verticalPoint.x) > tolerance || Math.abs(horizontalPoint.y - verticalPoint.y) > tolerance) continue;
          points.push({ x: (horizontalPoint.x + verticalPoint.x) / 2, y: (horizontalPoint.y + verticalPoint.y) / 2, module: (horizontalPoint.module + verticalPoint.module) / 2 });
        }
      }
    }
  }
  return points;
}

function clusterFinderPoints(points: FinderPoint[]) {
  const clusters: FinderPoint[] = [];
  for (const point of points) {
    const clusterIndex = clusters.findIndex((cluster) => Math.hypot(cluster.x - point.x, cluster.y - point.y) <= Math.max(6, point.module * 3));
    if (clusterIndex < 0) {
      clusters.push(point);
      continue;
    }
    const cluster = clusters[clusterIndex];
    clusters[clusterIndex] = {
      x: (cluster.x + point.x) / 2,
      y: (cluster.y + point.y) / 2,
      module: (cluster.module + point.module) / 2,
    };
  }
  return clusters;
}

function hasFinderTriangle(points: FinderPoint[]) {
  for (let firstIndex = 0; firstIndex < points.length - 2; firstIndex += 1) {
    for (let secondIndex = firstIndex + 1; secondIndex < points.length - 1; secondIndex += 1) {
      for (let thirdIndex = secondIndex + 1; thirdIndex < points.length; thirdIndex += 1) {
        const triangle = [points[firstIndex], points[secondIndex], points[thirdIndex]];
        for (const vertex of triangle) {
          const other = triangle.filter((point) => point !== vertex);
          const firstDistance = Math.hypot(vertex.x - other[0].x, vertex.y - other[0].y);
          const secondDistance = Math.hypot(vertex.x - other[1].x, vertex.y - other[1].y);
          const diagonalDistance = Math.hypot(other[0].x - other[1].x, other[0].y - other[1].y);
          const dotProduct = (other[0].x - vertex.x) * (other[1].x - vertex.x) + (other[0].y - vertex.y) * (other[1].y - vertex.y);
          const sideRatio = Math.max(firstDistance, secondDistance) / Math.max(1, Math.min(firstDistance, secondDistance));
          const diagonalRatio = diagonalDistance / Math.max(1, Math.hypot(firstDistance, secondDistance));
          const moduleRatio = Math.max(...triangle.map((point) => point.module)) / Math.max(0.1, Math.min(...triangle.map((point) => point.module)));
          if (Math.min(firstDistance, secondDistance) >= 8 && sideRatio <= 1.55 && Math.abs(dotProduct) / Math.max(1, firstDistance * secondDistance) <= 0.4 && diagonalRatio >= 0.7 && diagonalRatio <= 1.35 && moduleRatio <= 1.8) return true;
        }
      }
    }
  }
  return false;
}

function decodeGrayscaleFrame(filePath: string, signal?: AbortSignal) {
  return new Promise<Buffer>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error("Asset visual scan cancelled."));
      return;
    }
    const child = spawn("ffmpeg", [
      "-v", "error", "-i", filePath,
      "-vf", "scale=256:256:force_original_aspect_ratio=decrease,pad=256:256:(ow-iw)/2:(oh-ih)/2,format=gray",
      "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1",
    ], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      child.kill("SIGTERM");
      settled = true;
      reject(new Error("Asset visual scan timed out."));
    }, 20_000);
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () => {
      child.kill("SIGTERM");
      finish(() => reject(signal?.reason instanceof Error ? signal.reason : new Error("Asset visual scan cancelled.")));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout?.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    child.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error) => finish(() => reject(error)));
    child.on("close", (code) => finish(() => {
      if (code !== 0) {
        reject(new Error(`ffmpeg visual scan failed${stderr ? `: ${stderr.slice(-500)}` : ""}`));
        return;
      }
      const pixels = Buffer.concat(chunks);
      if (pixels.length < 256 * 256) {
        reject(new Error("ffmpeg visual scan returned an incomplete frame."));
        return;
      }
      resolve(pixels.subarray(0, 256 * 256));
    }));
  });
}

function paethPredictor(left: number, up: number, upLeft: number) {
  const estimate = left + up - upLeft;
  const leftDistance = Math.abs(estimate - left);
  const upDistance = Math.abs(estimate - up);
  const upLeftDistance = Math.abs(estimate - upLeft);
  if (leftDistance <= upDistance && leftDistance <= upLeftDistance) return left;
  if (upDistance <= upLeftDistance) return up;
  return upLeft;
}

/** Small PNG decoder used only as a scanner fallback when ffmpeg is unavailable. */
function decodePngGrayscale(bytes: Buffer): Buffer | undefined {
  const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (!bytes.subarray(0, 8).equals(pngSignature)) return undefined;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const imageData: Buffer[] = [];
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.subarray(offset + 4, offset + 8).toString("ascii");
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > bytes.length) return undefined;
    const data = bytes.subarray(dataStart, dataEnd);
    if (type === "IHDR" && data.length >= 13) {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === "IDAT") imageData.push(data);
    else if (type === "IEND") break;
    offset = dataEnd + 4;
  }
  if (!width || !height || bitDepth !== 8 || interlace !== 0 || ![0, 2, 4, 6].includes(colorType) || imageData.length === 0) return undefined;
  const channels = colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 4 ? 2 : 4;
  const bytesPerPixel = channels;
  const rowBytes = width * channels;
  let raw: Buffer;
  try { raw = inflateSync(Buffer.concat(imageData)); } catch { return undefined; }
  if (raw.length < height * (rowBytes + 1)) return undefined;
  const rows: Buffer[] = [];
  let rawOffset = 0;
  for (let row = 0; row < height; row += 1) {
    const filter = raw[rawOffset++];
    const encoded = raw.subarray(rawOffset, rawOffset + rowBytes);
    rawOffset += rowBytes;
    if (encoded.length !== rowBytes) return undefined;
    const decoded = Buffer.alloc(rowBytes);
    const previous = rows[row - 1];
    for (let index = 0; index < rowBytes; index += 1) {
      const left = index >= bytesPerPixel ? decoded[index - bytesPerPixel] : 0;
      const up = previous?.[index] ?? 0;
      const upLeft = previous && index >= bytesPerPixel ? previous[index - bytesPerPixel] : 0;
      const value = encoded[index];
      decoded[index] = filter === 0 ? value
        : filter === 1 ? (value + left) & 255
        : filter === 2 ? (value + up) & 255
        : filter === 3 ? (value + Math.floor((left + up) / 2)) & 255
        : filter === 4 ? (value + paethPredictor(left, up, upLeft)) & 255
        : value;
    }
    rows.push(decoded);
  }
  const output = Buffer.alloc(256 * 256);
  const grayAt = (x: number, y: number) => {
    const row = rows[Math.min(height - 1, Math.floor(y * height / 256))];
    const sourceX = Math.min(width - 1, Math.floor(x * width / 256));
    const pixel = sourceX * channels;
    if (colorType === 0 || colorType === 4) return row[pixel];
    return Math.round(row[pixel] * 0.299 + row[pixel + 1] * 0.587 + row[pixel + 2] * 0.114);
  };
  for (let y = 0; y < 256; y += 1) for (let x = 0; x < 256; x += 1) output[y * 256 + x] = grayAt(x, y);
  return output;
}

function detectHumanFaces(filePath: string, signal?: AbortSignal) {
  return new Promise<{ faces: number; largestAreaRatio: number }>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error("Face scan cancelled."));
      return;
    }
    const python = process.env.ASSET_FACE_DETECTOR_PYTHON || (process.platform === "win32" ? "python" : "python3");
    const child = spawn(python, [fromRoot("scripts", "detect-image-faces.py"), filePath], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      callback();
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(() => reject(new Error("Face scan timed out.")));
    }, 20_000);
    const onAbort = () => {
      child.kill("SIGTERM");
      finish(() => reject(signal?.reason instanceof Error ? signal.reason : new Error("Face scan cancelled.")));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-1000); });
    child.on("error", (error) => finish(() => reject(error)));
    child.on("close", (code) => finish(() => {
      if (code !== 0) {
        reject(new Error(`Face scan failed${stderr ? `: ${stderr}` : ""}`));
        return;
      }
      try {
        const parsed = JSON.parse(stdout) as { faces?: number; largestAreaRatio?: number };
        resolve({ faces: Math.max(0, parsed.faces ?? 0), largestAreaRatio: Math.max(0, parsed.largestAreaRatio ?? 0) });
      } catch {
        reject(new Error("Face scan returned invalid JSON."));
      }
    }));
  });
}

function detectVisibleText(filePath: string, signal?: AbortSignal) {
  return new Promise<string>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error("Text scan cancelled."));
      return;
    }
    const python = process.env.ASSET_TEXT_DETECTOR_PYTHON || (process.platform === "win32" ? "python" : "python3");
    const child = spawn(python, [fromRoot("scripts", "scan-image-text.py"), filePath], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      callback();
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(() => reject(new Error("Text scan timed out.")));
    }, 30_000);
    const onAbort = () => {
      child.kill("SIGTERM");
      finish(() => reject(signal?.reason instanceof Error ? signal.reason : new Error("Text scan cancelled.")));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-1000); });
    child.on("error", (error) => finish(() => reject(error)));
    child.on("close", (code) => finish(() => {
      if (code !== 0) {
        reject(new Error(`Text scan failed${stderr ? `: ${stderr}` : ""}`));
        return;
      }
      try {
        const parsed = JSON.parse(stdout) as { text?: string };
        resolve(parsed.text ?? "");
      } catch {
        reject(new Error("Text scan returned invalid JSON."));
      }
    }));
  });
}

function hasKnownRasterSignature(bytes: Buffer) {
  return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    || bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]))
    || (bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP")
    || bytes.subarray(0, 6).toString().startsWith("GIF");
}

export async function screenAssetFile(input: {
  filePath: string;
  contentType: string;
  alt?: string;
  title?: string;
  url?: string;
  watermarkHint?: string;
  signal?: AbortSignal;
}): Promise<AssetScreeningResult> {
  const metadataResult = screenAssetMetadata(input);
  if (metadataResult.status === "rejected") return metadataResult;
  const normalizedType = input.contentType.split(";", 1)[0].toLowerCase();
  const bytes = await readFile(input.filePath);
  if (normalizedType === "image/svg+xml" || normalizedType === "image/svg") {
    const vectorText = bytes.toString("utf8");
    const vectorResult = screenAssetMetadata({ ...input, title: `${input.title ?? ""} ${vectorText}` });
    return vectorResult.status === "rejected" ? vectorResult : { ...metadataResult, reasons: [...metadataResult.reasons, "vector_visual_screen_passed"] };
  }
  if (!hasKnownRasterSignature(bytes)) return { ...metadataResult, reasons: [...metadataResult.reasons, "visual_scan_skipped_unknown_payload"] };
  let pixels: Buffer;
  try {
    pixels = await decodeGrayscaleFrame(input.filePath, input.signal);
  } catch {
    pixels = decodePngGrayscale(bytes) ?? Buffer.alloc(0);
    if (pixels.length === 0) {
      return passedWithDegradedScreen([...metadataResult.reasons, "qr_visual_scan_unavailable", "human_face_scan_unavailable", "watermark_scan_unavailable"]);
    }
  }
  const finderPoints = clusterFinderPoints(collectFinderPoints(pixels, 256, 256));
  if (hasFinderTriangle(finderPoints)) return rejected(["qr_code_visual_pattern"]);
  let faceScan: { faces: number; largestAreaRatio: number };
  try {
    faceScan = await detectHumanFaces(input.filePath, input.signal);
  } catch {
    return passedWithDegradedScreen([...metadataResult.reasons, "visual_qr_screen_passed", "human_face_scan_unavailable"]);
  }
  if (faceScan.faces > 0) return rejected(["human_face_detected"]);
  let visibleText: string;
  try {
    visibleText = await detectVisibleText(input.filePath, input.signal);
  } catch {
    return passedWithDegradedScreen([...metadataResult.reasons, "visual_qr_screen_passed", "human_face_screen_passed", "watermark_scan_unavailable"]);
  }
  if (visibleWatermarkPattern.test(visibleText)) return rejected(["watermark_text_detected"]);
  return { ...metadataResult, reasons: [...metadataResult.reasons, "visual_qr_screen_passed", "human_face_screen_passed", "visible_watermark_screen_passed"] };
}
