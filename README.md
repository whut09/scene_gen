# Scene Gen

测试、离线 smoke 与 CI 命令见 [`TESTING.md`](TESTING.md)。

输入一篇新闻 URL，自动抓取正文、生成时长随新闻信息量自然变化的中文旁白与五段竖屏分镜，使用 F5-TTS 配音，默认经 HTML Video 模板精修并渲染为 1080x1920 MP4，并由质量 harness 检查脚本、音频、音画同步和最终视频。

## 5 分钟安装

要求 Node.js 20+ 和 FFmpeg。F5-TTS、CUDA 与 Whisper 只在对应 profile 中需要。

```powershell
npm.cmd install
npm.cmd exec -- playwright install chromium
Copy-Item .env.example .env
npm.cmd run doctor -- --profile fast-preview
npm.cmd run scene-gen -- plan --url "https://example.com/news" --profile fast-preview
npm.cmd run scene-gen -- run --url "https://example.com/news" --profile fast-preview
```

Linux/macOS 将 `npm.cmd` 换成 `npm`，复制配置使用 `cp .env.example .env`。第一次正式运行前建议先执行 `doctor` 和 `plan`；`plan` 只抓取文章并展示 provider、模板、成本权重和所需环境，不调用 LLM、TTS 或渲染器。

`run` 也支持同样的计划模式：`npm.cmd run scene-gen -- run --url "新闻地址" --profile production --dry-run`。

安装依赖后也可通过本地 bin 使用 `npm exec -- scene-gen doctor`。正式 CLI 提供：

```text
scene-gen doctor|plan|run|resume|check|feedback|cache
```

所有命令支持 `--help`，未知参数、拼写错误、缺失值、错误枚举和互斥选项会直接返回友好错误，不会静默忽略。

## 配置 Profiles

- `local-f5`：本地 F5-TTS、CUDA、Whisper 和 HTML Video 完整链路。
- `openai-tts`：OpenAI 兼容 LLM/TTS，加本地 HTML Video 渲染。
- `ci-offline`：关闭 LLM judge 与 ASR，使用离线检查设置。
- `fast-preview`：Remotion、单轮 loop、无截图，适合快速预览。
- `production`：严格质量门、HTML Video、三轮 loop 和 fail-fast。

profile 文件位于 `config/profiles/`。环境变量中的显式配置优先于 profile 默认值。Windows 本机路径不要提交到通用配置；可复制 `config/profiles/windows-local-f5.example.json` 为 `windows-local-f5.local.json`，修改路径后使用 `--profile windows-local-f5.local`。`*.local.json` 已被 Git 忽略。

## 一键生成

```powershell
npm.cmd run scene-gen -- run --url "https://example.com/news" --profile production
```

默认行为：

- 只处理输入 URL 对应的一篇新闻。
- 默认以 100 秒作为编导参考，但不会强行压缩；常见成片会根据内容自然落在约 70 到 165 秒。
- 生成 5 个逐段对应的新闻场景和旁白；首页显著展示新闻日期，标题垂直居中，第一段旁白先逐字播报完整标题，再播报新闻日期。
- 使用 F5-TTS 的本地参考音色，每屏单独合成。
- 仅在自然范围内微调语速，超过范围时允许视频变长或变短，并按处理后的真实音频边界切屏。
- 默认使用 HTML Video 两级动态布局路由：先选场景模板，再按新闻语义选择模板内部变体；五屏至少三种构图，相邻场景不重复。
- 输出 1080x1920 MP4。
- 默认输出到项目内 `dist/output/`；本次运行的状态、项目、manifest、逐轮质量结果和最终报告统一输出到 `dist/runs/<run-id>/`。

指定参数：

```powershell
npm.cmd run scene-gen -- run --url "新闻地址" --profile production --seconds 100 --iterations 2 --screenshots 0 --engine html-video --out-dir "dist/output" --notes "本次额外事实边界"
```

