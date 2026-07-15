# Testing and CI

## Pronunciation

```powershell
python -m pip install -r requirements-test.txt
npm.cmd run test:pronunciation
```

该测试不加载 F5 模型，也不需要 GPU。它会让真实 pypinyin 前端加载 `config/tts/zh-CN.json`，验证“重构”为 `chong2 gou4`，同时检查长句上下文、spoken fallback 和 F5 缓存 key。`config/asr/` 只负责 ASR 转写规范化；`config/tts/` 才控制合成前端发音。缓存使用当前文本命中的词典条目 hash，因此修改目标短语只使相关分段 WAV 失效。

`npm.cmd run test:unit` 还会使用 `tests/fixtures/mock-f5-worker.py` 验证持久化 worker 协议，不加载真实 F5 模型或 GPU。覆盖 ready 超时、崩溃后有限重启、AbortSignal 取消、单 worker 串行请求、单/多 GPU 设备解析、缓存命中不调用 worker，以及发音词典 hash 变化后重新合成。

`tests/integration/scene-audio-regeneration.test.ts` 使用五分镜 mock F5 项目验证局部音频修复：只强制 scene 2 时仅增加一次 TTS 调用，其余四段命中缓存，总旁白仍会重新 concat；未提供 sceneIndex 时五段全部重建。该测试还用 FFmpeg 创建两秒无声视频，确认 remux-only 路径不会录制任何 HTML scene，只把新音频封装到已有画面。

`tests/integration/html-render-concurrency.test.ts` 使用固定五个短场景验证 HTML 渲染调度：并发 1 时峰值为 1，并发 2 时峰值为 2，但全程只启动一个 browser；同时覆盖缓存命中不创建 context、只强制目标 scene、失败后保留成功缓存、resume 只补未完成场景、AbortSignal 清理 browser/context，以及并发完成后仍按 sceneIndex 顺序 concat。

项目测试分为核心单元测试、离线集成与媒体 smoke、HTML 模板截图检查三层。

`tests/integration/offline-llm.test.ts` 使用模拟 OpenAI 服务验证故事规划和内容展开是两次独立调用，并确认确定性否决后的候选不会进入展开阶段。`src/pipeline/story-planner.test.ts` 覆盖 profile 候选数量、事实引用、重复屏幕、历史效果和结果持久化。

```powershell
# 类型检查与核心单元测试
npm.cmd run lint:types
npm.cmd run test:unit

# 固定文章 + 模拟 LLM，以及 FFmpeg 两秒音视频门禁
npm.cmd run test:offline

# Playwright 模板截图、安全区、溢出和关键文本检查
npm.cmd run test:golden

# 与 CI 相同的完整检查，包含依赖审计
npm.cmd run test:ci
```

Linux/macOS 将 `npm.cmd` 替换为 `npm`。截图测试首次运行前执行：

```powershell
npm exec -- playwright install chromium
```

媒体 smoke test 只使用 FFmpeg 的合成源，不需要 GPU、F5-TTS、Whisper 或真实 API。截图保存在 `test-results/golden/`，该目录不提交 Git，但 CI 会将其作为 artifact 上传，便于检查空白、溢出、安全区和关键文本问题。

GitHub Actions 使用 Node.js 20，并执行：

1. TypeScript 类型检查。
2. 核心单元测试。
3. 固定文章与模拟 LLM 的离线集成测试。
4. FFmpeg 生成的两秒音视频门禁测试。
5. Playwright Chromium 模板截图检查。
6. `npm audit --audit-level=low` 依赖审计。

## Content-addressed cache

`tests/integration/content-addressed-cache.test.ts` verifies that two concurrent run targets generate one cache key once, later runs restore it without regeneration, incomplete entries are ignored, and prune protects references owned by an active run. The scene audio integration test also confirms that an identical second run makes zero additional mock F5 requests.

## Incremental media performance

```powershell
npm.cmd run test:worker
npm.cmd run test:incremental
npm.cmd run benchmark:media
```

`tests/integration/incremental-media-performance.test.ts` 使用固定五屏旁白，包含“重要、重复、重构、重量、重新构建”，不加载真实 GPU 模型。它验证：

1. cold run 合成并录制全部五个场景，只启动一次 worker/模型；
2. warm run 的 TTS 和 scene recorder 调用均为零；
3. scene 2 发音错误仅调用一次 TTS，并只 concat audio + remux；
4. scene 3 `blank_frame` 不调用 TTS，只录制一个 scene 后 concat video + remux；
5. `stream_duration_drift` 只 remux；
6. 修改“重构”词典条目只使包含该短语的音频失效，其他音频和全部视频继续命中缓存。

稳定测试只断言调用次数、worker 最大并发、dirty set、输出完整性和 warm run 任务数更少。`benchmark:media` 将本机耗时写入 `test-results/benchmark/media/media-report.json`，字段包括 cold/warm、模型加载、音频生成、视频生成、concat、mux、缓存命中率和局部重生成场景。
