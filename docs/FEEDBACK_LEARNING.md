# Feedback Learning

反馈库用于保存人工验收后发现的稳定要求，但不会把所有历史要求无条件注入 prompt。运行时先按作用域和上下文过滤，再根据历史效果、严重度和时效性排序，并对冲突项只保留得分最高的一条。

## 数据协议

每条 JSONL 记录包含：

- `appliesTo`：`global`、`url:<url>`、`stage:<stage>` 或 `category:<category>`；
- `contentDomains`、`templateIds`、`providerIds`：可选的精确上下文限制；
- `minimumConfidence`：当前证据置信度低于该值时不采用；
- `trialCount`、`successCount`、`failureCount`：完成一次采用与发布判断后更新；
- `lastAppliedAt`、`lastSucceededAt`：最近试用和最近成功时间；
- `effectScoreBefore`、`effectScoreAfter`：最近一次运行的 draft 质量分变化；
- `expiresAt`：到期后自动停止采用；
- `conflictsWith`：与本条互斥的反馈 fingerprint；
- `enabled`、`resolvedAt`：人工禁用或确认问题已解决。

旧记录缺少新字段时会由 Zod schema 补默认值。历史只有 `successCount` 时，`trialCount` 至少提升到已有成功与失败次数之和，避免迁移后成功率失真。

## 选择与排序

成功率使用 Beta(2,2) 先验平滑：

```text
smoothedSuccess = (successCount + 2) / (trialCount + 4)
```

尚未归类为成功或失败的 trial 按 0.5 计入。最终分数综合：

- 严重度；
- 贝叶斯平滑成功率；
- 最近应用时间的 90 天半衰期；
- `effectScoreAfter - effectScoreBefore` 的质量变化。

选择过程会先排除禁用、已解决、已过期、置信度不足和上下文不匹配的记录，再按分数排序。若两条记录通过 `conflictsWith` 声明冲突，只保留先排序到的高分记录；同分时按创建时间和 fingerprint 确定性决胜，保证离线测试和 resume 结果稳定。

## 结果更新

Harness 发布阶段会对本次实际采用的反馈统一记录结果：

- 每次增加 `trialCount` 并更新 `lastAppliedAt`；
- 全部质量门通过时增加 `successCount` 和 `lastSucceededAt`；
- 发布失败时增加 `failureCount`；
- 保存首次与最终 draft 的 `scoreAverage` 作为效果变化；
- 把更新后的 `feedbackOutcomes` 写入最终 `report.json`。

运行在 publish 前异常退出时不会伪造成功或失败结果；run journal 仍负责记录该次运行的阶段故障。

## CLI

```powershell
npm.cmd run scene-gen -- feedback `
  --issue "数据卡文字过密" `
  --category layout `
  --severity high `
  --applies-to "stage:draft" `
  --content-domains software `
  --template-ids data-cards `
  --provider-ids html-video `
  --minimum-confidence 0.8 `
  --expires-at 2026-12-31T23:59:59Z
```

使用 `--conflicts-with <fingerprint,...>` 声明互斥反馈。冲突关系可以只写在任意一侧，选择器会双向识别。运行时文件 `data/feedback/feedback.jsonl` 不应提交；仓库只保留去敏后的 example。
