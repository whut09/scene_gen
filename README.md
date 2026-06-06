# Scene Gen

AI 新闻程序化视频工厂。它的目标不是做一条“今日总结”，而是把热点新闻、网页、GitHub、Hacker News 或指定 URL，自动拆成可视化短视频项目，并渲染为竖屏 MP4。

## 工作原理

核心流程：

```text
新闻源 / URL
  -> 抓正文、热度、网页截图
  -> 大模型生成或优化口播与结构化场景
  -> React / Remotion / 浏览器渲染画面
  -> TTS 生成配音
  -> FFmpeg 导出 1080x1920 MP4
```

工程里有两套互补流程：

- 根目录 Remotion 批量流程：适合一次抓多个热点，输出多条独立视频到 `dist/stories/`。
- `glasswing-web-video/presentation` 网页视频流程：适合精修单条新闻，做成点击驱动/自动导出的竖屏网页视频。

## 大模型配置

提交到仓库的是占位配置：

```text
config/llm.example.json
.env.example
```

真实 key 只放本地文件，不会提交：

```text
config/llm.local.json
.env.local
glasswing-web-video/presentation/config/llm.local.json
glasswing-web-video/presentation/.env.local
```

配置格式：

```json
{
  "OPENAI_API_KEY": "xxx",
  "OPENAI_BASE_URL": "https://deepkey.top/v1",
  "OPENAI_MODEL": "gpt-5.5",
  "OPENAI_TTS_MODEL": "gpt-4o-mini-tts",
  "OPENAI_TTS_VOICE": "alloy",
  "TTS_PROVIDER": "openai"
}
```

所有能用大模型的地方都会优先读取本地配置：

- `src/pipeline/llm.ts`：优化热点视频标题和口播。
- `src/pipeline/tts.ts`：OpenAI 兼容 TTS。
- `glasswing-web-video/presentation/scripts/news-url-to-brief.ts`：URL 新闻转结构化视频方案。

## 安装

```powershell
npm.cmd install
cd glasswing-web-video\presentation
npm.cmd install
```

需要本机可用：

- Node.js
- Python
- `edge-tts`：`python -m pip install edge-tts`
- FFmpeg / FFprobe
- Microsoft Edge，供 Playwright 截图和录制

## 根目录批量热点流程

热点源配置在：

```text
config/sources.json
```

生成热度最高的 3 条新闻项目：

```powershell
npm.cmd run generate:stories -- --count 3 --screenshots 1
```

额外指定一个网页作为输入：

```powershell
npm.cmd run generate:stories -- --url "https://example.com/news" --count 3
```

渲染视频：

```powershell
npm.cmd run render:stories
```

一键生成并渲染：

```powershell
npm.cmd run make
```

输出：

```text
dist/stories/*.mp4
public/generated/stories/*.json
public/generated/screenshots/*.png
```

## Glasswing 竖屏网页视频流程

进入子项目：

```powershell
cd glasswing-web-video\presentation
```

本地预览：

```powershell
npm.cmd run dev -- --port 5174
```

打开：

```text
http://127.0.0.1:5174/
http://127.0.0.1:5174/?auto=1
```

生成更快的中文配音：

```powershell
npm.cmd run tts:edge
```

可调音色和语速：

```powershell
$env:EDGE_TTS_VOICE="zh-CN-YunyangNeural"
$env:EDGE_TTS_RATE="+18%"
npm.cmd run tts:edge
```

直接导出竖屏 MP4：

```powershell
npm.cmd run export:mp4
```

输出：

```text
glasswing-web-video/presentation/exports/glasswing-vertical.mp4
```

## URL 新闻输入

在 Glasswing 子项目里运行：

```powershell
cd glasswing-web-video\presentation
npm.cmd run news:url -- "https://www.anthropic.com/news/expanding-project-glasswing"
```

输出：

```text
glasswing-web-video/url-news/article.md
glasswing-web-video/url-news/story.json
glasswing-web-video/url-news/script.md
glasswing-web-video/url-news/outline.md
glasswing-web-video/presentation/public/assets/url-news-source.png
```

如果没有本地大模型配置，脚本仍会抓正文和截图，但会跳过 `story.json` / `script.md` / `outline.md` 的生成。

## 常用命令速查

```powershell
# 根目录批量热点
npm.cmd run generate:stories -- --count 3 --screenshots 1
npm.cmd run render:stories
npm.cmd run make

# Glasswing 单条精修
cd glasswing-web-video\presentation
npm.cmd run dev -- --port 5174
npm.cmd run news:url -- "https://example.com/news"
npm.cmd run tts:edge
npm.cmd run export:mp4
npm.cmd run build
```

## 安全约定

- 不提交真实 API key、账号密码、`.env.local`、`*.local.json`。
- 不提交生成的视频、音频、截图和 `node_modules`。
- 提交版配置全部使用 `xxx` 占位，本地文件用于实际运行。
