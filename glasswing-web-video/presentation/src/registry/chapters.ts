import type { ChapterDef } from "./types";
import BreachCount from "../chapters/01-breach-count/BreachCount";
import { narrations as breachCountNarrations } from "../chapters/01-breach-count/narrations";
import BlastRadius from "../chapters/02-blast-radius/BlastRadius";
import { narrations as blastRadiusNarrations } from "../chapters/02-blast-radius/narrations";
import BottleneckShift from "../chapters/03-bottleneck-shift/BottleneckShift";
import { narrations as bottleneckShiftNarrations } from "../chapters/03-bottleneck-shift/narrations";
import DefenderAdvantage from "../chapters/04-defender-advantage/DefenderAdvantage";
import { narrations as defenderAdvantageNarrations } from "../chapters/04-defender-advantage/narrations";

/**
 * Order = order of presentation.
 *
 * Each chapter MUST provide a `narrations: Narration[]` array. Its length
 * is the chapter's step count — there is no `totalSteps` to maintain
 * separately. This guarantees the audio synthesis pipeline, the runtime
 * stepper, and the chapter `.tsx` switch on `step` cannot drift apart.
 *
 * Visual styling (color, fonts) comes entirely from the active theme —
 * chapters never hard-code palette / font names. See THEMES.md.
 */
export const CHAPTERS: ChapterDef[] = [
  {
    id: "breach-count",
    title: "AI 一次扫出 10,000 个高危漏洞",
    narrations: breachCountNarrations,
    Component: BreachCount,
  },
  {
    id: "blast-radius",
    title: "从试点扩张到关键基础设施",
    narrations: blastRadiusNarrations,
    Component: BlastRadius,
  },
  {
    id: "bottleneck-shift",
    title: "瓶颈从找洞变成修洞",
    narrations: bottleneckShiftNarrations,
    Component: BottleneckShift,
  },
  {
    id: "defender-advantage",
    title: "防守方能否建立永久优势",
    narrations: defenderAdvantageNarrations,
    Component: DefenderAdvantage,
  },
];
