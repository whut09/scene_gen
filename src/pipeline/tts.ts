import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { VideoProject } from "./types";
import { ensureDir, fromRoot } from "./utils";
import { fetchWithRetry } from "./external-operation";

const DEFAULT_F5_REF_TEXT = "对，这就是我，万人敬仰的太乙真人。";
const BAD_REF_TEXT = /太乙真人|万人敬仰|这就是我/;
const MOJIBAKE_MARKERS = /銆|锛|锟|杩|绔|鐨|妯|浠|浜|鍦|鏄|姣|鍙|浼|棰|勭/g;

type TtsProvider = "openai" | "f5" | "local";

function run(command: string, args: string[], options?: { input?: string; env?: NodeJS.ProcessEnv }) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: options?.input ? ["pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: { ...process.env, ...options?.env },
    });
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      code === 0 ? resolve() : reject(new Error(`${command} exited ${code}: ${stderr}`));
    });
    if (options?.input) {
      child.stdin?.write(options.input);
      child.stdin?.end();
    }
  });
}

async function probeDuration(filePath: string) {
  try {
    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn(
        "ffprobe",
        ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", filePath],
        { windowsHide: true },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });
      child.on("close", (code) => {
        code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr));
      });
    });
    return Number(output) || 0;
  } catch {
    return 0;
  }
}

async function openAiTts(text: string, outputPath: string) {
  const apiKey = process.env.OPENAI_TTS_API_KEY ?? process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_TTS_API_KEY or OPENAI_API_KEY is not set");
  const baseUrl = process.env.OPENAI_TTS_BASE_URL ?? process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";
  const response = await fetchWithRetry(`${baseUrl.replace(/\/$/, "")}/audio/speech`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: process.env.OPENAI_TTS_MODEL ?? "gpt-4o-mini-tts",
      voice: process.env.OPENAI_TTS_VOICE ?? "alloy",
      input: text,
      format: "mp3",
      speed: Number(process.env.OPENAI_TTS_SPEED ?? 1.12),
    }),
  }, { label: "openai-tts", timeoutMs: Number(process.env.TTS_FETCH_TIMEOUT_MS ?? 180_000) });
  if (!response.ok) throw new Error(`OpenAI TTS failed: ${response.status} ${await response.text()}`);
  await writeFile(outputPath, Buffer.from(await response.arrayBuffer()));
}

