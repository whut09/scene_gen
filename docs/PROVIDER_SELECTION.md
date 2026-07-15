# Provider Selection

Provider 注册表中的质量、成本和延迟只作为冷启动先验。存在运行历史后，选择器优先使用 `data/provider-stats/outcomes.jsonl` 中最近窗口的真实结果。

## ProviderStats

每个 provider 维护：

- 最近成功率和连续失败次数；
- P50、P95 延迟；
- timeout 与发生重试的请求比例；
- 每千字、每张图片或每秒媒体的实际成本；
- 按语言、内容领域和设备筛选的质量分；
- 专有名词和发音词典短语的历史准确率；
- `healthy`、`degraded`、`unhealthy` 或 `unknown` 健康状态；
- 最近十次运行中的 CUDA OOM 次数。

统计使用冷启动先验平滑，少量失败不会立即永久禁用 provider。默认读取最近 100 条，可通过 `PROVIDER_STATS_WINDOW` 调整。

## 动态评分

`fast-preview` 将主要权重分配给延迟；`production` 主要考虑成功率、上下文质量和健康状态。成本使用实际单位成本，没有历史时才使用注册表先验。profile 中配置的 provider 是偏好而非绝对硬编码，因此 API 连续失败或 F5 显存异常时可以自动切换。

连续三次失败或平滑成功率低于 50% 会标记为 `unhealthy`。存在健康替代项时，不健康候选被淘汰；没有其他可用项时仍保留为最后降级路径。Windows System.Speech 始终作为 fallback-only provider，只有主要 TTS 不健康或不可用时才参与最终选择。

对于包含 TTS 发音词典短语的旁白，选择器额外考虑 `pronunciationAccuracy`。F5 出现 `F5_GPU_MEMORY_PRESSURE=1`、近期 CUDA OOM 或 degraded 状态时，worker pool 被限制为单 worker；非 `TTS_FAIL_FAST` 模式下运行失败可继续切换本地 provider。

## 审计与维护

项目音频 metrics 保存实际 TTS 候选审计。Production report 同时记录视觉、素材、渲染和 TTS 的候选分数、健康快照与淘汰理由。发布阶段把音频质量门、视频质量门、Whisper 对齐和渲染指标写回 ProviderStats。

`npm run doctor` 会检查历史目录可写、有效 outcome 数量和当前 degraded/unhealthy provider。异常数据可按 `runId`、`providerId`、`operation` 或日期从 JSONL 中筛除；修改前应先备份。设置 `PROVIDER_HISTORY_DISABLED=1` 可停止写入新历史，但选择器仍会读取已有数据。
