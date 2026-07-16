# Quality Judge

Draft quality gate 同时执行确定性规则和可选 LLM Judge。Judge 的结果必须明确记录测量状态，缺少评分不能再解释为满分。

## 评分状态

- `measured`：六个标准维度全部获得有效评分；
- `partially-measured`：只返回部分维度，或 strict 双样本只完成一次；
- `unavailable`：配置缺失、请求失败、响应为空、Schema 错误或没有识别到任何标准评分；
- `not-required`：通过 `QUALITY_LLM_DISABLED=1` 明确关闭，例如 `ci-offline`。

标准评分维度为 `sourceFidelity`、`titleHook`、`informationDensity`、`visualStructure`、`sceneAlignment` 和 `ttsReadability`。平均分与最低分只根据实际返回的标准维度计算；`unavailable` 和 `not-required` 不写 `scoreAverage`、`scoreMinimum` 或虚假的默认分。

最终 `report.json` 在每个 evaluation 中保存 `scoreStatus`，Markdown 报告显示“已评估”“部分评估”“未评估”或“无需评估”。Loop audit、no-progress 和反馈效果追踪同样不会把缺失评分替换为 100。

## Profile 行为

- `production` / `strict`：Judge 不可用产生环境阻塞；部分评分会作为 strict blocking warning；
- `fast-preview` / `lenient`：Judge 不可用或部分评分保留 warning，但允许确定性规则通过后继续；
- `balanced`：保留 warning，供报告和人工复核使用；
- `ci-offline`：显式设置 `QUALITY_LLM_DISABLED=1`，状态为 `not-required`，不产生不可用告警。

## 双样本一致性

strict 默认设置 `QUALITY_JUDGE_SAMPLES=2`。两个样本按维度求平均作为最终分数，并计算最大维度差异。若差异超过 `QUALITY_JUDGE_MAX_SCORE_DELTA`，产生稳定 issue：

```json
{
  "code": "judge_unstable",
  "stage": "draft",
  "severity": "error",
  "evidence": {
    "sampleCount": 2,
    "maxScoreDelta": 24,
    "threshold": 15
  },
  "repairAction": "retry-stage",
  "retryable": true
}
```

`fast-preview` 默认只采样一次以控制延迟和成本。可按运行环境调整样本数与差异阈值，但样本数被限制为 1～2，避免 Judge 成本无限增长。

## 故障排查

- `judge_unavailable`：检查 API key、base URL、model、网络和返回 JSON Schema；
- `judge_partially_measured`：检查 prompt 或 provider 是否遗漏标准评分字段；
- `judge_unstable`：先重试 Judge；持续不稳定时切换模型或要求人工确认，不应使用两次评分中的较高值；
- 报告显示“无需评估”：确认是否使用了 `ci-offline` 或意外设置 `QUALITY_LLM_DISABLED=1`。