- `--seconds`：建议时长锚点，默认 100；不是硬限制，质量门默认接受约 0.7 到 1.65 倍的自然时长。
- `--iterations`：脚本生成和质量修订的最大轮数，默认 4，范围 1 到 8；较高值用于按策略轨迹逐级升级，并仍受 token、TTS、渲染、成本和单 issue 配额限制。
- `--screenshots`：最多抓取的网页截图数；默认 0，避免截图与统一背景不匹配。
- `--engine`：`html-video` 为质量优先路径，`remotion` 为速度优先路径；一键命令默认 `html-video`。
- `--out-dir`：MP4 输出目录。
- `--notes`：本次新闻的额外事实校正或表达约束。
- `--video-iterations`：最终视频检查与修复的最大轮数，默认 2，范围 1 到 3。音视频时长漂移会重新封装，空白帧或错误尺寸会强制重渲染。
- `--quality-profile`：质量门槛配置。`balanced` 默认只阻止硬错误和环境阻塞，`strict` 也阻止 warning，`lenient` 保留 warning 但不阻止发布。可用 `QUALITY_BLOCKING_WARNING_CODES` 指定需要阻止发布的软问题 code。

中断或失败后可以复用已有项目、音频和场景缓存：

```powershell
# 从 run.json 中最后失败的阶段继续
npm.cmd run scene-gen -- resume "<run-id>"

# 跳过抓取和脚本生成，从音频合成继续
npm.cmd run scene-gen -- resume "<run-id>" --from-stage audio

# 从渲染阶段继续，并强制绕过场景视频缓存
npm.cmd run scene-gen -- resume "<run-id>" --force-stage render
```

可用阶段为 `ingest`、`draft`、`draft-gate`、`revise`、`synthesize`、`audio-gate`、`render`、`video-gate` 和 `publish`。`audio` 是 `synthesize` 的简写。每个阶段在 `run.json` 中记录 `status`、`inputHash`、`outputs`、`issues`、`metrics`、`durationMs`、`attempt` 和 `suggestedAction`。

质量 issue 使用稳定协议：`code + stage + severity + sceneIndex + evidence + repairAction + retryable`。环境阻塞使用 `outcome=blocked`，不会伪装成内容质量失败。每轮局部修订还会在 `dist/runs/<run-id>/loop/` 保存项目哈希、问题签名、评分变化、scene/narration JSON Patch、修订原因、token/耗时和解决或新增的问题；连续两轮无变化会停止局部循环并升级到全局重写或终止。

ASR 规范化词典位于 `config/asr/base.json`，项目或领域专用规则位于 `config/asr/<package>.json`。通过 `ASR_DOMAIN_PACKAGES=scene-gen,custom-domain` 组合加载，避免在质量检查函数中继续堆叠项目名规则。

### TTS 多音字词典

ASR 词典只规范化 Whisper 转写结果，不会改变实际语音。F5-TTS 的短语发音词典位于 `config/tts/zh-CN.json`，在 Python 前端启动时通过 pypinyin 加载。例如“重构”固定为 `chong2 gou4`，而“重要”和“重量”保留 `zhong4`。

新增多音字时，为 `entries` 添加 `phrase`、tone3 格式的 `pinyin`、`spokenFallback` 和 `enabled`。`spokenFallback` 只用于语音文本；设置 `TTS_USE_SPOKEN_FALLBACKS=1` 后，“重构”可回退播报为“重新构建”，项目 JSON、字幕和新闻原文仍保留“重构”。也可以直接在单个 `narrationSegment.ttsText` 中提供播报文本。

当前文本实际命中的词典条目会参与 F5 分段音频缓存 key。修改“重构”只使包含该短语的 WAV 失效，不影响仅包含“重要”或普通文本的场景；模型、参考音频、参考文本、速度、NFE step 或前端版本变化仍会使对应 WAV 自动失效。可用 `TTS_PRONUNCIATION_LEXICON` 指向自定义词典，并通过 `npm run test:pronunciation` 在不使用 GPU 的情况下验证 pypinyin 前端。

### F5 持久化 Worker

F5 默认使用 `scripts/f5-worker.py` 的 JSON Lines 持久化 worker。模型、vocoder、参考音频、参考文本和发音词典在 worker 启动时只加载一次，后续每个分镜只发送文本与合成参数。旧的逐段 CLI 模式仍可通过 `F5_TTS_WORKER_MODE=cli` 临时启用，但已标记为 deprecated。

