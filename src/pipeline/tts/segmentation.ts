import type { NarrationSegment } from "../types";
import { prepareF5SynthesisText } from "./text-normalization";

export function narrationSynthesisText(segment: NarrationSegment) {
  const configuredText = segment.ttsText?.trim() || segment.text;
  const synthesisText = /\bAI\b/i.test(segment.text) && !/\bAI\b/i.test(configuredText) && configuredText.includes("人工智能")
    ? segment.text
    : configuredText;
  return prepareF5SynthesisText(synthesisText);
}

export function audioGenerationKey(sceneCacheSalts: Record<string, string>) {
  return Object.entries(sceneCacheSalts)
    .sort(([left], [right]) => Number(left) - Number(right))
    .map(([sceneIndex, salt]) => `${sceneIndex}:${salt}`)
    .join("|") || "default";
}
export function splitTitleNarration(title: string, narration: string) {
  const trimmedTitle = title.trim().replace(/[。！？!?]+$/, "");
  const trimmedNarration = narration.trim();
  if (trimmedNarration.startsWith(trimmedTitle)) {
    const body = trimmedNarration.slice(trimmedTitle.length).replace(/^[。！？!?，,:：;；\s]+/, "").trim();
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
