import { getRuntimeConfig } from "../../../config/runtime-config";
import { run } from "../process";

export async function edgeTts(text: string, outputPath: string) {
  const config = getRuntimeConfig().tts.edge;
  if (!config.command) throw new Error("EDGE_TTS_COMMAND is not configured.");
  await run(config.command, ["--voice", config.voice, "--text", text, "--write-media", outputPath]);
}
