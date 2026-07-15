# 两阶段故事生成

Draft 不再直接要求模型一次性生成完整五屏项目，而是执行两个独立调用。

## 规划阶段

规划模型只返回候选的叙事角度、标题、预计时长、五屏 purpose/focus 和事实 `claimIds`，不生成完整旁白或视觉字段。候选数量由 `STORY_PLAN_CANDIDATES` 控制：

- `fast-preview`、`ci-offline`：1；
- `local-f5`、`openai-tts`：2；
- `production`：4；
- 显式环境变量可以设置 1～4。

## 确定性否决与重排

`story-planner.ts` 在本地检查未知事实引用、五屏顺序、重复 focus、无法可视化的文本长度、预计时长和标题高风险谓词。被否决方案不会交给另一个 LLM 重新打分。

通过检查的候选按以下维度重排：事实覆盖、标题吸引力、信息多样性、视觉可实现性、TTS 可读性和历史发布效果。每个维度、总分、fingerprint 与否决原因都会写入 `VideoProject.storyPlanning` 和生产报告。

## 展开阶段

展开模型只能使用选中方案的标题和逐屏 claimIds。标题改变、增加计划外事实或跨屏引用事实都会被拒绝，项目回退到进入 LLM 前的确定性草稿。

## 历史效果

发布阶段把选中方案 fingerprint、最终是否通过以及 draft 分数变化追加到 `data/story-planning/outcomes.jsonl`。该文件不提交；后续相同叙事模式会使用平滑成功率参与重排。可通过 `STORY_PLAN_HISTORY_FILE` 改变存储位置。
