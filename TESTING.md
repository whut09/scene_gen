# Testing and CI

## Pronunciation

```powershell
python -m pip install -r requirements-test.txt
npm.cmd run test:pronunciation
```

该测试不加载 F5 模型，也不需要 GPU。它会让真实 pypinyin 前端加载 `config/tts/zh-CN.json`，验证“重构”为 `chong2 gou4`，同时检查长句上下文、spoken fallback 和 F5 缓存 key。`config/asr/` 只负责 ASR 转写规范化；`config/tts/` 才控制合成前端发音。修改 TTS 词典会改变 `pronunciationLexiconHash`，从而使旧的分段 WAV 缓存失效。

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
