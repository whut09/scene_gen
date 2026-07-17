import type { VideoProject } from "../../src/pipeline/types";
import { createFixtureProject } from "./project";

export const cloudPronunciationNarration = [
  "星云产品 3.2 版本是一项重要发布",
  "银行可以避免重复处理同一批任务",
  "系统完成核心模块重构",
  "重量数据与重载运输结果保持稳定",
  "函数重载完成后服务继续行走在升级路径上",
] as const;

export function createCloudPronunciationProject(): VideoProject {
  const fixture = createFixtureProject();
  return createFixtureProject({
    meta: { ...fixture.meta, title: "星云产品 3.2 多音字回归", width: 320, height: 240, durationSeconds: 3 },
    narration: cloudPronunciationNarration.join("。"),
    narrationSegments: cloudPronunciationNarration.map((text, sceneIndex) => ({ sceneIndex, text, audioStartSeconds: sceneIndex * 0.6, durationSeconds: 0.6 })),
    scenes: cloudPronunciationNarration.map((text, sceneIndex) => ({ ...fixture.scenes[0], duration: 0.6, kicker: `云语音回归 ${sceneIndex + 1}`, headline: text, subhead: "显式拼音、免费额度与增量修复" })),
    audio: undefined,
  });
}
