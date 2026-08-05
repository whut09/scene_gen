# 快速开始

本文覆盖从空白环境到生成第一个 MP4 的最短路径。架构设计见 [ARCHITECTURE.md](ARCHITECTURE.md)，生产故障处理见 [OPERATIONS.md](OPERATIONS.md)。

## 环境要求

- Node.js 20 或 22；
- FFmpeg 与 FFprobe，并支持 H.264 编码；
- Playwright Chromium；
- 可访问的 OpenAI 兼容 LLM；
- 至少一个可用的 TTS provider。

本地 F5、IndexTTS2、Whisper 和 CUDA 仅在对应 profile 中需要。

## 安装

Windows PowerShell：

```powershell
npm.cmd install
npm.cmd exec -- playwright install chromium
ffmpeg -version
ffprobe -version
```

Linux/macOS：

```bash
npm install
npm exec -- playwright install chromium
ffmpeg -version
ffprobe -version
```

Ubuntu/Debian 可使用 `sudo apt install ffmpeg fonts-noto-cjk`。Windows 可使用 `winget install Gyan.FFmpeg`。

## 配置 LLM

仓库中的 `config/news-llm.example.json` 只保存占位符和默认模型。复制为本机文件：

```powershell
Copy-Item config/news-llm.example.json config/news-llm.local.json
```

```json
{
  "NEWS_LLM_API_KEY": "your-key",
  "NEWS_LLM_BASE_URL": "https://your-openai-compatible-endpoint/v1"
}
```

`config/news-llm.local.json`、`.env`、`.env.local` 和 `*.local.json` 已被 Git 忽略。不要把真实密钥写入 example 文件、profile 或命令历史。

质量 Judge 默认复用新闻 LLM 配置。只有使用独立 Judge 服务时才设置 `QUALITY_LLM_API_KEY`、`QUALITY_LLM_BASE_URL` 和 `QUALITY_LLM_MODEL`。

## 选择语音 Provider

### NVIDIA API

`production` 和 `nvidia-api` 默认使用 NVIDIA Magpie 中文语音。在 `.env.local` 中配置：

```dotenv
NVIDIA_API_KEY=your-nvidia-api-key
```

推荐先运行：

```powershell
npm.cmd run scene-gen -- doctor --profile nvidia-api
npm.cmd run scene-gen -- tts providers --profile nvidia-api
npm.cmd run scene-gen -- tts smoke --provider nvidia --profile nvidia-api
```

### IndexTTS2

`indextts-local` 使用固定参考音频保持音色一致。模型路径、Python 和参考音频写入 `.env.local`：

```dotenv
INDEXTTS_ROOT=../models/index-tts
INDEXTTS_MODEL_DIR=../models/index-tts/checkpoints
INDEXTTS_REF_AUDIO=../models/index-tts/local/scene-gen-reference.wav
INDEXTTS_PYTHON=../models/index-tts/.venv-system/Scripts/python.exe
```

单 GPU 默认并发为 1。参考音频应为干净、单人、普通话且没有背景音乐的录音。

### F5-TTS

`local-f5` 使用持久化 Python worker，模型和 vocoder 每个 worker 只加载一次。至少配置 `F5_TTS_PYTHON`、模型缓存和参考音频。详细参数见 [PERFORMANCE.md](PERFORMANCE.md)。

### 离线与预览

- `ci-offline` 使用 mock provider，不访问真实 API；
- `fast-preview` 适合快速检查脚本和版式，不应替代 production 发布门禁。

## 环境检查

```powershell
npm.cmd run doctor -- --profile production
```

Doctor 检查 Node、FFmpeg/FFprobe、编码器、Playwright、Python、模型、API 配置、词典、缓存目录、磁盘空间和并发预算。失败项应在正式生成前解决。

## 生成第一个视频

先执行计划，确认内容类型、Provider、模板和环境需求：

```powershell
npm.cmd run scene-gen -- plan --url "https://example.com/article" --profile production
```

执行完整流程：

```powershell
npm.cmd run scene-gen -- run --url "https://example.com/article" --profile production
```

支持的来源包括：

- 新闻网页；
- 技术文章；
- 公开代码仓库页面。

最终视频位于 `dist/output/`。文件名与视频首页标题保持一致。运行记录位于 `dist/runs/<run-id>/`。

## 常用参数

```powershell
npm.cmd run scene-gen -- run `
  --url "<url>" `
  --profile production `
  --seconds 80 `
  --iterations 3 `
  --video-iterations 3 `
  --engine html-video `
  --out-dir "dist/output"
```

- `--seconds` 是编辑目标，不是强行拉伸音频的硬时长；
- `--notes` 添加本次运行的事实边界或编辑要求；
- `--dry-run` / `--plan-only` 只展示计划；
- `--ignore-cache` 忽略项目缓存，媒体缓存仍由具体阶段规则管理；
- `--quality-profile strict|balanced|lenient` 控制质量门策略。

使用 `npm.cmd run scene-gen -- run --help` 查看完整参数，未知或拼错的参数会直接报错。

## 下一步

- 理解执行链路：[ARCHITECTURE.md](ARCHITECTURE.md)
- 调整生产质量门：[QUALITY_HARNESS.md](QUALITY_HARNESS.md)
- 恢复失败运行和清理缓存：[OPERATIONS.md](OPERATIONS.md)
- 运行测试：[../TESTING.md](../TESTING.md)