- 单 GPU 默认 `F5_TTS_CONCURRENCY=1`，不会并行启动多个模型进程争抢显存。
- 多 GPU 使用 `F5_TTS_DEVICES=cuda:0,cuda:1`，每张 GPU 启动一个串行 worker；`F5_TTS_CONCURRENCY` 可限制启用数量。
- OpenAI TTS 默认并发为 4，Windows 本地 TTS 默认并发为 1；分别通过 `OPENAI_TTS_CONCURRENCY` 和 `LOCAL_TTS_CONCURRENCY` 调整。
- 缓存检查、文本准备和 FFprobe 使用 `TTS_PREPROCESS_CONCURRENCY` 限流；FFmpeg 后处理使用 `TTS_FFMPEG_CONCURRENCY` 限流。
- `workerStartupMs`、`modelLoadMs`、`queueWaitMs`、`synthesisMs`、缓存命中/未命中和生成/复用场景数会写入 run journal 与最终报告。

worker 启动超时可调整 `F5_TTS_WORKER_READY_TIMEOUT_MS`，单次请求超时可调整 `F5_TTS_WORKER_REQUEST_TIMEOUT_MS`。worker 崩溃只按 `F5_TTS_WORKER_MAX_RESTARTS` 有限重启；父 Node 进程退出后，Python worker 会自行结束，避免残留 GPU 进程。调试协议或测试替身时可通过 `F5_TTS_WORKER_SCRIPT` 指定其他 worker 脚本。

### 分镜级音频修复

Audio gate 返回 `audio_pronunciation_mismatch`、`audio_scene_drift` 等可修复问题并携带 `sceneIndex` 时，harness 只强制重建对应分镜 WAV。未命中的分镜继续使用原缓存，随后重新拼接总旁白并更新时间轴。问题未提供 `sceneIndex` 时会明确重建全部音频，而不是静默复用旧缓存。

每次局部修复使用稳定的 `cacheSalt`，salt 只写入受影响分镜的缓存身份。报告记录 `forcedAudioSceneIndexes`、`generatedAudioSceneIndexes`、`reusedAudioSceneIndexes` 和 `concatenatedAudio`。如果新音频没有改变分镜时长并且已有 `video-no-audio.mp4`，HTML Video 只执行 remux；如果时长变化，则复用并 retime 已缓存的分镜视频，不默认重新录屏。

### HTML Video 并行渲染

一次 `renderHtmlVideoProject()` 只启动一个 Chromium browser。需要录制的分镜各自创建隔离的 BrowserContext/Page，并通过 `HTML_RENDER_CONCURRENCY` 有界并发；缓存命中场景不会创建 context。实际并发还会受到 CPU 核数、可用内存、场景数量和 `HTML_RENDER_MEMORY_PER_JOB_MB` 的共同限制。

每个并发 FFmpeg 编码任务最多使用 `floor(cpuCount / renderConcurrency)` 个线程，避免多个 x264 进程同时占满全部 CPU。编码预设由 `HTML_RENDER_PRESET` 控制：`fast-preview` 和 `ci-offline` 使用 `ultrafast`，`local-f5` 使用 `veryfast`，`production` 使用 `medium`。

### 旁白时间戳同步

TTS 完成后，合成阶段会复用逐场景 WAV，通过单次 Whisper 批量转写获取词级时间戳，再将画面中的标题、卡片和关键短语对齐为 `audioStartMs`、`audioEndMs` 与置信度。`content-graph.json` 中的 `syncCues` 会优先使用这些真实时间戳；HTML Video 在录制开始时按时间触发元素进入和关键词高亮，而不是按关键词数量平均分配时间。

当 Whisper 不可用、没有返回 word timestamps、短语未匹配或置信度低于 `SPEECH_ALIGNMENT_CONFIDENCE_MIN` 时，只对该 cue 回退到原来的 ratio 估算，不会让 TTS 阶段失败。`SPEECH_ALIGNMENT_FUZZY_MIN` 控制模糊匹配下限，`SPEECH_ALIGNMENT_DISABLED=1` 可完全关闭。成功转写会保存在 `narrationSegments[].speechAlignment`，audio gate 直接复用，不会再次启动 Whisper。真实 cue 也进入视频场景内容寻址 cache key；默认按 `HTML_SYNC_CUE_CACHE_BUCKET_MS=120` 毫秒量化，忽略不可感知的 ASR 抖动，超过阈值的时间变化才使对应场景视频失效。

渲染报告包含 `browserStartupMs`、`renderConcurrency`、缓存命中/实际录制分镜、逐分镜录制与编码耗时、`concatMs`、`muxMs` 和 `totalRenderMs`。某个分镜失败时，未开始任务会被取消，正在运行的 context 会完成清理，已成功场景缓存会保留，恢复运行只重建失败和未完成分镜。

