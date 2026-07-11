import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import type { VideoProject, VideoScene } from "../pipeline/types";
import { fromRoot } from "../pipeline/utils";

export type QualityStage = "draft" | "audio" | "video";

export interface QualityIssue {
  severity: "warning" | "error";
  code: string;
  message: string;
}

export interface QualityEvaluation {
  stage: QualityStage;
  passed: boolean;
  issues: QualityIssue[];
  revisionNotes: string[];
  scores?: Record<string, number>;
  metrics: Record<string, number | string | boolean>;
}

function normalizeText(text: string) {
  return text.replace(/\s+/g, "").replace(/[：:，,。.!！?？_\-]/g, "").toLowerCase();
}

function sceneVisibleText(scene: VideoScene) {
  switch (scene.type) {
    case "title":
      return [scene.kicker, scene.headline, scene.subhead, ...scene.sources].join(" ");
    case "briefing_points":
      return [scene.headline, scene.title, scene.summary, ...scene.metrics.flatMap((item) => [item.label, item.value]), ...scene.points].join(" ");
    case "signal_chart":
      return [scene.headline, ...scene.bars.flatMap((item) => [item.label, item.detail])].join(" ");
    case "flow":
      return [scene.headline, ...scene.steps.flatMap((item) => [item.label, item.detail])].join(" ");
    case "outro":
      return [scene.headline, ...scene.bullets].join(" ");
  }
  return "";
}

function narrationLimits(scene: VideoScene) {
  if (scene.type === "title") return { min: 55, max: 150 };
  if (scene.type === "briefing_points") return { min: 90, max: 220 };
  if (scene.type === "outro") return { min: 65, max: 170 };
  return { min: 85, max: 210 };
}

function visibleTokenCoverage(visibleText: string, narration: string) {
  const visible = normalizeText(visibleText);
  const spoken = normalizeText(narration);
  const tokens = new Set<string>();
  for (const match of visible.matchAll(/[a-z][a-z0-9.-]+|\d+(?:\.\d+)?%?|[\u4e00-\u9fff]{2,}/gi)) {
    const token = match[0].toLowerCase();
    if (/^[\u4e00-\u9fff]+$/.test(token) && token.length > 3) {
      for (let index = 0; index < token.length - 1; index += 2) tokens.add(token.slice(index, index + 2));
    } else {
      tokens.add(token);
    }
  }
  if (tokens.size === 0) return 1;
  const matched = [...tokens].filter((token) => spoken.includes(token)).length;
  return matched / tokens.size;
}

function extraNarrationNumbers(visibleText: string, narration: string) {
  const visibleNumbers = new Set(visibleText.match(/\d+(?:\.\d+)?%?/g) ?? []);
  return [...new Set(narration.match(/\d+(?:\.\d+)?%?/g) ?? [])].filter((value) => !visibleNumbers.has(value));
}
function sceneShapeIssues(scene: VideoScene, index: number) {
  const issues: QualityIssue[] = [];
  if (scene.type === "briefing_points" && (scene.points.length < 3 || scene.metrics.length < 2)) {
    issues.push({ severity: "error", code: "briefing_thin", message: `第 ${index + 1} 屏事实卡信息不足。` });
  }
  if (scene.type === "signal_chart" && scene.bars.length < 3) {
    issues.push({ severity: "error", code: "chart_thin", message: `第 ${index + 1} 屏图表少于 3 个信号。` });
  }
  if (scene.type === "flow" && scene.steps.length < 3) {
    issues.push({ severity: "error", code: "flow_thin", message: `第 ${index + 1} 屏流程少于 3 步。` });
  }
  if (scene.type === "outro" && scene.bullets.length < 2) {
    issues.push({ severity: "error", code: "outro_thin", message: `第 ${index + 1} 屏结论少于 2 条。` });
  }
  return issues;
}

