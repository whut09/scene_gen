import { writeFile } from "node:fs/promises";
import { getRuntimeConfig } from "../../../config/runtime-config";
import { fetchWithRetry } from "../../external-operation";

export async function openAiTts(text: string, outputPath: string) {
  const config = getRuntimeConfig().tts;
  const apiKey = config.openai.apiKey;
  if (!apiKey) throw new Error("OPENAI_TTS_API_KEY or OPENAI_API_KEY is not set");
  const baseUrl = config.openai.baseUrl;
  const response = await fetchWithRetry(`${baseUrl.replace(/\/$/, "")}/audio/speech`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: config.openai.model,
      voice: config.openai.voice,
      input: text,
      format: "mp3",
      speed: config.openai.speed,
    }),
  }, { label: "openai-tts", timeoutMs: config.fetchTimeoutMs });
  if (!response.ok) throw new Error(`OpenAI TTS failed: ${response.status} ${await response.text()}`);
  await writeFile(outputPath, Buffer.from(await response.arrayBuffer()));
}

