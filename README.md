# Scene Gen

输入一篇新闻 URL，自动抓取正文、生成时长随新闻信息量自然变化的中文旁白与五段竖屏分镜，使用 F5-TTS 配音，默认经 HTML Video 模板精修并渲染为 1080x1920 MP4，并由质量 harness 检查脚本、音频、音画同步和最终视频。

## 一键生成

在项目根目录执行：

```powershell
npm.cmd install
npm.cmd run video -- --url "https://example.com/news"
```

默认行为：

- 只处理输入 URL 对应的一篇新闻。
- 默认以 100 秒作为编导参考，但不会强行压缩；常见成片会根据内容自然落在约 70 到 165 秒。
- 生成 5 个逐段对应的新闻场景和旁白；第一段旁白的第一句话逐字播报完整新闻标题。
- 使用 F5-TTS 的本地参考音色，每屏单独合成。
- 仅在自然范围内微调语速，超过范围时允许视频变长或变短，并按处理后的真实音频边界切屏。
- 默认使用 HTML Video 两级动态布局路由：先选场景模板，再按新闻语义选择模板内部变体；五屏至少三种构图，相邻场景不重复。
- 输出 1080x1920 MP4。
- 默认输出到 `F:\发布视频`，质量报告输出到 `dist/quality/<run-id>/`。

指定参数：

```powershell
npm.cmd run video -- --url "新闻地址" --seconds 100 --iterations 2 --screenshots 0 --engine html-video --out-dir "F:\发布视频" --notes "本次额外事实边界"
```

- `--seconds`：建议时长锚点，默认 100；不是硬限制，质量门默认接受约 0.7 到 1.65 倍的自然时长。
- `--iterations`：脚本生成和质量修订的最大轮数，默认 2，范围 1 到 4。
- `--screenshots`：最多抓取的网页截图数；默认 0，避免截图与统一背景不匹配。
- `--engine`：`html-video` 为质量优先路径，`remotion` 为速度优先路径；一键命令默认 `html-video`。
- `--out-dir`：MP4 输出目录。
- `--notes`：本次新闻的额外事实校正或表达约束。

成功后会输出：

```text
F:\发布视频\01-新闻标题.mp4
public/generated/stories/01-新闻标题.json
dist/quality/<run-id>/report.json
dist/quality/<run-id>/report.md
dist/quality/<run-id>/frame-1.jpg
dist/quality/<run-id>/frame-2.jpg
dist/quality/<run-id>/frame-3.jpg
```

## 工作原理

```text
新闻 URL
  -> Readability 抓正文
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

`npm run video` 本身就是生产 harness，分为三道质量门：

1. Draft gate：检查原题保留、第一句话是否完整播报标题、正式发布状态、5 屏与 5 段旁白、逐屏字数、禁词、场景数据完整度、旁白与当前画面字段重合度，以及旁白中是否出现画面未展示的数字；同时阻止 GitHub 指标与功能要点错配、定性能力图伪装成百分比图。可调用 LLM judge 给出事实忠实度、标题吸引力、信息密度、视觉结构、逐屏一致性和 TTS 可读性评分。
2. Audio gate：检查 TTS 是否存在、时长是否处于合理弹性范围、旁白字数/秒是否自然、数字是否已转换为中文读法、每段音频起点和场景边界是否逐帧对齐；随后用本地 Whisper 转写真实首屏音频，确认实际语音从标题开头播报并达到标题覆盖率门槛。
3. Video gate：使用 FFprobe 检查视频流、音频流、1080x1920、总时长与流偏差，并在开头、中段和结尾抽帧排除空白画面。

硬规则不通过时，harness 会把问题和改进要求传入下一轮。达到最大轮数仍不合格时会停止，不导出伪成片。LLM judge 的审美评分属于软建议，服务异常或评分偏低会记录到报告，但不会覆盖事实、时长和音画同步等硬门槛。

## 记录用户反馈

把实际发布后发现的问题写入反馈库：

```powershell
npm.cmd run feedback:add -- --category title --severity high --issue "标题没有保留原新闻卖点" --desired "主标题优先使用新闻原题核心信息"
```

也可以绑定某个 URL：

```powershell
npm.cmd run feedback:add -- --url "https://example.com/news" --category audio --severity high --issue "第二屏语音和文字不一致" --desired "每屏独立生成旁白并按真实音频切屏"
```

运行时反馈保存在 `data/feedback/feedback.jsonl`，该文件不会提交。提交版示例位于 `data/feedback/feedback.example.jsonl`。后续每次生成会读取最近反馈，把相关问题加入脚本约束和质量评审，实现持续优化。

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
F5_TTS_VENV=F:\codex\.venvs\scene_gen_f5_py39
F5_TTS_MODEL=F5TTS_v1_Base
F5_TTS_DEVICE=cuda
F5_TTS_SPEED=1.45
F5_TTS_UNIFORM_SPEED=1.25
F5_TTS_NFE_STEP=16
F5_TTS_REF_AUDIO=F:\path\to\voice-reference.wav
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
ASR_PYTHON=F:\codex\.venvs\scene_gen_f5_py39\Scripts\python.exe
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
npm.cmd run video:check -- --project "public\generated\stories\01-news.json" --video "F:\发布视频\01-news.mp4" --seconds 100
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
npm.cmd run video:html -- --url "https://example.com/news"

# 速度优先一键生成
npm.cmd run video:remotion -- --url "https://example.com/news"

# 生成 html-video compatible content graph 并渲染
npm.cmd run render:html-video

# 类型检查
npm.cmd run lint:types
```

项目保留 Remotion 和 HTML Video 双渲染器。同一份 `VideoProject` 会导出 ContentGraph v2，由可解释模板选择器按场景意图、信息密度、画幅、时长和历史使用情况选择构图。详细设计见 `docs/html-video-integration.md`。

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