async function callQualityJudge(project: VideoProject, feedbackGuidance: string) {
  if (process.env.QUALITY_LLM_DISABLED === "1") return null;
  const apiKey =
    process.env.QUALITY_LLM_API_KEY ?? process.env.NEWS_LLM_API_KEY ?? process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  const baseUrl =
    process.env.QUALITY_LLM_BASE_URL ?? process.env.NEWS_LLM_BASE_URL ?? process.env.OPENAI_BASE_URL;
  const model = process.env.QUALITY_LLM_MODEL ?? process.env.NEWS_LLM_MODEL ?? process.env.OPENAI_MODEL;
  if (!baseUrl || !model) return null;

  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      temperature: 0.1,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: [
            "你是程序化新闻视频质量评审 agent。只返回 JSON。",
            "sourceArticle 是唯一事实依据，不得引入外部信息。",
            "分别对 sourceFidelity、titleHook、informationDensity、visualStructure、sceneAlignment、ttsReadability 打 0 到 100 分。",
            "返回字段：scores、issues、revisionNotes。issues 和 revisionNotes 都是字符串数组。",
            "标题应优先保留新闻原题核心卖点，免责声明或边界信息放副标题和正文。",
            "第一段旁白的第一句话必须逐字念完整新闻标题，标题是开场钩子，之后才能进入正文。",
            "逐屏检查旁白是否只复述或总结当前场景可见字段。当前屏没有展示的数据、案例、结论或背景不得出现在该段旁白。",
            "旁白必须与 5 个场景逐段对应，不得出现发布建议、作者站点或无关动画说明。",
          ].join("\n"),
        },
        {
          role: "user",
          content: JSON.stringify({
            sourceArticle: project.sources.map((source) => ({
              title: source.title,
              summary: source.summary,
              content: source.content,
            })),
            project: {
              title: project.meta.title,
              narration: project.narration,
              scenes: project.scenes,
              narrationSegments: project.narrationSegments,
            },
            recentUserFeedback: feedbackGuidance,
          }),
        },
      ],
    }),
  });
  if (!response.ok) throw new Error(`Quality judge failed: ${response.status} ${await response.text()}`);
  const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const content = data.choices?.[0]?.message?.content;
  if (!content) return null;
  return JSON.parse(content) as {
    scores?: Record<string, number>;
    issues?: string[];
    revisionNotes?: string[];
  };
}

