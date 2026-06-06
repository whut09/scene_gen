# Glasswing Web Video Presentation

这是一个基于网页渲染的 9:16 竖屏短视频项目。当前示例视频来自 Anthropic 官方新闻 `Expanding Project Glasswing`，输出为适合 App 发布的 `1080x1920` MP4。

## 工作原理

```text
新闻文章 / URL
  -> 抓正文和网页截图
  -> 大模型生成 story.json / script.md / outline.md
  -> React 章节组件按 step 渲染画面
  -> edge-tts 合成每屏配音
  -> Playwright 录制 1080x1920 页面
  -> FFmpeg 合成最终 MP4
```

每个章节位于：

```text
src/chapters/<NN>-<id>/
  <Chapter>.tsx
  <Chapter>.css
  narrations.ts
```

`narrations.ts` 是 step 数和配音文本的唯一真相源。

## 配置

提交版配置：

```text
config/llm.example.json
.env.example
```

本地真实配置：

```text
config/llm.local.json
.env.local
```

本地配置会被 `.gitignore` 忽略。示例：

```json
{
  "OPENAI_API_KEY": "xxx",
  "OPENAI_BASE_URL": "https://deepkey.top/v1",
  "OPENAI_MODEL": "gpt-5.5"
}
```

## 安装

```powershell
npm.cmd install
python -m pip install edge-tts
```

还需要本机有 FFmpeg / FFprobe 和 Microsoft Edge。

## 本地预览

```powershell
npm.cmd run dev -- --port 5174
```

浏览器打开：

```text
http://127.0.0.1:5174/
```

自动播放入口：

```text
http://127.0.0.1:5174/?auto=1
```

进入自动播放页后，按空格开始。

## 生成配音

默认使用 Microsoft Edge TTS：

```powershell
npm.cmd run tts:edge
```

可调音色和语速：

```powershell
$env:EDGE_TTS_VOICE="zh-CN-YunyangNeural"
$env:EDGE_TTS_RATE="+18%"
$env:EDGE_TTS_PITCH="+0Hz"
npm.cmd run tts:edge
```

输出：

```text
public/audio/<chapter-id>/<step>.mp3
```

## 直接导出视频

```powershell
npm.cmd run export:mp4
```

输出：

```text
exports/glasswing-vertical.mp4
```

导出脚本会自动：

- 确认本地 dev server 可用，不可用时自动启动。
- 按所有章节音频时长逐屏录制。
- 用 FFmpeg 合成音轨和画面。
- 输出 H.264/AAC 的 MP4。

## 输入新闻 URL

```powershell
npm.cmd run news:url -- "https://example.com/news"
```

输出到：

```text
../url-news/article.md
../url-news/story.json
../url-news/script.md
../url-news/outline.md
public/assets/url-news-source.png
```

如果本地没有大模型配置，仍会生成 `article.md` 和网页截图，但不会生成结构化视频方案。

## 常用命令

```powershell
npm.cmd run dev -- --port 5174
npm.cmd run news:url -- "https://example.com/news"
npm.cmd run tts:edge
npm.cmd run export:mp4
npm.cmd run build
```

## 发布建议

成片已经是 `1080x1920` 竖屏，可以直接投放到抖音、视频号、小红书、B 站竖屏或其它 App。发布前建议检查：

- 前 3 秒标题是否足够抓人。
- 口播速度是否适合平台。
- 官方网页截图是否足够清楚。
- 最后一屏观点是否有转发价值。
