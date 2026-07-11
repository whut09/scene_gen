# Scene Gen

输入一篇新闻 URL，自动抓取正文、生成约 100 秒中文旁白与五段竖屏分镜，使用 F5-TTS 配音，经 Remotion 渲染为 1080x1920 MP4，并由质量 harness 检查脚本、音频、音画同步和最终视频。

## 一键生成

在项目根目录执行：

```powershell
npm.cmd install
npm.cmd run video -- --url "https://example.com/news"
```

默认行为：

- 只处理输入 URL 对应的一篇新闻。
- 目标时长约 100 秒。
- 生成 5 个逐段对应的新闻场景和旁白。
- 使用 F5-TTS 的本地参考音色，每屏单独合成。
- 自动将旁白节奏归一化到目标时长，并按处理后的真实音频边界切屏。
- 输出 1080x1920 MP4。
- 默认输出到 `F:\发布视频`，质量报告输出到 `dist/quality/<run-id>/`。

指定参数：

```powershell
npm.cmd run video -- --url "新闻地址" --seconds 100 --iterations 2 --screenshots 0 --out-dir "F:\发布视频" --notes "本次额外事实边界"
```

- `--seconds`：目标视频时长，默认 100。
- `--iterations`：脚本生成和质量修订的最大轮数，默认 2，范围 1 到 4。
- `--screenshots`：最多抓取的网页截图数；默认 0，避免截图与统一背景不匹配。
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
  -> 新闻 LLM 生成 5 屏内容、标题、旁白和可视化数据
  -> Harness 检查事实硬规则、结构、字数和历史反馈
  -> 不合格时把问题回传给下一轮生成
  -> F5-TTS 每屏独立合成并自动调速到目标时长
  -> 回写真正的 narrationSegments 音频边界
  -> Remotion 渲染竖屏视频
  -> FFprobe + FFmpeg 检查音视频流、分辨率、时长和抽帧
  -> 输出 MP4 与质量报告
```

新闻正文是唯一事实依据。脚本生成不得加入站外推断、作者或媒体署名、发布建议、无关动画说明；标题优先保留原新闻标题的核心卖点。

## Agent Harness 与 Loop Engineering

`npm run video` 本身就是生产 harness，分为三道质量门：

1. Draft gate：检查原题保留、正式发布状态、5 屏与 5 段旁白、旁白长度、禁词、场景数据完整度；可调用 LLM judge 给出事实忠实度、标题吸引力、信息密度、视觉结构和 TTS 可读性评分。
2. Audio gate：检查 TTS 是否存在、时长是否接近目标、每段音频起点和场景边界是否逐帧对齐。
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
F5_TTS_NFE_STEP=16
F5_TTS_REF_AUDIO=F:\path\to\voice-reference.wav
F5_TTS_REF_TEXT=
F5_TTS_HF_OFFLINE=1
TTS_FIT_TARGET=1
```

- `F5_TTS_REF_AUDIO` 决定克隆音色，建议使用干净、单人、无背景音乐的中文语音。
- `F5_TTS_REF_TEXT` 应与参考音频逐字一致；已有转写时必须填写，避免串词。
- `F5_TTS_HF_OFFLINE=1` 强制使用本机 Hugging Face 缓存，避免生成时临时联网失败。
- `TTS_FIT_TARGET=1` 自动使用 FFmpeg 将各段语音统一调整到目标时长。
- F5 失败时直接停止，不会偷偷换成低质量系统语音。

依赖本机已安装 FFmpeg、FFprobe、Python F5-TTS 环境，并已缓存 `SWivid/F5-TTS` 和 `charactr/vocos-mel-24khz`。

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

# 生成 html-video compatible content graph 并渲染
npm.cmd run render:html-video

# 类型检查
npm.cmd run lint:types
```

项目还保留模板注册表与 html-video compatible content graph，可让同一份 `VideoProject` 选择 Remotion 批量渲染或 HTML Video 精修模板。

## 安全约定

- 不提交真实 API key、账号密码、`.env.local` 或 `*.local.json`。
- 不提交生成的 MP4、WAV、网页截图、质量运行目录或运行时反馈。
- example 配置只保留 `xxx` 占位符。