成功后会输出：

```text
dist/output/01-新闻标题.mp4
dist/runs/<run-id>/run.json
dist/runs/<run-id>/generation-result.json
dist/runs/<run-id>/projects/01-新闻标题.json
dist/runs/<run-id>/manifest.json
dist/runs/<run-id>/quality/report.json
dist/runs/<run-id>/quality/report.md
dist/runs/<run-id>/quality/frame-1.jpg
```

## 工作原理

```text
新闻 URL
  -> Readability 抓正文
  -> 统一提取并格式化新闻发布日期，写入首页和首段旁白
  -> 新闻 LLM 先生成 5 屏可见内容，再为每屏编写只复述或解释当前画面的旁白
  -> Harness 检查事实硬规则、结构、字数和历史反馈
  -> 不合格时把问题回传给下一轮生成
  -> F5-TTS 每屏独立合成，只在自然语速范围内微调节奏
  -> 回写真正的 narrationSegments 音频边界
  -> Remotion 渲染竖屏视频
  -> FFprobe + FFmpeg 检查音视频流、分辨率、时长和抽帧
  -> 输出 MP4 与质量报告
```

新闻正文是唯一事实依据。脚本生成不得加入站外推断、作者或媒体署名、发布建议、无关动画说明；标题优先保留原新闻标题的核心卖点。

## Agent Harness 与 Loop Engineering

`scene-gen run` 本身就是生产 harness，分为三道质量门：

1. Draft gate：检查中文标题、第一句话是否完整播报标题、新闻日期是否展示并播报、正式发布状态、5 屏与 5 段旁白、逐屏字数、禁词、场景数据完整度、旁白与当前画面字段重合度，以及旁白中是否出现画面未展示的数字；同时阻止 GitHub 指标与功能要点错配、定性能力图伪装成百分比图。可调用 LLM judge 给出事实忠实度、标题吸引力、信息密度、视觉结构、逐屏一致性和 TTS 可读性评分。
2. Audio gate：检查 TTS 是否存在、时长是否处于合理弹性范围、旁白字数/秒是否自然、数字是否已转换为中文读法、每段音频起点和场景边界是否逐帧对齐；随后一次加载本地 Whisper，批量转写每个 scene 的独立音频片段，检查标题开场、文本覆盖率、实体召回率、数字与单位、发音词典短语和相邻场景串段。

逐场景 ASR 的确定性结果写入 audio gate metrics。Whisper 使用生成 token 概率的几何平均值作为场景置信度；高置信度错误会生成带 `sceneIndex` 的 `audio_pronunciation_mismatch`、`audio_entity_mismatch`、`audio_number_mismatch`、`audio_semantic_mismatch` 或 `audio_segment_cross_talk`，因此只重建对应场景音频。低于 `ASR_SCENE_CONFIDENCE_MIN` 的结果只生成 `verification_inconclusive` warning，不触发 TTS 重建。
3. Video gate：使用 FFprobe 检查视频流、音频流、1080x1920、总时长与流偏差；每个 scene 分别抽取开头、中间和结尾三帧，结合文件完整性、亮度范围和边缘密度判断空白或低信息画面。同时读取 HTML 录制前生成的 DOM 视觉审计，检查安全区、字号、行长、对比度、越界、裁切、遮挡、关键文本、图片焦点风险、动画结论停留时间和旁白关键词出现时机。

HTML renderer 会在共享 Chromium 中先把动画推进到结束状态完成 DOM audit，再重新加载页面进行正式录制。审计保存到场景工作目录的 `visual-audit.json`，并随视频场景缓存复用。修改视觉审计逻辑会通过 renderer version 自动使旧场景缓存失效。可选设置 `VIDEO_OCR_ENABLED=1` 并安装 Tesseract `chi_sim`/`eng` 数据，对每屏中间帧执行关键标题 OCR；OCR 环境缺失只记录环境 warning，不会被误判为内容质量失败。

硬规则不通过时，harness 会把问题和改进要求传入下一轮。达到最大轮数仍不合格时会停止，不导出伪成片。LLM judge 的审美评分属于软建议，服务异常或评分偏低会记录到报告，但不会覆盖事实、时长和音画同步等硬门槛。