export async function evaluateDraft(
  project: VideoProject,
  targetSeconds: number,
  feedbackGuidance: string,
): Promise<QualityEvaluation> {
  const issues: QualityIssue[] = [];
  const revisionNotes: string[] = [];
  const source = project.sources[0];
  const narrationChars = project.narration.replace(/\s+/g, "").length;
  const minimumChars = Math.round(targetSeconds * 6);
  const maximumChars = Math.round(targetSeconds * 11);

  if (project.scenes.length !== 5 || project.narrationSegments?.length !== project.scenes.length) {
    issues.push({ severity: "error", code: "scene_segment_mismatch", message: "必须是 5 个场景和 5 段对应旁白。" });
  }
  if (narrationChars < minimumChars) {
    issues.push({ severity: "error", code: "narration_short", message: `旁白仅 ${narrationChars} 字，目标至少 ${minimumChars} 字。` });
    revisionNotes.push(`将总旁白扩充到 ${minimumChars} 到 ${maximumChars} 字。`);
  }
  if (narrationChars > maximumChars) {
    issues.push({ severity: "warning", code: "narration_long", message: `旁白 ${narrationChars} 字，可能超过目标时长。` });
    revisionNotes.push(`将总旁白压缩到 ${maximumChars} 字以内。`);
  }
  const firstNarration = project.narrationSegments?.[0]?.text ?? "";
  if (!normalizeText(firstNarration).startsWith(normalizeText(project.meta.title))) {
    issues.push({ severity: "error", code: "title_not_spoken_first", message: "第一段旁白没有先完整播报新闻标题。" });
    revisionNotes.push("将新闻标题逐字放在第一段旁白的第一句话，念完标题后再进入正文。 ");
  }
  if (source && normalizeText(project.meta.title) !== normalizeText(source.title)) {
    issues.push({ severity: "error", code: "title_rewritten", message: "主标题没有保留新闻原题。" });
    revisionNotes.push("主标题直接使用新闻原题；分析结论放副标题或正文。 ");
  }
  const sourceText = `${source?.title ?? ""} ${source?.summary ?? ""} ${source?.content ?? ""}`;
  if (/正式发布|正式推出|即日起.{0,80}开放/.test(sourceText) && !/正式发布|正式推出|即日起.{0,80}开放/.test(project.narration)) {
    issues.push({ severity: "error", code: "release_status_weakened", message: "原文的正式发布或开放状态被弱化。" });
    revisionNotes.push("首段直接复述原文的正式发布状态、开放渠道和用户范围。 ");
  }
  const forbidden = /太乙真人|万人敬仰|新闻怎么跟进|发布角度|适合做视频|作者\s*[：:]|编辑\s*[：:]|量子位|腾讯新闻|新浪财经/;
  if (forbidden.test(project.narration)) {
    issues.push({ severity: "error", code: "forbidden_content", message: "旁白包含参考音频污染、站点署名或无关制作建议。" });
  }
  const alignmentScores: number[] = [];
  project.scenes.forEach((scene, index) => {
    issues.push(...sceneShapeIssues(scene, index));
    const segment = project.narrationSegments?.[index];
    if (!segment) return;
    const narrationLength = segment.text.replace(/\s+/g, "").length;
    const limits = narrationLimits(scene);
    if (narrationLength > limits.max) {
      issues.push({ severity: "error", code: "scene_narration_overloaded", message: `第 ${index + 1} 屏旁白 ${narrationLength} 字，超过当前画面建议上限 ${limits.max} 字。` });
      revisionNotes.push(`压缩第 ${index + 1} 屏旁白，只复述该屏可见字段，不要扩展屏幕外内容。`);
    } else if (narrationLength < limits.min) {
      issues.push({ severity: "warning", code: "scene_narration_thin", message: `第 ${index + 1} 屏旁白仅 ${narrationLength} 字。` });
    }
    const visibleText = `${project.meta.title} ${sceneVisibleText(scene)}`;
    const coverage = visibleTokenCoverage(visibleText, segment.text);
    alignmentScores.push(coverage);
    if (coverage < 0.25) {
      issues.push({ severity: "error", code: "scene_narration_mismatch", message: `第 ${index + 1} 屏旁白与画面字段重合度过低。` });
      revisionNotes.push(`重写第 ${index + 1} 屏旁白，按画面上的标题、卡片、数据或步骤逐项讲解。`);
    }
    const extraNumbers = extraNarrationNumbers(visibleText, segment.text);
    if (extraNumbers.length > 0) {
      issues.push({ severity: "error", code: "scene_extra_numbers", message: `第 ${index + 1} 屏旁白出现画面未展示的数字：${extraNumbers.join("、")}。` });
      revisionNotes.push(`将第 ${index + 1} 屏旁白中的数字同步到画面，或从旁白删除。`);
    }
  });

  let scores: Record<string, number> | undefined;
  try {
    const judged = await callQualityJudge(project, feedbackGuidance);
    if (judged?.scores) {
      scores = Object.fromEntries(
        Object.entries(judged.scores).map(([key, value]) => [key, Math.max(0, Math.min(100, Number(value) || 0))]),
      );
      for (const issue of judged.issues ?? []) {
        issues.push({ severity: "warning", code: "llm_judge", message: issue });
      }
      revisionNotes.push(...(judged.revisionNotes ?? []));
    }
  } catch (error) {
    issues.push({ severity: "warning", code: "judge_unavailable", message: (error as Error).message });
  }

  const scoreValues = scores ? Object.values(scores) : [];
  const scoreAverage = scoreValues.length
    ? scoreValues.reduce((sum, value) => sum + value, 0) / scoreValues.length
    : 100;
  const scoreMinimum = scoreValues.length ? Math.min(...scoreValues) : 100;
  const passed = !issues.some((issue) => issue.severity === "error");
  if (scores && (scoreAverage < 78 || scoreMinimum < 70)) {
    issues.push({
      severity: "warning",
      code: "llm_score_below_target",
      message: `LLM 质量评分未达建议值（平均 ${scoreAverage.toFixed(1)}，最低 ${scoreMinimum}），已保留改进建议。`,
    });
  }

  return {
    stage: "draft",
    passed,
    issues,
    revisionNotes: [...new Set(revisionNotes.filter(Boolean))],
    scores,
    metrics: {
      narrationChars,
      targetSeconds,
      scoreAverage: Number(scoreAverage.toFixed(1)),
      scoreMinimum,
      sceneCount: project.scenes.length,
      sceneAlignmentAverage: alignmentScores.length
        ? Number((alignmentScores.reduce((sum, value) => sum + value, 0) / alignmentScores.length).toFixed(3))
        : 0,
      sceneAlignmentMinimum: alignmentScores.length
        ? Number(Math.min(...alignmentScores).toFixed(3))
        : 0,
      feedbackItemsApplied: feedbackGuidance ? feedbackGuidance.split("\n").length : 0,
    },
  };
}

