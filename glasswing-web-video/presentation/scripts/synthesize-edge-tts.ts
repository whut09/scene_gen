import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { NEWS_STORY } from "../src/chapters/url-news/story-data";

const chapters = NEWS_STORY.chapters.map((chapter) => [
  chapter.id,
  chapter.steps.map((step) => step.narration),
] as const);

const voice = process.env.EDGE_TTS_VOICE ?? "zh-CN-YunyangNeural";
const rate = process.env.EDGE_TTS_RATE ?? "+18%";
const pitch = process.env.EDGE_TTS_PITCH ?? "+0Hz";

function run(command: string, args: string[]) {
  return new Promise<void>((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: "inherit", shell: false });
    child.on("exit", (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${command} exited with ${code}`));
    });
    child.on("error", reject);
  });
}

for (const [chapter, narrations] of chapters) {
  for (let index = 0; index < narrations.length; index++) {
    const text = narrations[index]!;
    const out = resolve("public", "audio", chapter, `${index + 1}.mp3`);
    await mkdir(dirname(out), { recursive: true });
    console.log(`TTS ${chapter}/${index + 1}: ${text}`);
    await run("python", [
      "-m",
      "edge_tts",
      "--voice",
      voice,
      `--rate=${rate}`,
      `--pitch=${pitch}`,
      "--text",
      text,
      "--write-media",
      out,
    ]);
  }
}