每次执行都会在生成内容前创建 `dist/runs/<run-id>/run.json`。生成、draft gate、局部修订、TTS、audio gate、渲染和 video gate 的开始时间、完成状态、耗时、产物路径及错误都会原子写入该文件。即使 LLM、TTS、ASR 或渲染中途失败，也可以从 run journal 和 `evaluations/` 中查看失败现场。

外部网络和进程操作使用统一的超时、取消和分类重试：HTTP 429、5xx、网络中断与明确的临时进程错误使用指数退避；Schema、事实和质量门错误不会盲目重试。按需可通过 `EXTERNAL_FETCH_TIMEOUT_MS`、`EXTERNAL_PROCESS_TIMEOUT_MS`、`HARNESS_DRAFT_TIMEOUT_MS`、`HARNESS_SYNTHESIZE_TIMEOUT_MS`、`HARNESS_RENDER_TIMEOUT_MS` 和 `HARNESS_VIDEO_GATE_TIMEOUT_MS` 调整上限。

Harness 不再读取共享 manifest 的第一项。`generate-stories` 会写出本次运行专属的 `generation-result.json` 和 `manifest.json`，GitHub 缓存命中时也会把缓存项目复制到当前 run 目录后再返回，因此并发任务不会拿到其他 URL 的项目或修改原缓存项目。

## 记录用户反馈

把实际发布后发现的问题写入反馈库：

```powershell
npm.cmd run feedback:add -- --category title --severity high --issue "标题没有保留原新闻卖点" --desired "主标题优先使用新闻原题核心信息"
```

也可以使用 `--applies-to` 绑定 URL、阶段或类别；多个作用域用逗号分隔：

```powershell
npm.cmd run feedback:add -- --applies-to "url:https://example.com/news,stage:audio" --category audio --severity high --issue "第二屏语音和文字不一致" --desired "每屏独立生成旁白并按真实音频切屏"
```

运行时反馈保存在 `data/feedback/feedback.jsonl`，该文件不会提交。每条反馈记录 `appliesTo`、稳定 `fingerprint`、`enabled`、`resolvedAt` 和 `successCount`；重复 fingerprint 会被压缩，禁用或已解决的反馈不会注入 prompt，成功发布会增加本次采用反馈的效果计数。可通过 `--disabled` 或 `--resolved` 写入相应状态。提交版示例位于 `data/feedback/feedback.example.jsonl`。

## Windows 与 Linux 差异

- Windows 命令示例使用 `npm.cmd`；Linux/macOS 使用 `npm`。
- 虚拟环境 Python 会自动解析 Windows 的 `Scripts/python.exe` 和 Linux 的 `bin/python3`，也可通过 `F5_TTS_PYTHON`、`ASR_PYTHON` 显式覆盖。
- Windows 可使用 `TTS_PROVIDER=local` 的 `System.Speech` 降级路径；Linux 建议使用 `local-f5` 或 `openai-tts`。
- Windows 可用 `winget install Gyan.FFmpeg`，Ubuntu/Debian 可用 `sudo apt install ffmpeg`。
- CUDA doctor 同时检查 `nvidia-smi` 和 Python 中的 `torch.cuda.is_available()`。

## 大模型配置

新闻总结使用独立配置：

- 提交版：`config/news-llm.example.json`，只能写 `xxx`。
- 本地版：`config/news-llm.local.json`，保存真实配置且被 Git 忽略。

`config/news-llm.local.json`：

```json
{
  "NEWS_LLM_API_KEY": "你的真实 key",
  "NEWS_LLM_BASE_URL": "https://你的接口地址/v1",
  "NEWS_LLM_MODEL": "你的模型名"
}
```

质量 judge 默认复用新闻模型，也可以单独设置：

```powershell
$env:QUALITY_LLM_API_KEY="你的 key"
$env:QUALITY_LLM_BASE_URL="https://你的接口地址/v1"
$env:QUALITY_LLM_MODEL="你的模型名"
```

只运行确定性检查时：

```powershell
$env:QUALITY_LLM_DISABLED="1"
```

## F5-TTS 配置

本地真实配置放在 `.env.local`，提交模板见 `.env.example`：

