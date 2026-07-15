import type { VideoProject } from "../../src/pipeline/types";
import { createFixtureProject } from "./project";

export const incrementalNarration = [
  "重要发布",
  "重复任务现在可以直接复用已有结果",
  "系统完成核心模块重构",
  "重量指标保持稳定并完成校验",
  "重新构建只影响指定的分镜",
] as const;

export function createIncrementalMediaProject(): VideoProject {
  const fixture = createFixtureProject();
  const scenes = incrementalNarration.map((text, sceneIndex) => ({
    ...fixture.scenes[0],
    duration: 0.6,
    kicker: `增量验证 ${sceneIndex + 1}`,
    headline: text,
    subhead: sceneIndex === 2 ? "多音字局部修复" : "内容寻址缓存与最小重生成",
  }));
  return createFixtureProject({
    meta: {
      ...fixture.meta,
      title: incrementalNarration[0],
      width: 320,
      height: 240,
      durationSeconds: 3,
    },
    narration: incrementalNarration.join("。"),
    narrationSegments: incrementalNarration.map((text, sceneIndex) => ({
      sceneIndex,
      text,
      audioStartSeconds: sceneIndex * 0.6,
      durationSeconds: 0.6,
    })),
    scenes,
    audio: undefined,
  });
}
