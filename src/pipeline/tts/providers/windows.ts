import { writeFile } from "node:fs/promises";
import path from "node:path";
import { run } from "../process";

export async function windowsTts(text: string, outputPath: string) {
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