```dotenv
TTS_PROVIDER=f5
TTS_FAIL_FAST=1
F5_TTS_VENV=.venv-f5
F5_TTS_MODEL=F5TTS_v1_Base
F5_TTS_DEVICE=cuda
F5_TTS_SPEED=1.45
F5_TTS_UNIFORM_SPEED=1.25
F5_TTS_NFE_STEP=16
F5_TTS_REF_AUDIO=assets/voice-reference.wav
F5_TTS_REF_TEXT=
F5_TTS_HF_OFFLINE=1
TTS_DURATION_POLICY=natural
TTS_FIT_TARGET=0
TTS_MIN_TEMPO=0.90
TTS_MAX_TEMPO=1.22
QUALITY_MIN_CHARS_PER_SECOND=6.3
QUALITY_MAX_CHARS_PER_SECOND=11.5
QUALITY_MAX_SEGMENT_SPEED_RATIO=1.35
QUALITY_MAX_SEGMENT_SPEED_CV=0.16
ASR_PYTHON=
ASR_MODEL=openai/whisper-tiny
ASR_LANGUAGE=chinese
ASR_TITLE_COVERAGE_MIN=0.58
```

- `F5_TTS_REF_AUDIO` 决定克隆音色，建议使用干净、单人、无背景音乐的中文语音。
- `F5_TTS_UNIFORM_SPEED` 控制整条视频所有场景，包括首屏标题和正文；默认 1.25，禁止标题慢、正文快。
- TTS 合成前会把整数、小数、百分比、年份、带逗号数量和 `68+` 等表达转换成中文数词；英文项目名和技术名保留专用读音，转换后若仍有阿拉伯数字会停止生成。
- `F5_TTS_REF_TEXT` 应与参考音频逐字一致；已有转写时必须填写，避免串词。
- `F5_TTS_HF_OFFLINE=1` 强制使用本机 Hugging Face 缓存，避免生成时临时联网失败。
- `TTS_DURATION_POLICY=natural` 让视频时长跟随 F5 原始音频，不再为了凑目标秒数整体变慢；只有显式设为 `fit` 时才启用 FFmpeg 节奏拟合。
- `QUALITY_MIN_CHARS_PER_SECOND=6.3` 和 `QUALITY_MAX_CHARS_PER_SECOND=11.5` 限制整片旁白的绝对语速；`QUALITY_MAX_SEGMENT_SPEED_RATIO` 和 `QUALITY_MAX_SEGMENT_SPEED_CV` 检查逐屏语速倍率与离散度。
- `ASR_*` 配置本地 Whisper 复听。实际音频没有识别出标题开头，或标题覆盖率低于阈值时，视频不会通过质量门。
- F5 失败时直接停止，不会偷偷换成低质量系统语音。

依赖本机已安装 FFmpeg、FFprobe、Python F5-TTS 环境；该 Python 环境还需包含 `torch` 和 `transformers`，并已缓存 `SWivid/F5-TTS`、`charactr/vocos-mel-24khz` 与 `openai/whisper-tiny`。

## 单独复检视频

```powershell
npm.cmd run scene-gen -- check --project "public/generated/stories/01-news.json" --video "dist/output/01-news.mp4" --seconds 100
```

该命令不会重新生成内容，只会重新执行 draft、audio、video 三层检查并产生新报告。

## 其他命令

```powershell
# 抓取热度最高的 3 条内容，生成 3 个独立项目
npm.cmd run generate:stories -- --count 3 --screenshots 0

# 渲染 manifest 中的项目
npm.cmd run render:stories

# Remotion 本地预览
npm.cmd run preview

# 质量优先一键生成（默认）
npm.cmd run scene-gen -- run --url "https://example.com/news" --engine html-video

# 速度优先一键生成
npm.cmd run scene-gen -- run --url "https://example.com/news" --engine remotion

# 生成 html-video compatible content graph 并渲染
npm.cmd run render:html-video

# 类型检查
npm.cmd run lint:types
```

## 常见故障

