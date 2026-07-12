# HTML Video Integration

Scene Gen 保留两条渲染路径：

- HTML Video：一键命令默认的质量优先路径。每个场景独立选择 HTML 模板，用 Playwright 录制，再由 FFmpeg 精确拼接和混音。
- Remotion：速度优先路径。适合批量预览、快速迭代和大规模热点测试。

## 借鉴范围

本实现借鉴 nexu-io/html-video 的公开架构思想：模板 metadata、ContentGraph、场景级引擎/模板选择、动画冻结、字体等待、lead-in 裁剪和显式时长尾帧补齐。Scene Gen 的模板和适配代码均为本仓库重新实现，没有复制上游模板内容。

上游项目使用 Apache-2.0，来源和说明见仓库根目录 THIRD_PARTY_NOTICES.md。

## 模板协议

模板定义位于：

~~~text
src/templates/
  template.schema.ts
  template-registry.ts
  bold-signal/
  kinetic-title/
  news-blue-board/
  editorial-stat-grid/
  nyt-data-chart/
  product-style-agent-flow/
  decision-flow/
~~~

每个模板声明：

- id、version、category、subcategory
- tags、bestFor、notFor
- supportedScenes、supportedIntents、dataDensity
- motionFamily、visualFamily
- 支持画幅、帧率和时长范围
- input schema
- license、provenance、commercialUse
- 性能等级和预计渲染开销

## 可解释模板路由

选择器不会再按 scene type 写死唯一模板。每个场景会综合计算：

1. 场景类型和视觉意图是否匹配。
2. 9:16 / 16:9 画幅是否支持。
3. 当前画面信息密度是否适配。
4. 场景时长是否位于模板建议范围。
5. 新闻标签、标题和摘要是否命中模板标签。
6. 是否与上一屏重复，整片是否重复使用过多。
7. 基于新闻标题的稳定扰动，让不同新闻在候选模板接近时产生可复现的变化。

选择结果写入 ContentGraph，包括 templateScore 和 templateReasons，方便质量报告解释为什么使用该构图。

## 动态布局变体

模板选择分成两层：先选择适合场景的模板，再根据新闻语义选择模板内部的 layoutVariant。当前会识别数学研究、Agent 编排、产品发布、性能数据、时间线和结论等信号。

例如同一个标题场景可以选择 research-stack、agent-split、launch-impact 或 final-signal；同一个数据场景可以选择 horizontal-bars、ranked-cards 或 delta-lanes。variantId 会写入 ContentGraph 和质量报告，模板加变体共同构成最终 composition id。

选择器为语义标签、scene type、信息密度和稳定内容哈希分别计分。哈希只用于候选项接近时产生可复现变化，不会覆盖内容适配分数。相邻模板重复和整片重复仍会受到惩罚。

## ContentGraph v2

生成 story 时同时写出：

~~~text
public/generated/html-video/<story-slug>/content-graph.json
~~~

节点包含：

~~~json
{
  "id": "scene-03",
  "sceneType": "signal_chart",
  "kind": "data",
  "intent": "comparison",
  "frameIntent": "animated-comparison-chart",
  "templateId": "nyt-data-chart",
  "templateScore": 88.37,
  "templateReasons": ["supports signal_chart", "intent comparison"],
  "durationSec": 18
}
~~~

边支持 sequence、contrast、dependency。渲染前会验证节点、边、模板和时长，并按 dependency 做稳定拓扑排序。

## 渲染稳定性

HTML Video 路径现在执行以下协议：

1. 在页面解析前冻结 CSS 动画、transition 和 SVG SMIL 动画。
2. 等待 document.fonts.ready，并主动 load 已注册 FontFace。
3. 等待双 requestAnimationFrame 和一次布局读取，避免字体切换造成首帧跳动。
4. 探测 Web Animations 的有限时长，记录模板动画与场景时长的差异。
5. 字体准备完成后统一释放动画，这一刻才是真正动画 t=0。
6. 按录制起点计算 frozen lead-in，FFmpeg 裁剪时保留 120ms 安全余量。
7. 使用 tpad=stop_mode=clone 补足最后一帧，再按旁白场景时长精确裁剪。
8. 所有场景拼接后复用项目的同一条 F5-TTS 音轨。

## GitHub 项目输入

输入 github.com/<owner>/<repo> 时，抓取器会优先调用 GitHub Repository API 和 README raw API，而不是对网页导航结构做 Readability 摘要。VideoProject 会保存 repo、Stars、Forks、Issues、主语言、许可证和默认分支，LLM 按项目拆解模式生成标题、技能结构与工作流。