function canonicalSpeechText(text: string) {
  return text
    .toLowerCase()
    .replace(/[欧歐][盆盤][爱愛艾]/g, "openai")
    .replace(/(?:后|後)盆的ai/g, "openai")
    .replace(/open\s*ai/g, "openai")
    .replace(/靠的|扣的/g, "claude")
    .replace(/g\s*p\s*t\s*(?:五点六|5[.点]6)/g, "gpt56")
    .replace(/十六分之一/g, "16分之一")
    .replace(/[發发]/g, "发")
    .replace(/佈/g, "布")
    .replace(/價/g, "价")
    .replace(/僅/g, "仅")
    .replace(/為/g, "为")
    .replace(/\s+|[^a-z0-9\u4e00-\u9fff]/g, "");
}

function bigramRecall(expected: string, actual: string) {
  if (expected.length < 2) return actual.includes(expected) ? 1 : 0;
  const bigrams = Array.from({ length: expected.length - 1 }, (_, index) => expected.slice(index, index + 2));
  return bigrams.filter((token) => actual.includes(token)).length / bigrams.length;
}

async function transcribeOpening(project: VideoProject) {
  if (process.env.ASR_DISABLED === "1" || !project.audio?.src) return null;
  const audioPath = project.audio.src.startsWith("/generated/")
    ? fromRoot("public", ...project.audio.src.replace(/^\/+/, "").split("/"))
    : path.resolve(project.audio.src);
  const openingSeconds = Math.min(30, (project.narrationSegments?.[0]?.durationSeconds ?? 24) + 0.5);
  const workDir = await mkdtemp(path.join(tmpdir(), "scene-gen-asr-"));
  const openingPath = path.join(workDir, "opening.wav");
  const python = process.env.ASR_PYTHON ?? path.join(
    process.env.F5_TTS_VENV ?? "F:\\codex\\.venvs\\scene_gen_f5_py39",
    "Scripts",
    "python.exe",
  );
  try {
    await runCapture("ffmpeg", ["-y", "-i", audioPath, "-t", openingSeconds.toFixed(3), "-ar", "16000", "-ac", "1", openingPath]);
    const result = await runCapture(python, [
      fromRoot("scripts", "transcribe-audio.py"),
      "--audio", openingPath,
      "--model", process.env.ASR_MODEL ?? "openai/whisper-tiny",
      "--language", process.env.ASR_LANGUAGE ?? "chinese",
    ]);
    const lines = result.stdout.trim().split(/\r?\n/).filter(Boolean);
    const parsed = JSON.parse(lines[lines.length - 1] ?? "{}") as { text?: string };
    return parsed.text?.trim() ?? "";
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}
export async function evaluateAudio(project: VideoProject, targetSeconds: number): Promise<QualityEvaluation> {
  const issues: QualityIssue[] = [];
  const segments = project.narrationSegments ?? [];
  const duration = project.audio?.durationSeconds ?? 0;
  const minimumDuration = targetSeconds * Number(process.env.QUALITY_MIN_DURATION_FACTOR ?? 0.7);
  const maximumDuration = targetSeconds * Number(process.env.QUALITY_MAX_DURATION_FACTOR ?? 1.65);
  const narrationChars = project.narration.replace(/\s+/g, "").length;
  const charsPerSecond = duration > 0 ? narrationChars / duration : 0;
  const maximumCharsPerSecond = Number(process.env.QUALITY_MAX_CHARS_PER_SECOND ?? 11.5);
  if (!project.audio || project.audio.provider === "silent") {
    issues.push({ severity: "error", code: "audio_missing", message: "没有生成有效旁白音频。" });
  }
  if (duration < minimumDuration || duration > maximumDuration) {
    issues.push({ severity: "error", code: "duration_out_of_range", message: `音频 ${duration.toFixed(1)} 秒，建议范围 ${minimumDuration.toFixed(0)} 到 ${maximumDuration.toFixed(0)} 秒。` });
  }
  if (charsPerSecond > maximumCharsPerSecond) {
    issues.push({ severity: "error", code: "speech_too_fast", message: `旁白密度 ${charsPerSecond.toFixed(1)} 字/秒，超过自然播报上限 ${maximumCharsPerSecond} 字/秒。` });
  }
  let titleTranscript = "";
  let titleAudioCoverage = 0;
  try {
    const transcript = await transcribeOpening(project);
    if (transcript !== null) {
      titleTranscript = transcript;
      const expectedTitle = canonicalSpeechText(project.meta.title);
      const actualTitle = canonicalSpeechText(transcript);
      const hookSource = project.meta.title.split(/[：:]/)[0] ?? project.meta.title;
      const expectedHook = canonicalSpeechText(hookSource).slice(0, 24);
      titleAudioCoverage = bigramRecall(expectedTitle, actualTitle);
      if (!actualTitle.startsWith(expectedHook)) {
        issues.push({ severity: "error", code: "audio_title_opening_missing", message: `实际语音没有从标题开头播报。ASR：${transcript}` });
      }
      const minimumCoverage = Number(process.env.ASR_TITLE_COVERAGE_MIN ?? 0.58);
      if (titleAudioCoverage < minimumCoverage) {
        issues.push({ severity: "error", code: "audio_title_incomplete", message: `标题语音覆盖率 ${(titleAudioCoverage * 100).toFixed(1)}%，低于 ${(minimumCoverage * 100).toFixed(0)}%。` });
      }
    }
  } catch (error) {
    issues.push({ severity: "error", code: "asr_verification_failed", message: `无法验证实际语音标题：${(error as Error).message}` });
  }
  let cursor = 0;
  for (const [index, scene] of project.scenes.entries()) {
    const segment = segments[index];
    if (!segment || segment.audioStartSeconds === undefined || segment.durationSeconds === undefined) {
      issues.push({ severity: "error", code: "segment_timing_missing", message: `第 ${index + 1} 屏缺少音频时间信息。` });
      continue;
    }
    const frameTolerance = 1 / project.meta.fps + 0.002;
    if (Math.abs(cursor - segment.audioStartSeconds) > frameTolerance || Math.abs(scene.duration - segment.durationSeconds) > frameTolerance) {
      issues.push({ severity: "error", code: "audio_scene_drift", message: `第 ${index + 1} 屏音画边界不一致。` });
    }
    cursor += scene.duration;
  }
  return {
    stage: "audio",
    passed: !issues.some((issue) => issue.severity === "error"),
    issues,
    revisionNotes: issues.some((issue) => issue.code === "duration_out_of_range")
      ? [duration < minimumDuration ? "允许视频自然缩短，不要用无关内容填充；必要时补充当前画面已展示的信息。" : "压缩旁白字数或允许视频自然延长，不要继续加快语速。"]
      : [],
    metrics: {
      targetSeconds,
      audioDuration: duration,
      sceneDuration: cursor,
      alignmentDelta: Math.abs(cursor - duration),
      charsPerSecond: Number(charsPerSecond.toFixed(2)),
      minimumDuration,
      maximumDuration,
      titleTranscript,
      titleAudioCoverage: Number(titleAudioCoverage.toFixed(3)),
    },
  };
}

function runCapture(command: string, args: string[]) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve({ stdout, stderr }) : reject(new Error(stderr))));
  });
}