| 症状 | 处理方式 |
| --- | --- |
| `ffmpeg` 或 `ffprobe` unavailable | 安装 FFmpeg，并确认两个命令都在 `PATH` 中；重新运行 `npm run doctor`。 |
| Playwright Chromium missing | 执行 `npm exec -- playwright install chromium`。 |
| `torch.cuda.is_available() is false` | 检查 NVIDIA 驱动、CUDA 对应的 PyTorch 版本，或改用 `openai-tts` / `fast-preview`。 |
| F5 model cache not found | 允许首次联网下载，或预下载模型后再设置 `F5_TTS_HF_OFFLINE=1`。 |
| Whisper cache not found | 预下载 `ASR_MODEL`，或开发时使用 `ASR_DISABLED=1` / `ci-offline`。 |
| API configuration incomplete | 设置 API key、model；自定义兼容服务再设置 base URL。 |
| Output directory not writable / 磁盘不足 | 使用 `--out-dir` 指向可写目录，或清理 `dist/runs`、`dist/output` 和渲染缓存。 |
| 拼错参数 | 执行 `npm run scene-gen -- <command> --help`；CLI 会列出允许的参数与枚举。 |

## 产物生命周期与缓存清理

- `dist/output/`：最终 MP4，长期保留或发布后归档。
- `dist/runs/<run-id>/`：可恢复运行、journal、项目快照、质量报告和 loop audit；确认无需 resume 后可删除。
- `dist/plans/`：`plan` / `--dry-run` 输出，可随时删除。
- `public/generated/assets/`：GitHub 和网页真实素材缓存，删除后会重新下载。
- `public/generated/html-video/`：场景渲染缓存，删除后会重新录制场景。
- `public/generated/stories/`：生成项目缓存；删除前确认不再需要复用已有项目。

PowerShell 清理临时运行与输出：

```powershell
Remove-Item -Recurse -Force dist/runs, dist/plans, dist/output -ErrorAction SilentlyContinue
```

Linux/macOS：

```bash
rm -rf dist/runs dist/plans dist/output
```

需要完全重建素材与渲染缓存时，再额外删除 `public/generated/assets` 和 `public/generated/html-video`。

项目保留 Remotion 和 HTML Video 双渲染器。同一份 `VideoProject` 会导出 ContentGraph v2，由可解释模板选择器按场景意图、信息密度、画幅、时长和历史使用情况选择构图。详细设计见 `docs/html-video-integration.md`。

生成阶段还会从全部来源构建声明级 `factLedger`。标题、每个场景和每段旁白通过 `claimIds` 引用来源证据；质量门会检查高风险动作、数字、限定词和多来源冲突，而不是只检查第一个来源中的数字字符串。协议和维护方式见 [`docs/FACT_LEDGER.md`](docs/FACT_LEDGER.md)。

LLM draft 使用“候选规划 → 确定性否决与重排 → 最佳方案展开”的两阶段流程。不同 profile 默认生成 1、2 或 4 个候选，所有评分与否决原因写入项目和生产报告，详见 [`docs/STORY_PLANNING.md`](docs/STORY_PLANNING.md)。

HTML 模板选择使用“规则候选过滤 → 历史质量重排 → 受控探索”。重排器综合内容领域、场景意图、字数和数据量、素材可用性、历史 blank/overflow/static 风险、质量分、用户反馈、渲染耗时与缓存命中率。运行结果追加到 `data/template-learning/outcomes.jsonl`，生产报告保存规则分、学习修正和最终分；维护与调参说明见 [`docs/TEMPLATE_LEARNING.md`](docs/TEMPLATE_LEARNING.md)。

Provider 选择使用滚动运行历史计算成功率、P50/P95 延迟、timeout/重试率、实际单位成本、上下文质量、发音准确率、健康状态和连续失败次数。`fast-preview` 偏向低延迟，`production` 偏向质量与可靠性；不健康 API 会被主动淘汰，F5 出现显存压力或近期 CUDA OOM 时会降为单 worker 或切换 provider。每次候选分数和淘汰原因写入 production report，详见 [`docs/PROVIDER_SELECTION.md`](docs/PROVIDER_SELECTION.md)。

RepairPlan 使用候选效用模型综合预计成功率、证据置信度、成本、耗时、风险和影响分镜范围。时长漂移会根据 FFprobe 证据在 remux、重拼接和局部重渲染之间选择，不再按 attempt 次数统一升级；候选分数和淘汰理由写入 run journal 与最终报告，详见 [`docs/REPAIR_PLANNING.md`](docs/REPAIR_PLANNING.md)。

No-progress 会记录 prompt、模板 variant、provider、repair action、issue evidence 和策略实际成功率，并按局部约束、替代 prompt、模板、provider、扩大 dirty scope、全局重规划、人工确认逐级升级。token、TTS 重建、渲染分钟、预计成本和单 issue 修复次数均有预算闸门，详见 [`docs/LOOP_GOVERNANCE.md`](docs/LOOP_GOVERNANCE.md)。

