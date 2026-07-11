# HTML Video Integration

本项目现在有两条视频渲染路径：

- `Remotion`：默认批量生产路径，速度快，适合日产和矩阵测试。
- `html-video-compatible`：HTML 模板精修路径，使用 Playwright 录制每个 HTML 场景，再用 FFmpeg 拼接和混音，适合把重点新闻做得更像成片。

## 模板层

模板定义在：

```text
src/templates/
  template.schema.ts
  template-registry.ts
  news-blue-board/
  nyt-data-chart/
  bold-signal/
  product-style-agent-flow/
```

每个模板包含：

- `id / name / description`
- `engine`
- `tags / bestFor / supportedScenes`
- `output`
- `inputs`
- `license`
- `renderHtml`

当前自动选择规则：

- `title / outro` -> `bold-signal`
- `signal_chart` -> `nyt-data-chart`
- `flow / github_pulse / timeline` -> `product-style-agent-flow`
- `briefing_points / news_stack / web_screenshot_zoom` -> `news-blue-board`

## Content Graph

生成新闻 story 时，会同时写出 html-video compatible content graph：

```text
public/generated/html-video/<story-slug>/content-graph.json
```

结构核心是：

```json
{
  "specVersion": 1,
  "engine": "html-video-compatible",
  "nodes": [
    {
      "id": "scene-01",
      "sceneIndex": 0,
      "sceneType": "title",
      "templateId": "bold-signal",
      "durationSec": 7,
      "data": {}
    }
  ],
  "edges": []
}
```

## 渲染命令

默认 Remotion 批量渲染：

```powershell
npm.cmd run render:stories
```

HTML Video 精修版渲染：

```powershell
npm.cmd run render:html-video -- --limit 1
```

默认不会覆盖 Remotion 产物，而是输出：

```text
dist/stories/<story>.html-video.mp4
```

如果确实要覆盖原 MP4：

```powershell
npm.cmd run render:html-video -- --limit 1 --overwrite
```

## 渲染细节

HTML Video 路径实现了这些来自 `nexu-io/html-video` 的关键工程点：

- Playwright / Chromium 录制 HTML 动画
- 字体加载等待
- 首帧动画冻结和释放
- FFmpeg 裁剪录制 lead-in
- 每个 scene 先独立渲染，再 concat
- 最后复用项目已有 TTS 音频混入 MP4

## F5-TTS

新闻生成阶段可以直接使用本地 F5-TTS：

```powershell
$env:TTS_PROVIDER="f5"
$env:F5_TTS_VENV="F:\codex\.venvs\scene_gen_f5_py39"
$env:F5_TTS_DEVICE="cuda"
npm.cmd run generate:stories -- --url "https://example.com/news" --count 1
```

或写入 `.env.local` / `config/llm.local.json`：

```text
TTS_PROVIDER=f5
F5_TTS_VENV=F:\codex\.venvs\scene_gen_f5_py39
F5_TTS_REF_AUDIO=F:\codex\.venvs\scene_gen_f5_py39\Lib\site-packages\f5_tts\infer\examples\basic\basic_ref_zh.wav
F5_TTS_REF_TEXT=参考音频逐字对应的真实文本
F5_TTS_SPEED=1.35
```

`generate:stories` 会把 F5-TTS 生成的 wav 写入 `public/generated/`，Remotion 和 HTML Video 渲染都会复用同一条音频。

F5-TTS 没有固定的 `voice=xxx` 音色列表。它的音色来自参考音频：

- `F5_TTS_REF_AUDIO`：8 到 15 秒、干净、无背景音乐的人声 wav/mp3。
- `F5_TTS_REF_TEXT`：这段参考音频逐字对应的文本。
- `F5_TTS_SPEED`：短视频建议 `1.30` 到 `1.45`，太高会吞字。

如果觉得默认音色难听，换一段更自然的中文参考音频，比继续调参数更有效。
