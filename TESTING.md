# Testing and CI

## Pronunciation

```powershell
python -m pip install -r requirements-test.txt
npm.cmd run test:pronunciation
```

该测试不加载 F5 模型，也不需要 GPU。它会让真实 pypinyin 前端加载 `config/tts/zh-CN.json`，验证“重构”为 `chong2 gou4`，同时检查长句上下文、spoken fallback 和 F5 缓存 key。`config/asr/` 只负责 ASR 转写规范化；`config/tts/` 才控制合成前端发音。修改 TTS 词典会改变 `pronunciationLexiconHash`，从而使旧的分段 WAV 缓存失效。

`npm.cmd run test:unit` 还会使用 `tests/fixtures/mock-f5-worker.py` 验证持久化 worker 协议，不加载真实 F5 模型或 GPU。覆盖 ready 超时、崩溃后有限重启、AbortSignal 取消、单 worker 串行请求、单/多 GPU 设备解析、缓存命中不调用 worker，以及发音词典 hash 变化后重新合成。

`tests/integration/scene-audio-regeneration.test.ts` 使用五分镜 mock F5 项目验证局部音频修复：只强制 scene 2 时仅增加一次 TTS 调用，其余四段命中缓存，总旁白仍会重新 concat；未提供 sceneIndex 时五段全部重建。该测试还用 FFmpeg 创建两秒无声视频，确认 remux-only 路径不会录制任何 HTML scene，只把新音频封装到已有画面。

`tests/integration/html-render-concurrency.test.ts` 使用固定五个短场景验证 HTML 渲染调度：并发 1 时峰值为 1，并发 2 时峰值为 2，但全程只启动一个 browser；同时覆盖缓存命中不创建 context、只强制目标 scene、失败后保留成功缓存、resume 只补未完成场景、AbortSignal 清理 browser/context，以及并发完成后仍按 sceneIndex 顺序 concat。

项目测试分为核心单元测试、离线集成与媒体 smoke、HTML 模板截图检查三层。

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
