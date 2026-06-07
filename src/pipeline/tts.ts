import { spawn } from "node:child_process";
import { stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { VideoProject } from "./types";
import { ensureDir, fromRoot } from "./utils";

function run(command: string, args: string[], options?: { input?: string }) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: options?.input ? ["pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"],
      windowsHide: true,
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
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/audio/speech`, {
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
  });
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
  const provider = process.env.TTS_PROVIDER ?? (process.env.OPENAI_API_KEY ? "openai" : "local");
  const ext = provider === "local" ? "wav" : "mp3";
  const outputPath = path.join(generatedDir, `${basename}.${ext}`);
  const publicSrc = `/generated/${basename}.${ext}`;

  try {
    if (provider === "openai") {
      await openAiTts(project.narration, outputPath);
    } else {
      await windowsTts(project.narration, outputPath);
    }
    const fileSize = await stat(outputPath).then((file) => file.size).catch(() => 0);
    const duration = await probeDuration(outputPath);
    if (fileSize === 0 || duration <= 0) throw new Error("TTS output is empty or invalid");
    return {
      ...project,
      audio: {
        src: publicSrc,
        durationSeconds: duration || project.meta.durationSeconds,
        provider: provider === "openai" ? "openai" : "local",
      },
    } satisfies VideoProject;
  } catch (error) {
    console.warn(`[tts] primary provider failed: ${(error as Error).message}`);
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
              durationSeconds: duration || project.meta.durationSeconds,
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
