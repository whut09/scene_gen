import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { spawn } from "node:child_process";
import { narrations as breachCount } from "../src/chapters/01-breach-count/narrations";
import { narrations as blastRadius } from "../src/chapters/02-blast-radius/narrations";
import { narrations as bottleneckShift } from "../src/chapters/03-bottleneck-shift/narrations";
import { narrations as defenderAdvantage } from "../src/chapters/04-defender-advantage/narrations";

const chapters = [
  ["breach-count", breachCount],
  ["blast-radius", blastRadius],
  ["bottleneck-shift", bottleneckShift],
  ["defender-advantage", defenderAdvantage],
] as const;

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
