import type { NarrationSegment } from "../types";

export function narrationSynthesisText(segment: NarrationSegment) {
  return segment.ttsText?.trim() || segment.text;
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

