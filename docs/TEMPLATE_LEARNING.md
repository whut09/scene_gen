# Template Learning

模板选择分为两层。现有规则继续负责许可证、场景类型、画幅、数据密度和明显不适配条件的候选过滤；轻量重排器只在合法候选之间调整顺序，不会让历史数据绕过硬约束。

## 分数

最终分数由以下部分组成：

```text
finalScore = ruleScore
  + historyPass
  + quality
  - overflowRisk
  - blankRisk
  - staticRisk
  - estimatedCost
  - estimatedLatency
  + cacheProbability
  + userFeedback
  + exploration
```

历史通过率和风险率使用平滑先验，少量样本不会立即把模板永久降权。匹配顺序是同模板、同变体、同场景意图和同领域，其次回退到同场景，再回退到模板整体统计。`content-graph.json` 和 production report 会保存每屏的 `ruleScore`、`learnedAdjustment`、`scoreBreakdown`、特征、历史作用域和样本数。

## 数据

默认历史文件为 `data/template-learning/outcomes.jsonl`，每个成功发布流程按场景追加一条记录，包括：

- 模板、变体、场景类型、内容领域和意图；
- 文本长度、卡片数、数据量、数字数量和信息结构；
- blank、overflow、static 与视觉质量分；
- 场景录制和编码耗时、缓存命中；
- 与模板、视觉、布局或动效相关的用户反馈效果。

记录使用 Zod 校验。无法解析的旧行会被忽略，不参与评分。可通过 `TEMPLATE_OUTCOME_FILE` 把不同团队或环境的数据隔离。

## 探索

`TEMPLATE_EXPLORATION_RATE` 默认是 `0.07`，最大限制为 `0.25`。探索使用项目和场景生成稳定采样，只在命中的上下文中给低样本候选不确定性奖励，因此相同输入仍可复现。默认 profile：

- `fast-preview`、`ci-offline`：0；
- `local-f5`、`openai-tts`：0.05；
- `production`：0.08。

`TEMPLATE_EXPLORATION_BONUS` 控制探索奖励，建议保持在 8～18。设置 `TEMPLATE_LEARNING_DISABLED=1` 会同时关闭历史修正、成本修正和探索，完全回退到原规则分。

## 维护

`npm run doctor` 会检查历史目录可写、当前有效样本数和探索率是否合法。排查模板选择时优先查看 production report 中每屏的分数拆解，不要直接删除低分模板。历史数据明显被异常运行污染时，应先备份 JSONL，再按 `templateId`、`runId` 或日期筛除异常记录。

积累足够数据后，可以在保持相同特征和结果协议的前提下，将当前线性重排替换为 contextual bandit；硬过滤、分数拆解、探索上限和禁用回退应继续保留。