## 安全约定

- 不提交真实 API key、账号密码、`.env.local` 或 `*.local.json`。
- 不提交生成的 MP4、WAV、网页截图、质量运行目录或运行时反馈。
- example 配置只保留 `xxx` 占位符。


## Visual Planner 与供应商注册表

生成阶段会为每个场景写入独立的视觉生产计划，不再默认所有内容都只使用同一种网页模板。计划包含：

- `visualPlan.source`：`programmatic`、`web-screenshot`、`stock-video`、`generated-image`、`generated-video`、`github-ui` 或 `mixed`。
- `providerId` 和确定性的 fallback，用于记录实际供应商与降级路径。
- `searchQueries`：供素材检索、网页证据或生成式素材使用的查询词。
- `motionTargets` 和 `expectedMotionRatio`：供运动质量门判断画面是否过于静态。
- `syncCues`：从当前屏可见文字与对应旁白中提取的同步关键词。配置 Whisper 后报告标记为 forced-alignment，否则使用稳定的估算时间点。

供应商通过环境变量启用。未配置的外部供应商不会被调用，系统会回退到 HTML Video / Remotion：

`PEXELS_API_KEY`、`PIXABAY_API_KEY`、`KLING_API_KEY`、`OPENAI_API_KEY`、`ASR_MODEL`。

查看已有项目的生产计划：

~~~powershell
npm.cmd run production:inspect -- --project "public/generated/stories/<story>.json"
~~~

一键生成会在对应 HTML Video 目录和最终质量目录写出 `production-report.json`，其中记录模板、视觉来源、供应商启用状态、回退原因、同步关键词和估算外部成本。最终视频质量门还会以每秒两帧采样，报告 `activeMotionRatio`、`meanSceneChange` 和 `longestStaticRun`；连续静止时间过长时给出明确警告。


### GitHub 真实素材缓存

GitHub URL 输入会额外解析 README 中的非徽章图片，下载最多 `GITHUB_ASSET_LIMIT` 张到 `public/generated/assets/<owner>-<repo>/`。每个资产记录原始 URL、用途、Content-Type 和许可证提示。标题模板优先使用仓库自带 hero 图，同时保留真实仓库地址和 React/CSS 文字层；素材不可用时自动回退到程序化版式。

运动检查现在按场景持续时间切片，除全片指标外还输出 `sceneMotionRatios` 与 `sceneLongestStaticRuns`。某一屏低运动超过阈值时，问题携带 `sceneIndex`，可只调整该模板或对应段落。
## Global media cache

Audio segments and HTML scene videos use a cross-run content-addressed cache under `dist/cache/audio/`, `dist/cache/video-scenes/`, and `dist/cache/metadata/`. Cache identities use content hashes and renderer/synthesis versions rather than paths or modification times. Writes are atomic and concurrent requests for the same key use a filesystem single-flight lock.

```powershell
npm.cmd run scene-gen -- cache inspect
npm.cmd run scene-gen -- cache prune --max-age-days 30 --max-size-gb 20 --dry-run
npm.cmd run scene-gen -- cache clear
```

Active runs register references in `dist/runs/<run-id>/cache-refs.json`; prune never removes entries referenced by a running journal. Quality gates emit a structured `DirtyPlan`, so pronunciation failures rebuild only the affected audio scene plus audio concat/remux, blank or static frames rebuild only the affected video scene plus video concat/remux, and stream drift starts with remux only.

## 增量性能验证与排障

正式的多音字、`text`/`ttsText`、持久化 F5 worker、单 GPU 并发、HTML scene 并发、局部音视频修复、内容寻址缓存、Windows/Linux 差异和故障排查文档见 [`docs/PERFORMANCE.md`](docs/PERFORMANCE.md)。

```powershell
npm.cmd run doctor
npm.cmd run test:worker
npm.cmd run test:incremental
npm.cmd run benchmark:media
```

`test:incremental` 使用固定五屏、mock F5 和 mock HTML recorder 验证 cold run、warm run、scene 2 音频修复、scene 3 空白帧修复、仅 remux，以及发音词典定向失效。`benchmark:media` 才输出本机真实耗时；CI 不使用不稳定的严格耗时断言。
