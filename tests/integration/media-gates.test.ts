import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { evaluateAudio, evaluateVideo } from "../../src/harness/quality";
import { createFixtureProject } from "../fixtures/project";

const execFileAsync = promisify(execFile);

test("FFmpeg fixtures pass audio and video structural gates without GPU", { timeout: 120_000 }, async () => {
  const workDir = await mkdtemp(path.join(tmpdir(), "scene-gen-media-gates-"));
  const audioPath = path.join(workDir, "fixture.wav");
  const videoPath = path.join(workDir, "fixture.mp4");
  const reportDir = path.join(workDir, "report");
  const previousAsr = process.env.ASR_DISABLED;
  process.env.ASR_DISABLED = "1";
  try {
    await execFileAsync("ffmpeg", ["-y", "-f", "lavfi", "-i", "sine=frequency=880:duration=2", "-ar", "48000", "-ac", "1", audioPath], { windowsHide: true });
    await execFileAsync("ffmpeg", [
      "-y",
      "-f", "lavfi", "-i", "testsrc2=size=1080x1920:rate=30:duration=2",
      "-f", "lavfi", "-i", "sine=frequency=880:duration=2",
      "-shortest", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "96k", videoPath,
    ], { windowsHide: true, maxBuffer: 10 * 1024 * 1024 });

    const narration = "离线测试验证音频视频质量门禁稳定通过";
    const project = createFixtureProject({
      meta: { ...createFixtureProject().meta, durationSeconds: 2 },
      narration,
      narrationSegments: [{ sceneIndex: 0, text: narration, audioStartSeconds: 0, durationSeconds: 2 }],
      scenes: [{ type: "title", duration: 2, kicker: "测试", headline: "离线媒体门禁", subhead: "两秒固定媒体", sources: ["FFmpeg"] }],
      audio: { src: audioPath, durationSeconds: 2, provider: "local" },
    });
    const audio = await evaluateAudio(project, 2);
    const video = await evaluateVideo(videoPath, reportDir, 2, [2]);
    assert.equal(audio.issues.some((issue) => issue.severity === "error"), false, JSON.stringify(audio.issues));
    assert.equal(video.issues.some((issue) => issue.severity === "error"), false, JSON.stringify(video.issues));
    assert.equal(video.metrics.width, 1080);
    assert.equal(video.metrics.height, 1920);
  } finally {
    if (previousAsr === undefined) delete process.env.ASR_DISABLED; else process.env.ASR_DISABLED = previousAsr;
    await rm(workDir, { recursive: true, force: true });
  }
});