export async function evaluateVideo(
  videoPath: string,
  reportDir: string,
  expectedDuration?: number,
): Promise<QualityEvaluation> {
  const issues: QualityIssue[] = [];
  const probe = await runCapture("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration,size",
    "-show_entries",
    "stream=codec_type,duration,width,height",
    "-of",
    "json",
    videoPath,
  ]);
  const data = JSON.parse(probe.stdout) as {
    format?: { duration?: string; size?: string };
    streams?: Array<{ codec_type?: string; duration?: string; width?: number; height?: number }>;
  };
  const video = data.streams?.find((stream) => stream.codec_type === "video");
  const audio = data.streams?.find((stream) => stream.codec_type === "audio");
  const duration = Number(data.format?.duration ?? 0);
  if (!video || !audio) issues.push({ severity: "error", code: "stream_missing", message: "成片缺少视频流或音频流。" });
  if (video?.width !== 1080 || video?.height !== 1920) {
    issues.push({ severity: "error", code: "wrong_dimensions", message: `成片尺寸不是 1080x1920。` });
  }
  if (expectedDuration && Math.abs(duration - expectedDuration) > 0.25) {
    issues.push({
      severity: "error",
      code: "video_project_duration_drift",
      message: `视频 ${duration.toFixed(3)} 秒，与项目音频 ${expectedDuration.toFixed(3)} 秒不一致。`,
    });
  }
  const streamDelta = Math.abs(Number(video?.duration ?? duration) - Number(audio?.duration ?? duration));
  if (streamDelta > 0.2) issues.push({ severity: "error", code: "stream_duration_drift", message: `音视频流相差 ${streamDelta.toFixed(3)} 秒。` });

  await mkdir(reportDir, { recursive: true });
  const sampleTimes = [Math.min(4, duration / 4), duration / 2, Math.max(1, duration - 5)];
  const frameSizes: number[] = [];
  for (const [index, sampleTime] of sampleTimes.entries()) {
    const framePath = path.join(reportDir, `frame-${index + 1}.jpg`);
    await runCapture("ffmpeg", [
      "-y",
      "-ss",
      sampleTime.toFixed(3),
      "-i",
      videoPath,
      "-frames:v",
      "1",
      "-q:v",
      "2",
      framePath,
    ]);
    const size = await stat(framePath).then((value) => value.size).catch(() => 0);
    frameSizes.push(size);
    if (size < 20_000) issues.push({ severity: "error", code: "blank_frame", message: `抽帧 ${index + 1} 可能为空白。` });
  }

  return {
    stage: "video",
    passed: !issues.some((issue) => issue.severity === "error"),
    issues,
    revisionNotes: [],
    metrics: {
      duration,
      fileSize: Number(data.format?.size ?? 0),
      width: video?.width ?? 0,
      height: video?.height ?? 0,
      streamDelta,
      expectedDuration: expectedDuration ?? 0,
      projectDurationDelta: expectedDuration ? Math.abs(duration - expectedDuration) : 0,
      minimumFrameSize: Math.min(...frameSizes),
    },
  };
}
