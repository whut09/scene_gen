# 增量媒体生成与性能指南

## 端到端执行模型

`scene_gen` 将媒体生成拆成场景级音频与场景级视频任务。F5 音频写入 `dist/cache/audio/`，HTML 场景视频写入 `dist/cache/video-scenes/`，Zod 校验后的元数据写入 `dist/cache/metadata/`。相同内容在不同 run 中使用同一 cache key，并通过文件锁 single-flight 避免重复启动 F5 合成或 Chromium 录屏。

质量问题先转换成 `DirtyPlan`：

- `audio_pronunciation_mismatch`：仅重建对应音频、重新 concat narration、对现有无声视频 remux。
- `blank_frame` / `scene_motion_too_static`：仅重录对应 HTML scene、重新 concat video、remux。
- `stream_duration_drift`：只 remux。
- 分镜或旁白内容修订：根据 JSON Patch 计算实际 audio/video dirty set。

## 多音字与 `ttsText`

TTS 发音词典位于 `config/tts/zh-CN.json`，ASR 转写规范化位于 `config/asr/`，两者用途不同。词典条目包含 `phrase`、`pinyin`、`spokenFallback` 和 `enabled`。修改词典后运行：

```powershell
npm.cmd run test:pronunciation
```

`text` 是字幕、项目 JSON 和质量对照使用的原始文本；`ttsText` 仅供语音合成。拼音前端仍不稳定时，可以让 `ttsText` 或 `spokenFallback` 使用“重新构建”等自然表达，但不得修改屏幕字幕和新闻原文。

音频 cache key 只哈希当前文本实际命中的发音词典条目。修改“重构”不会使只包含“重要”或普通文本的音频失效；新增一个能命中当前文本的短语仍会正确改变 cache key。

## 持久化 F5 worker

默认 `F5_TTS_WORKER_MODE=worker`。Node.js 启动 Python JSON Lines worker，worker 只加载一次模型、vocoder、参考音频、参考文本和完整发音词典，后续场景只发送合成请求。

单 GPU 默认 `F5_TTS_CONCURRENCY=1`，因为多个 F5 模型进程会重复占用显存并可能触发 CUDA OOM。多 GPU 使用 `F5_TTS_DEVICES=cuda:0,cuda:1`，每张 GPU 一个 worker。旧 CLI 模式可通过 `F5_TTS_WORKER_MODE=cli` 临时回退，但已标记为 deprecated。

## HTML 场景并发

一次项目渲染只启动一个 Chromium browser，每个场景使用独立 BrowserContext/Page。`HTML_RENDER_CONCURRENCY` 同时受 CPU、可用内存、场景数量和 profile 限制。FFmpeg 每个任务的线程预算约为 `floor(cpuCount / renderConcurrency)`，避免多个编码任务同时占满所有 CPU。

推荐从以下值开始：

- `ci-offline=1`
- `local-f5=2`
- `production=2`
- `fast-preview=3`

## 缓存维护

```powershell
npm.cmd run scene-gen -- cache inspect
npm.cmd run scene-gen -- cache prune --max-age-days 30 --max-size-gb 20 --dry-run
npm.cmd run scene-gen -- cache prune --max-age-days 30 --max-size-gb 20
npm.cmd run scene-gen -- cache clear
```

活动 run 会把引用写入 `dist/runs/<run-id>/cache-refs.json`。prune 不删除仍被 `status=running` 的 run 引用的缓存。`clear` 在存在活动 run 时拒绝执行。

## Benchmark

稳定 CI 验证：

```powershell
npm.cmd run test:worker
npm.cmd run test:incremental
```

本地耗时对比：

```powershell
npm.cmd run benchmark:media
```

报告写入 `test-results/benchmark/media/media-report.json`，包含 `coldRunMs`、`warmRunMs`、`modelLoadMs`、`audioGenerationMs`、`videoGenerationMs`、`concatMs`、`muxMs`、`cacheHitRatio`、`regeneratedAudioScenes` 和 `regeneratedVideoScenes`。CI 不对毫秒数做严格断言，只验证调用次数、最大并发、dirty set、输出完整性和 warm run 执行任务少于 cold run。

## Doctor

仓库通用检查使用离线 profile：

```powershell
npm.cmd run doctor
```

本地 F5 生产环境使用严格检查：

```powershell
npm.cmd run scene-gen -- doctor --profile local-f5
```

doctor 检查 Node、FFmpeg/FFprobe、libx264、可选硬件 H.264 encoder、Playwright、Python、CUDA、F5 包和模型缓存、F5 worker 入口、发音词典 schema、Whisper、API 配置、HTML 并发预算、输出目录、缓存目录及剩余磁盘空间。

## Windows 与 Linux

- Windows 使用 `npm.cmd`，Linux/macOS 使用 `npm`。
- 不要把 `F:\...` 虚拟环境路径提交到公共 profile；Windows 本机路径放入 `.env.local` 或 `*.local.json`。
- Linux 的 Python/F5 路径通常是 `.venv/bin/python`，Windows 是 `.venv\Scripts\python.exe`。
- Playwright 浏览器需要在当前操作系统单独安装：`npm exec -- playwright install chromium`。
- FFmpeg encoder 名称可能因发行版不同；至少需要 `libx264`，硬件 encoder 是可选加速项。

## 故障排查

### 发音修复后仍使用旧音频

运行 `scene-gen cache inspect`，确认当前 `TTS_PRONUNCIATION_LEXICON` 指向已修改文件。对已确认错误的场景使用 audio gate 或 `forceSceneIndexes` 强制重建；不要只修改 `config/asr/`。检查报告中的 `generatedAudioSceneIndexes`，必须包含目标场景。

### F5 worker 未启动

运行 `scene-gen doctor --profile local-f5`。检查 `F5_TTS_PYTHON`、`F5_TTS_WORKER_SCRIPT`、参考音频、参考文本和模型缓存。缓存全部命中时 worker 不启动是正常行为。

### CUDA OOM

保持单 GPU `F5_TTS_CONCURRENCY=1`，不要并行启动多个 CLI 模型进程。关闭占用显存的程序；多 GPU 时显式配置 `F5_TTS_DEVICES`。

### HTML 并发过高

降低 `HTML_RENDER_CONCURRENCY`，检查 doctor 输出的 effective concurrency、可用内存和 `ffmpegThreadsPerJob`。BrowserContext 峰值不应超过有效并发。

### FFmpeg CPU 占满

降低 HTML 并发或使用 `fast-preview`。确认每个任务传入受限 `-threads`，不要让多个 FFmpeg 进程各自使用全部核心。

### 缓存未命中

比较 cache metadata 的 provider/model/text、发音条目 hash、参考音频/文本、模板/CSS/资源内容、Playwright/Chromium、编码 profile 和 renderer version。路径和 mtime 不参与身份判断。

### force scene 没有真正重建

检查 `forcedAudioSceneIndexes` / `renderedScenes`。音频强制重建必须产生至少一个 cache miss；视频强制重建必须绕过对应 scene CAS。若数组为空，检查 issue 是否携带正确的零基 `sceneIndex`。

### final remux 后仍有时长漂移

先检查 narration、无声视频和最终文件的 FFprobe 时长。`stream_duration_drift` 首轮只 remux；`video_project_duration_drift` 重复出现时会升级为全部视频场景重建。音频时长变化时确保 narration segment 时间轴和场景 duration 已更新。
