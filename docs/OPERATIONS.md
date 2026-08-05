# 运行与维护

本文覆盖生产运行、恢复、缓存、诊断和常见故障。安装步骤见 [GETTING_STARTED.md](GETTING_STARTED.md)。

## 产物生命周期

| 路径 | 内容 | 建议保留时间 |
| --- | --- | --- |
| `dist/output/` | 最终 MP4 | 发布后归档 |
| `dist/runs/<run-id>/` | journal、项目、评估、报告和恢复状态 | 确认无需 resume 后清理 |
| `dist/cache/audio/` | 跨 run 音频缓存 | 按容量和访问时间 prune |
| `dist/cache/video-scenes/` | 跨 run 场景视频缓存 | 按容量和访问时间 prune |
| `dist/plans/` | dry-run 与 plan 输出 | 可随时清理 |
| `public/generated/` | 项目与渲染工作产物 | 无活动 run 引用时清理 |

所有运行时目录都被 Git 忽略。

## Doctor

```powershell
npm.cmd run doctor -- --profile production
```

Doctor 检查：

- Node.js、Python、FFmpeg 和 FFprobe；
- `libx264` 与可选硬件编码器；
- Playwright Chromium；
- LLM/TTS 配置和 Provider 连通性；
- CUDA、本地模型、worker 和参考音频；
- 发音词典与 G2PW 配置；
- Whisper/ASR 和发音 verifier；
- 输出与缓存目录权限、磁盘空间；
- HTML 并发和 FFmpeg 线程预算。

在生产任务前先解决 error；warning 是否阻止发布由 profile 决定。

## 恢复运行

查看 `dist/runs/<run-id>/run.json` 可以确认最后成功阶段、错误、耗时、恢复建议和产物路径。

```powershell
# 从最后失败位置恢复
npm.cmd run scene-gen -- resume "<run-id>"

# 从指定阶段继续
npm.cmd run scene-gen -- resume "<run-id>" --from-stage audio

# 强制重做某阶段
npm.cmd run scene-gen -- resume "<run-id>" --force-stage render
```

Resume 默认复用原 run 的不可变配置快照。确实需要改变 profile 或参数时必须显式确认：

```powershell
npm.cmd run scene-gen -- resume "<run-id>" --override-config --profile production
```

## 缓存管理

```powershell
# 查看容量、条目和活动引用
npm.cmd run scene-gen -- cache inspect

# 先预览清理结果
npm.cmd run scene-gen -- cache prune --max-age-days 30 --max-size-gb 20 --dry-run

# 执行清理
npm.cmd run scene-gen -- cache prune --max-age-days 30 --max-size-gb 20

# 清空缓存；存在活动 run 时会拒绝
npm.cmd run scene-gen -- cache clear
```

Prune 不删除被活动 run 引用的缓存。缓存 identity 使用内容哈希，不依赖路径或修改时间。

## 性能定位

先从 run journal 的阶段耗时判断瓶颈：

- `workerStartupMs` / `modelLoadMs`：本地 TTS 模型启动；
- `queueWaitMs` / `synthesisMs`：语音队列和合成；
- `cacheHitCount` / `cacheMissCount`：音频缓存效果；
- `browserStartupMs`：Chromium 启动；
- `perSceneRecordMs` / `perSceneEncodeMs`：场景录制和编码；
- `concatMs` / `muxMs`：媒体拼接与封装；
- `renderConcurrency`：实际渲染并发。

本地 benchmark：

```powershell
npm.cmd run benchmark:media
```

不要仅通过提高并发解决性能问题。单 GPU TTS 默认并发 1；HTML 并发还受 CPU、内存和 FFmpeg 线程预算限制。

## 常见故障

### 发音修复后仍命中旧音频

确认 `PronunciationPlan.planHash` 和 Provider 前端版本发生变化，并检查 `generatedAudioSceneIndexes`。修改 `config/asr/` 只影响转写规范化，不会改变真实 TTS 发音；发音规则应进入 `config/tts/` 或发音计划。

### 同一音频反复生成

检查 issue 是否有真实声学证据。`verification_inconclusive` 只能重试或切换 verifier，不能直接使用相同 Provider、文本和策略重建。检查 no-progress identity 中的 provider、strategy、plan hash、audio hash 和 verifier。

### 视频没有声音

使用 FFprobe 确认最终文件同时包含视频流和音频流，再检查 concat narration 与 mux 阶段。只有场景无声视频存在不代表最终 MP4 已正确封装音频。

### 首屏漏字、残音或缩写读错

检查首段 WAV 的 leading silence、首尾淡入淡出、ASR 标题覆盖和缩写合成计划。高风险缩写必须成为受保护的 Provider 单元，不能只依赖最终汉字转写。

### 音色变化或方言漂移

对本地克隆模型检查参考音频长度、说话人相似度、seed 和采样参数。一个视频应固定 Provider、voice 和参考音频 identity；音色一致性失败时切换策略，不要反复随机重建。

### HTML 画面空白或文字溢出

查看 video gate 的 DOM audit、帧证据和失败 `sceneIndex`。降低文字密度、切换模板 variant，或只强制重录目标场景。不要删除其他已通过场景缓存。

### FFmpeg 占满 CPU

降低 `HTML_RENDER_CONCURRENCY`，确认每个编码任务使用分配后的线程预算。`fast-preview` 可使用更快 preset，production 默认优先质量。

### CUDA OOM

保持单 GPU 本地 TTS 并发为 1，关闭额外模型进程。多 GPU 环境为每张卡启动一个 worker，不要对所有分段直接 `Promise.all`。

### Judge 或 ASR 不可用

`unavailable` 不是满分。production 会按严格策略阻止发布或要求人工确认；preview profile 可以降级。先解决环境问题，不要将其记为内容质量失败。

## 密钥与日志

- 密钥只放在 `.env.local` 或 `*.local.json`；
- RuntimeConfig snapshot 会脱敏，但仍应限制 run 目录访问权限；
- Provider 错误不得回显 API key、Authorization header 或完整秘密 URL；
- 提交前运行 `git diff --check` 并检查 `git status`；
- 不要把 `dist/`、模型、参考音频或用户反馈数据库提交到仓库。

## 发布前检查

```powershell
npm.cmd run lint:types
npm.cmd run test:unit
npm.cmd run test:offline
npm.cmd run test:incremental
npm.cmd run test:golden
npm.cmd run test:ci
git diff --check
```

测试和 CI 说明见 [../TESTING.md](../TESTING.md)。
