import { writeFile } from "node:fs/promises";
import { getRuntimeConfig } from "../../../config/runtime-config";
import { fetchWithRetry } from "../../external-operation";

export async function cloudflareMeloTts(text: string, outputPath: string, signal?: AbortSignal) {
  const config = getRuntimeConfig().tts.cloudflare;
  if (!config.accountId || !config.apiToken) throw new Error("Cloudflare MeloTTS is not configured.");
  const response = await fetchWithRetry(`https://api.cloudflare.com/client/v4/accounts/${config.accountId}/ai/run/${config.model}`, {
    method: "POST",
    headers: { authorization: `Bearer ${config.apiToken}`, "content-type": "application/json" },
    body: JSON.stringify({ prompt: text }),
    signal,
  }, { label: "cloudflare-melotts", timeoutMs: getRuntimeConfig().tts.fetchTimeoutMs });
  if (!response.ok) throw new Error(`Cloudflare MeloTTS failed: ${response.status}`);
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const payload = await response.json() as { result?: { audio?: string } | string };
    const audio = typeof payload.result === "string" ? payload.result : payload.result?.audio;
    if (!audio) throw new Error("Cloudflare MeloTTS response did not include audio.");
    await writeFile(outputPath, Buffer.from(audio, "base64"));
    return;
  }
  await writeFile(outputPath, Buffer.from(await response.arrayBuffer()));
}
