import type { ProviderCapability, ProviderDescriptor } from "./types";

function configured(...keys: string[]) {
  return keys.some((key) => Boolean(process.env[key] && process.env[key] !== "xxx"));
}

function providers(): ProviderDescriptor[] { return [
  { id: "html-video", name: "HTML Video", capability: "programmatic", enabled: true, local: true, quality: 0.9, cost: 0, latency: 0.35, supportsPortrait: true, commercialUse: true },
  { id: "remotion", name: "Remotion", capability: "programmatic", enabled: true, local: true, quality: 0.84, cost: 0, latency: 0.25, supportsPortrait: true, commercialUse: true },
  { id: "playwright", name: "Playwright", capability: "browser", enabled: true, local: true, quality: 0.86, cost: 0, latency: 0.4, supportsPortrait: true, commercialUse: true },
  { id: "pexels", name: "Pexels", capability: "stock-video", enabled: configured("PEXELS_API_KEY"), local: false, quality: 0.78, cost: 0, latency: 0.55, supportsPortrait: true, commercialUse: true, reason: "Requires PEXELS_API_KEY" },
  { id: "pixabay", name: "Pixabay", capability: "stock-video", enabled: configured("PIXABAY_API_KEY"), local: false, quality: 0.72, cost: 0, latency: 0.55, supportsPortrait: true, commercialUse: true, reason: "Requires PIXABAY_API_KEY" },
  { id: "openai-image", name: "OpenAI Image", capability: "image", enabled: configured("OPENAI_API_KEY", "LLM_API_KEY"), local: false, quality: 0.88, cost: 0.35, latency: 0.65, supportsPortrait: true, commercialUse: true, reason: "Requires an image-capable API" },
  { id: "kling", name: "Kling", capability: "video", enabled: configured("KLING_API_KEY"), local: false, quality: 0.9, cost: 0.8, latency: 0.9, supportsPortrait: true, commercialUse: true, reason: "Requires KLING_API_KEY" },
  { id: "f5", name: "F5-TTS", capability: "tts", enabled: configured("F5_TTS_VENV"), local: true, quality: 0.86, cost: 0, latency: 0.7, supportsPortrait: true, commercialUse: true, reason: "Requires F5_TTS_VENV" },
  { id: "openai-tts", name: "OpenAI-compatible TTS", capability: "tts", enabled: configured("OPENAI_TTS_API_KEY", "OPENAI_API_KEY"), local: false, quality: 0.9, cost: 0.2, latency: 0.35, supportsPortrait: true, commercialUse: true, reason: "Requires OPENAI_TTS_API_KEY or OPENAI_API_KEY" },
  { id: "local-tts", name: "Operating-system TTS", capability: "tts", enabled: process.platform === "win32", local: true, quality: 0.55, cost: 0, latency: 0.2, supportsPortrait: true, commercialUse: true, reason: "Windows System.Speech fallback" },
  { id: "whisper", name: "Whisper alignment", capability: "alignment", enabled: configured("ASR_MODEL", "WHISPER_MODEL"), local: true, quality: 0.82, cost: 0, latency: 0.65, supportsPortrait: true, commercialUse: true, reason: "Requires ASR_MODEL for forced alignment" },
]; }

export function listProviders() { return providers().map((provider) => ({ ...provider })); }

export function selectProvider(capability: ProviderCapability, preferred: string[] = []) {
  const candidates = providers().filter((provider) => provider.capability === capability && provider.enabled && provider.commercialUse && provider.supportsPortrait);
  return candidates.sort((left, right) => {
    const preferredDelta = preferred.indexOf(left.id) - preferred.indexOf(right.id);
    if (preferred.includes(left.id) && preferred.includes(right.id) && preferredDelta !== 0) return preferredDelta;
    if (preferred.includes(left.id)) return -1;
    if (preferred.includes(right.id)) return 1;
    return (right.quality - right.cost * 0.25 - right.latency * 0.15) - (left.quality - left.cost * 0.25 - left.latency * 0.15);
  })[0];
}