定性技能分类会自动选择 category-cards，不显示虚构百分比；只有来源中存在真实可比较数据时才使用柱状图。

## 匀速语音质量门

F5-TTS 的所有标题和正文统一使用 F5_TTS_UNIFORM_SPEED。每个音频片段都会把合成速度写入缓存 metadata，速度变化后必须重新合成，避免复用旧的快慢混合音频。

Audio gate 计算每屏实际字/秒、最大最小倍率、变异系数和首屏相对中位速度。默认最大倍率 1.35，变异系数 0.16；超过任一阈值会停止视频渲染。

## 一键使用

质量优先，默认 HTML Video：

~~~powershell
npm.cmd run video -- --url "https://example.com/news"
~~~

显式指定 HTML Video：

~~~powershell
npm.cmd run video:html -- --url "https://example.com/news"
~~~

速度优先，使用 Remotion：

~~~powershell
npm.cmd run video:remotion -- --url "https://example.com/news"
~~~

也可以在通用命令中传入：

~~~powershell
npm.cmd run video -- --url "https://example.com/news" --engine html-video
npm.cmd run video -- --url "https://example.com/news" --engine remotion
~~~

环境变量 VIDEO_RENDER_ENGINE 可以设为 html-video 或 remotion。

## 多样性质量门

Draft gate 会额外检查：

- 五屏至少使用三种模板。
- 相邻场景不得重复同一模板。
- 模板必须声明支持当前 scene type。
- 报告记录模板类别数、平均选择分、完整模板路径。

这些检查和新闻事实、旁白对齐、ASR 标题复听、音视频时长检查一起执行。

## 竖屏发布安全区与持续动效

HTML 模板统一使用 App 发布安全区，避免平台二次裁切、右侧点赞栏和底部标题栏遮挡正文：

- 左侧安全边距：96px
- 右侧操作栏预留：156px
- 顶部安全边距：138px
- 底部安全边距：150px
- 长标题通过 `headlineFontSize` 按字符长度降级字号，并允许中文和英文长词换行

模板中的列表、卡片和流程节点使用 `pacedDelay`，按场景旁白时长分散出现，而不是在前一秒全部完成。`commonHtml` 还提供贯穿场景的背景网格漂移、柔光扫过和卡片轻扫；这些动效只强化当前信息层级，不引入与内容无关的装饰对象。

发布前除常规首屏、中段、尾屏抽帧外，应在同一场景的早、中、晚三个时间点抽帧。若节点数量和画面像素均没有变化，则视为静态场景回归。

## 领域视觉模板

`investment-research` 为金融、价值投资和投研类项目提供独立视觉系统，不复用通用科技蓝主题：

- `shareholder-letter`：股东信封面、研究印章和行情带
- `market-tape`：真实数字比较与市场数据
- `thesis-war-room`：多视角观点对抗和研究卡片
- `verdict-ledger`：安装方式、适用边界和决策结论

模板路由检测 investment、finance、valuation、投研、投资、估值、巴菲特和芒格等领域语义，并增加领域适配分。相邻模板复用惩罚仍然生效，因此金融视频会混用股东信、研究档案、流程图和决策账簿，而不是五屏都使用同一种布局。

GitHub 项目标题在抓取阶段会去掉竖线后的多语言 SEO 描述、重复仓库名和过长介绍，保留“仓库名：核心描述”，避免标题和 TTS 被双语 README 描述污染。


## 按场景最小修订

质量问题会关联到 sceneIndex。某一屏失败时，harness 调用局部修订器，只替换对应 scene 和 narration segment；其他场景 JSON 保持不变。

手工修订第 3 屏（参数使用从 0 开始的 sceneIndex，因此第 3 屏传 2）：

```powershell
npm.cmd run video:revise -- --project "public/generated/stories/example.json" --scenes "2" --issues "修正该屏数字与旁白不一致"
npm.cmd run synthesize:story -- --project "public/generated/stories/example.json" --basename "narration-example"
npm.cmd run render:html-video -- --limit 1 --overwrite
```

F5-TTS 按 segment 文本和参考音色缓存。文本未变化的段落直接复用 WAV。HTML Video 按场景内容、模板 ID、模板版本和变体生成缓存键：

- 场景内容变化：只重新录制该场景。
- 只有音频导致场景时长发生毫秒级变化：复用旧场景并用 FFmpeg retiming。
- 模板版本升级：只失效使用该模板的场景。
- 场景和时长均未变化：直接复用 MP4。

GitHub 项目的标题模板会在封面安全区内以约 26-30px 的高对比字号显示 `github.com/owner/repo`，不要求旁白朗读网址。长地址允许在安全区内换行。