async function windowsTts(text: string, outputPath: string) {
  const textPath = path.join(path.dirname(outputPath), "narration.txt");
  const scriptPath = path.join(path.dirname(outputPath), "local-tts.ps1");
  await writeFile(textPath, text, "utf8");
  const script = `
Add-Type -AssemblyName System.Speech
$text = Get-Content -LiteralPath "${textPath.replace(/"/g, '`"')}" -Raw -Encoding UTF8
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$synth.Rate = 3
$synth.Volume = 95
$synth.SetOutputToWaveFile("${outputPath.replace(/"/g, '`"')}")
$synth.Speak($text)
$synth.SetOutputToNull()
$synth.Dispose()
`;
  await writeFile(scriptPath, script, "utf8");
  await run("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath]);
}

function resolveF5Python() {
  const venv = process.env.F5_TTS_VENV ?? "F:\\codex\\.venvs\\scene_gen_f5_py39";
  const python = path.join(venv, "Scripts", "python.exe");
  return process.env.F5_TTS_PYTHON ?? python;
}

function resolveF5RefAudio() {
  return (
    process.env.F5_TTS_REF_AUDIO ??
    path.join(
      process.env.F5_TTS_VENV ?? "F:\\codex\\.venvs\\scene_gen_f5_py39",
      "Lib",
      "site-packages",
      "f5_tts",
      "infer",
      "examples",
      "basic",
      "basic_ref_zh.wav",
    )
  );
}

function normalizeFilePath(filePath: string) {
  return path.normalize(filePath).toLowerCase();
}

function isDefaultF5RefAudio(refAudio: string) {
  return normalizeFilePath(refAudio).endsWith(path.normalize("infer/examples/basic/basic_ref_zh.wav").toLowerCase());
}

async function resolveF5RefText(refAudio: string) {
  if (Object.hasOwn(process.env, "F5_TTS_REF_TEXT")) {
    return process.env.F5_TTS_REF_TEXT ?? "";
  }

  const textPath = refAudio.replace(/\.[^.]+$/, ".txt");
  if (existsSync(textPath)) return (await readFile(textPath, "utf8")).trim();
  return isDefaultF5RefAudio(refAudio) ? DEFAULT_F5_REF_TEXT : "";
}

function assertCleanTtsText(text: string, refAudio: string, refText: string) {
  if (BAD_REF_TEXT.test(text)) {
    throw new Error("TTS input contains the default F5 reference sentence; refusing to synthesize.");
  }
  const mojibakeHits = text.match(MOJIBAKE_MARKERS)?.length ?? 0;
  if (mojibakeHits >= 8) {
    throw new Error("TTS input looks like mojibake/corrupted Chinese; refusing to synthesize.");
  }
  if (!isDefaultF5RefAudio(refAudio) && BAD_REF_TEXT.test(refText)) {
    throw new Error("Custom F5 reference audio is paired with the default reference text; refusing to synthesize.");
  }
}

const CHINESE_DIGITS: Record<string, string> = {
  "0": "零", "1": "一", "2": "二", "3": "三", "4": "四",
  "5": "五", "6": "六", "7": "七", "8": "八", "9": "九",
};

function pronounceDigits(value: string) {
  return [...value].map((digit) => CHINESE_DIGITS[digit] ?? digit).join("");
}

function chineseSection(value: number) {
  const units = ["千", "百", "十", ""];
  const divisors = [1000, 100, 10, 1];
  let result = "";
  let pendingZero = false;
  for (let index = 0; index < divisors.length; index += 1) {
    const divisor = divisors[index];
    const digit = Math.floor(value / divisor) % 10;
    const remainder = value % divisor;
    if (digit === 0) {
      if (result && remainder > 0) pendingZero = true;
      continue;
    }
    if (pendingZero) result += "零";
    const omitLeadingOne = digit === 1 && divisor === 10 && !result;
    result += `${omitLeadingOne ? "" : CHINESE_DIGITS[String(digit)]}${units[index]}`;
    pendingZero = false;
  }
  return result || "零";
}

function integerToChinese(value: string): string {
  const normalized = value.replace(/^0+(?=\d)/, "");
  const numeric = Number(normalized);
  if (!Number.isSafeInteger(numeric) || numeric < 0) return pronounceDigits(normalized);
  if (numeric < 10000) return chineseSection(numeric);
  if (numeric < 100000000) {
    const high = Math.floor(numeric / 10000);
    const low = numeric % 10000;
    return `${integerToChinese(String(high))}万${low ? `${low < 1000 ? "零" : ""}${chineseSection(low)}` : ""}`;
  }
  if (numeric < 1000000000000) {
    const high = Math.floor(numeric / 100000000);
    const low = numeric % 100000000;
    return `${integerToChinese(String(high))}亿${low ? `${low < 10000000 ? "零" : ""}${integerToChinese(String(low))}` : ""}`;
  }
  return pronounceDigits(normalized);
}

function numberToChinese(value: string) {
  const [whole, fraction] = value.split(".");
  const spokenWhole = integerToChinese(whole || "0");
  return fraction ? `${spokenWhole}点${pronounceDigits(fraction)}` : spokenWhole;
}

export function prepareF5SynthesisText(text: string) {
  const trimmed = text.trim();
  const startsWithLatin = /^[A-Za-z0-9]/.test(trimmed);
  const pronounceable = trimmed
    .replace(/重置/g, "重新设置")
    .replace(/豆包和千问/g, "豆包，和千问，")
    .replace(/MoneyPrinterTurbo/gi, "Money Printer Turbo")
    .replace(/awesome-llm-apps/gi, "这个项目")
    .replace(/\bRAG\b/gi, "检索增强生成")
    .replace(/\bAI\b/g, "人工智能")
    .replace(/K2[.]7 Code HighSpeed/gi, "K二点七代码高速版")
    .replace(/K2[.]7 Code/gi, "K二点七代码")
    .replace(/Kimi Code CLI/gi, "Kimi代码命令行工具")
    .replace(/Kimi Code/gi, "Kimi代码")
    .replace(/Coding Plan/gi, "编程套餐")
    .replace(/Allegretto/gi, "阿莱格雷托")
    .replace(/GitNexus/gi, "吉特奈克瑟斯")
    .replace(/AI[ -]?Berkshire/gi, "AI 伯克希尔")
    .replace(/OmniRoute/gi, "奥姆尼路由")
    .replace(/Superpowers/gi, "超级能力")
    .replace(/next-ai-draw-io/gi, "奈克斯特，人工智能绘图工具，")
    .replace(/Next[.]js/gi, "Next JS")
    .replace(/draw[.]io/gi, "Draw IO")
    .replace(/ChatGPT/gi, "聊天 GPT，")
    .replace(/Codex/gi, "Codex，")
    .replace(/OpenAI/gi, "欧盆艾，")
    .replace(/Prompt/gi, "提示词")
    .replace(/Agent/gi, "智能体")
    .replace(/(?<=\d),(?=\d{3}(?:\D|$))/g, "")
    .replace(/(\d+(?:[.]\d+)?)\s*%/g, (_, value: string) => `百分之${numberToChinese(value)}`)
    .replace(/(\d+)\+(?=\D|$)/g, (_, value: string) => `${numberToChinese(value)}以上`)
    .replace(/(?<!\d)(\d{4})(?=年)/g, (_, value: string) => pronounceDigits(value))
    .replace(/\d+(?:[.]\d+)?/g, (value) => numberToChinese(value));
  if (/\d/.test(pronounceable)) {
    throw new Error(`TTS number normalization left Arabic digits: ${pronounceable.match(/\d+/g)?.join(", ")}`);
  }
  return /^[。！？!?]/.test(pronounceable) ? pronounceable : `。${pronounceable}`;
}
async function f5Tts(text: string, outputPath: string, speedOverride?: string) {
  const python = resolveF5Python();
  const refAudio = resolveF5RefAudio();
  const refText = await resolveF5RefText(refAudio);
  const model = process.env.F5_TTS_MODEL ?? "F5TTS_v1_Base";
  const speed = speedOverride ?? process.env.F5_TTS_SPEED ?? "1.12";
  const nfeStep = process.env.F5_TTS_NFE_STEP ?? "16";
  const device = process.env.F5_TTS_DEVICE ?? "cuda";
  const outputDir = path.dirname(outputPath);
  const outputFile = path.basename(outputPath);
  const textPath = path.join(outputDir, `${path.basename(outputPath, path.extname(outputPath))}.txt`);

  const synthesisText = prepareF5SynthesisText(text);
  assertCleanTtsText(synthesisText, refAudio, refText);
  await writeFile(textPath, synthesisText, "utf8");
  await writeFile(`${textPath}.ref.txt`, refText, "utf8");
  await run(python, [
    "-m",
    "f5_tts.infer.infer_cli",
    "--model",
    model,
    "--ref_audio",
    refAudio,
    "--ref_text",
    refText,
    "--gen_file",
    textPath,
    "--output_dir",
    outputDir,
    "--output_file",
    outputFile,
    "--speed",
    speed,
    "--nfe_step",
    nfeStep,
    "--device",
    device,
  ], {
    env: {
      HF_HUB_OFFLINE: process.env.F5_TTS_HF_OFFLINE ?? "1",
      TRANSFORMERS_OFFLINE: process.env.F5_TTS_HF_OFFLINE ?? "1",
    },
  });
}

function resolveTtsProvider(): TtsProvider {
  const provider = process.env.TTS_PROVIDER ?? (process.env.OPENAI_API_KEY ? "openai" : "local");
  return provider === "openai" || provider === "f5" ? provider : "local";
}

function providerExtension(provider: TtsProvider) {
  return provider === "openai" ? "mp3" : "wav";
}

async function synthesizeNarration(
  provider: TtsProvider,
  text: string,
  outputPath: string,
  options?: { f5Speed?: string },
) {
  if (provider === "openai") {
    await openAiTts(text, outputPath);
  } else if (provider === "f5") {
    await f5Tts(text, outputPath, options?.f5Speed);
  } else {
    await windowsTts(text, outputPath);
  }
}

async function concatNarrationSegments(
  inputs: string[],
  durations: number[],
  gaps: number[],
  outputPath: string,
) {
  const args = ["-y"];
  for (const input of inputs) args.push("-i", input);
  const filters = inputs.map((_, index) => {
    const total = durations[index] + gaps[index];
    return `[${index}:a]aresample=24000,aformat=sample_fmts=s16:channel_layouts=mono,apad=pad_dur=${gaps[index].toFixed(3)},atrim=duration=${total.toFixed(3)}[a${index}]`;
  });
  filters.push(`${inputs.map((_, index) => `[a${index}]`).join("")}concat=n=${inputs.length}:v=0:a=1[out]`);
  args.push(
    "-filter_complex",
    filters.join(";"),
    "-map",
    "[out]",
    "-ar",
    "24000",
    "-ac",
    "1",
    "-c:a",
    "pcm_s16le",
    outputPath,
  );
  await run("ffmpeg", args);
}

async function fitNarrationSegmentsToTarget(
  segmentPaths: string[],
  durations: number[],
  targetSeconds: number,
  totalGapSeconds: number,
) {
  const durationPolicy = (process.env.TTS_DURATION_POLICY ?? "natural").trim().toLowerCase();
  if (
    durationPolicy !== "fit" ||
    process.env.TTS_FIT_TARGET === "0" ||
    !Number.isFinite(targetSeconds) ||
    targetSeconds <= totalGapSeconds + 5
  ) {
    return { paths: segmentPaths, durations };
  }
  const speechDuration = durations.reduce((sum, duration) => sum + duration, 0);
  const targetSpeechDuration = targetSeconds - totalGapSeconds;
  const desiredTempo = speechDuration / targetSpeechDuration;
  const minimumTempo = Number(process.env.TTS_MIN_TEMPO ?? 0.9);
  const maximumTempo = Number(process.env.TTS_MAX_TEMPO ?? 1.22);
  const tempo = Math.max(minimumTempo, Math.min(maximumTempo, desiredTempo));
  if (Math.abs(tempo - 1) < 0.03) return { paths: segmentPaths, durations };

  const fittedPaths: string[] = [];
  const fittedDurations: number[] = [];
  for (const [index, inputPath] of segmentPaths.entries()) {
    const fittedPath = inputPath.replace(/\.[^.]+$/, `-fitted-${tempo.toFixed(2)}x.wav`);
    await run("ffmpeg", [
      "-y", "-i", inputPath,
      "-filter:a", `atempo=${tempo.toFixed(6)}`,
      "-ar", "24000", "-ac", "1", "-c:a", "pcm_s16le", fittedPath,
    ]);
    const fittedDuration = await probeDuration(fittedPath);
    if (fittedDuration <= 0) throw new Error(`Fitted narration segment ${index + 1} is invalid.`);
    fittedPaths.push(fittedPath);
    fittedDurations.push(fittedDuration);
  }
  return { paths: fittedPaths, durations: fittedDurations };
}
async function canReuseNarrationSegment(provider: TtsProvider, text: string, segmentPath: string, expectedSpeed?: string) {
  if (process.env.TTS_FORCE_REBUILD === "1" || provider !== "f5" || !existsSync(segmentPath)) return false;
  const textPath = path.join(
    path.dirname(segmentPath),
    `${path.basename(segmentPath, path.extname(segmentPath))}.txt`,
  );
  const refTextPath = `${textPath}.ref.txt`;
  if (!existsSync(textPath) || !existsSync(refTextPath)) return false;
  if (expectedSpeed) {
    const speedPath = `${segmentPath}.speed.txt`;
    if (!existsSync(speedPath) || (await readFile(speedPath, "utf8")).trim() !== expectedSpeed) return false;
  }
  const currentRefText = await resolveF5RefText(resolveF5RefAudio());
  const [existingText, existingRefText] = await Promise.all([
    readFile(textPath, "utf8"),
    readFile(refTextPath, "utf8"),
  ]);
  return existingText.trim() === prepareF5SynthesisText(text).trim() && existingRefText.trim() === currentRefText.trim();
}
function splitTitleNarration(title: string, narration: string) {
  const trimmedTitle = title.trim().replace(/[。！？!?]+$/, "");
  const trimmedNarration = narration.trim();
  if (trimmedNarration.startsWith(trimmedTitle)) {
    const body = trimmedNarration.slice(trimmedTitle.length).replace(/^[。！？!?，,：:\s]+/, "").trim();
    return { titleText: trimmedTitle, bodyText: body };
  }
  const boundary = trimmedNarration.search(/[。！？!?]/);
  if (boundary >= 0) {
    return {
      titleText: trimmedNarration.slice(0, boundary).trim(),
      bodyText: trimmedNarration.slice(boundary + 1).trim(),
    };
  }
  return { titleText: trimmedNarration, bodyText: "" };
}

async function synthesizeF5TitleScene(
  project: VideoProject,
  narration: string,
  segmentPath: string,
) {
  const { titleText, bodyText } = splitTitleNarration(project.meta.title, narration);
  const extension = path.extname(segmentPath);
  const stem = segmentPath.slice(0, -extension.length);
  const partTexts = [titleText, bodyText].filter(Boolean);
  const partPaths = partTexts.map((_, index) => `${stem}-${index === 0 ? "title" : "body"}${extension}`);
  const partDurations: number[] = [];
  for (const [index, partText] of partTexts.entries()) {
    const partPath = partPaths[index];
    const uniformSpeed = process.env.F5_TTS_UNIFORM_SPEED ?? "1.25";
    const synthesisText = index === 0 ? `。。。${partText}` : partText;
    const speedMetaPath = `${partPath}.speed.txt`;
    if (!(await canReuseNarrationSegment("f5", synthesisText, partPath, uniformSpeed))) {
      await synthesizeNarration("f5", synthesisText, partPath, { f5Speed: uniformSpeed });
      await writeFile(speedMetaPath, uniformSpeed, "utf8");
    }
    const duration = await probeDuration(partPath);
    if (duration <= 0) throw new Error(`Title narration part ${index + 1} is invalid.`);
    partDurations.push(duration);
  }
  const gaps = partTexts.map((_, index) => (index === 0 && partTexts.length > 1 ? 0.32 : 0));
  await concatNarrationSegments(partPaths, partDurations, gaps, segmentPath);
}
async function attachSegmentedNarration(
  project: VideoProject,
  basename: string,
  provider: TtsProvider,
  generatedDir: string,
) {
  const segments = [...(project.narrationSegments ?? [])].sort((a, b) => a.sceneIndex - b.sceneIndex);
  const uniformF5Speed = process.env.F5_TTS_UNIFORM_SPEED ?? "1.25";
  if (segments.length !== project.scenes.length) {
    throw new Error(`Narration segment count ${segments.length} does not match scene count ${project.scenes.length}.`);
  }

  const extension = providerExtension(provider);
  const segmentPaths: string[] = [];
  const durations: number[] = [];
  for (const [index, segment] of segments.entries()) {
    if (segment.sceneIndex !== index || !segment.text.trim()) {
      throw new Error(`Invalid narration segment at scene ${index}.`);
    }
    const segmentPath = path.join(
      generatedDir,
      `${basename}-scene-${String(index + 1).padStart(2, "0")}.${extension}`,
    );
    if (provider === "f5" && index === 0) {
      await synthesizeF5TitleScene(project, segment.text, segmentPath);
    } else if (!(await canReuseNarrationSegment(provider, segment.text, segmentPath, provider === "f5" ? uniformF5Speed : undefined))) {
      await synthesizeNarration(provider, segment.text, segmentPath, { f5Speed: provider === "f5" ? uniformF5Speed : undefined });
      if (provider === "f5") await writeFile(`${segmentPath}.speed.txt`, uniformF5Speed, "utf8");
    }
    const duration = await probeDuration(segmentPath);
    if (duration <= 0) throw new Error(`Narration segment ${index + 1} is empty or invalid.`);
    segmentPaths.push(segmentPath);
    durations.push(duration);
  }

  const gaps = durations.map((_, index) => (index === durations.length - 1 ? 0.8 : 0.28));
  const totalGapSeconds = gaps.reduce((sum, gap) => sum + gap, 0);
  const fitted = await fitNarrationSegmentsToTarget(segmentPaths, durations, project.meta.durationSeconds, totalGapSeconds);
  const playbackPaths = fitted.paths;
  const playbackDurations = fitted.durations;
  const outputPath = path.join(generatedDir, `${basename}.wav`);
  await concatNarrationSegments(playbackPaths, playbackDurations, gaps, outputPath);

  let audioStartSeconds = 0;
  const alignedSegments = segments.map((segment, index) => {
    const durationSeconds = playbackDurations[index] + gaps[index];
    const aligned = {
      ...segment,
      audioStartSeconds,
      durationSeconds,
    };
    audioStartSeconds += durationSeconds;
    return aligned;
  });
  const combinedDuration = await probeDuration(outputPath);
  if (combinedDuration <= 0) throw new Error("Combined narration audio is empty or invalid.");
  const durationDelta = combinedDuration - audioStartSeconds;
  if (alignedSegments.length > 0 && Math.abs(durationDelta) > 0.001) {
    const last = alignedSegments[alignedSegments.length - 1];
    last.durationSeconds = Math.max(0.1, (last.durationSeconds ?? 0) + durationDelta);
  }
  const scenes = project.scenes.map((scene, index) => ({
    ...scene,
    duration: alignedSegments[index].durationSeconds ?? scene.duration,
  }));

  return {
    ...project,
    meta: {
      ...project.meta,
      durationSeconds: combinedDuration,
    },
    narration: alignedSegments.map((segment) => segment.text).join("\n"),
    narrationSegments: alignedSegments,
    scenes,
    audio: {
      src: `/generated/${basename}.wav`,
      durationSeconds: combinedDuration,
      provider,
    },
  } satisfies VideoProject;
}

async function silentAudio(outputPath: string, duration: number) {
  await run("ffmpeg", [
    "-y",
    "-f",
    "lavfi",
    "-i",
    "anullsrc=channel_layout=stereo:sample_rate=44100",
    "-t",
    String(duration),
    "-q:a",
    "9",
    "-acodec",
    "libmp3lame",
    outputPath,
  ]);
}

export async function attachNarrationAudio(project: VideoProject, basename = "narration") {
  const generatedDir = fromRoot("public", "generated");
  await ensureDir(generatedDir);
  const provider = resolveTtsProvider();

  try {
    if (project.narrationSegments?.length) {
      return await attachSegmentedNarration(project, basename, provider, generatedDir);
    }

    const extension = providerExtension(provider);
    const outputPath = path.join(generatedDir, `${basename}.${extension}`);
    await synthesizeNarration(provider, project.narration, outputPath);
    const fileSize = await stat(outputPath).then((file) => file.size).catch(() => 0);
    const duration = await probeDuration(outputPath);
    if (fileSize === 0 || duration <= 0) throw new Error("TTS output is empty or invalid");
    return {
      ...project,
      audio: {
        src: `/generated/${basename}.${extension}`,
        durationSeconds: duration,
        provider,
      },
    } satisfies VideoProject;
  } catch (error) {
    console.warn(`[tts] primary provider failed: ${(error as Error).message}`);
    if (provider === "f5" || process.env.TTS_FAIL_FAST === "1") throw error;

    if (provider !== "local") {
      const fallbackLocalPath = path.join(generatedDir, `${basename}.wav`);
      try {
        await windowsTts(project.narration, fallbackLocalPath);
        const fileSize = await stat(fallbackLocalPath).then((file) => file.size).catch(() => 0);
        const duration = await probeDuration(fallbackLocalPath);
        if (fileSize > 0 && duration > 0) {
          return {
            ...project,
            audio: {
              src: `/generated/${basename}.wav`,
              durationSeconds: duration,
              provider: "local",
            },
          } satisfies VideoProject;
        }
      } catch (fallbackError) {
        console.warn(`[tts] local fallback failed: ${(fallbackError as Error).message}`);
      }
    }

    console.warn("[tts] generating silent track");
    const fallbackPath = path.join(generatedDir, `${basename}.mp3`);
    await silentAudio(fallbackPath, project.meta.durationSeconds);
    const duration = await probeDuration(fallbackPath);
    return {
      ...project,
      audio: {
        src: `/generated/${basename}.mp3`,
        durationSeconds: duration || project.meta.durationSeconds,
        provider: "silent",
      },
    } satisfies VideoProject;
  }
}
