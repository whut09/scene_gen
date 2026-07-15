# Testing and CI

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
