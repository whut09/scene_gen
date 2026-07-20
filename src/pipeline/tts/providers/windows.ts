import { writeFile } from "node:fs/promises";
import path from "node:path";
import { run } from "../process";

export async function windowsTts(text: string, outputPath: string, voice = "Microsoft Huihui Desktop", rate = 6) {
  const textPath = path.join(path.dirname(outputPath), "narration.txt");
  const scriptPath = path.join(path.dirname(outputPath), "local-tts.ps1");
  await writeFile(textPath, text, "utf8");
  const script = `
Add-Type -AssemblyName System.Speech
$text = Get-Content -LiteralPath "${textPath.replace(/"/g, '`"')}" -Raw -Encoding UTF8
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$requestedVoice = "${voice.replace(/"/g, '`"')}"
$installed = @($synth.GetInstalledVoices() | Where-Object { $_.Enabled } | ForEach-Object { $_.VoiceInfo })
$selected = $installed | Where-Object { $_.Name -eq $requestedVoice -and $_.Culture.Name -eq "zh-CN" } | Select-Object -First 1
if (-not $selected) { $selected = $installed | Where-Object { $_.Culture.Name -eq "zh-CN" } | Select-Object -First 1 }
if (-not $selected) { throw "No enabled zh-CN Windows TTS voice is installed." }
$synth.SelectVoice($selected.Name)
$synth.Rate = ` + String(Math.max(-10, Math.min(10, Math.round(rate)))) + `
$synth.Volume = 95
$synth.SetOutputToWaveFile("${outputPath.replace(/"/g, '`"')}")
$synth.Speak($text)
$synth.SetOutputToNull()
$synth.Dispose()
`;
  await writeFile(scriptPath, script, "utf8");
  await run("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath]);
}
