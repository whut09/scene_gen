# OpenMontage-inspired production layer

本层借鉴的是“先规划生产方式，再选择工具”的思想，不复制第三方模板或实现。

## 数据流

~~~text
VideoProject
  -> Visual Planner
  -> Provider Registry
  -> ContentGraph visualPlan + syncCues
  -> Remotion / HTML Video
  -> motion quality gate
  -> production-report.json
~~~

## 当前边界

第一阶段完成供应商注册、确定性视觉规划、降级策略、关键词同步接口、运动质量检查和决策报告。真实素材下载及生成式视频调用保持 provider adapter 边界，只有配置对应密钥后才会启用；默认流水线仍可完全本地运行。

## 扩展 Provider

在 `src/production/provider-registry.ts` 注册能力、质量、成本、延迟、竖屏和商用属性。视觉规划器只依赖能力类型，不依赖某个具体厂商。后续接入素材下载器时，应把许可证、来源 URL 和本地缓存路径补入 production report。

## 质量指标

- 视觉来源多样性：五屏以上只有一种来源时报警。
- 同步关键词：每屏至少两个可与旁白对应的 cue。
- 运动采样：FFmpeg 以 2 fps 生成帧摘要，计算唯一帧比例、静态转移比例和最长静止时长。
- 事实证据：沿用 ContentGraph 的 sourceEvidence，未核验数字仍会阻断渲染。


## GitHub asset adapter

`src/production/github-assets.ts` 从 README 提取非 badge 图片，解析相对路径并下载到本地公共资产目录。模板消费本地路径，避免渲染时依赖远程网络。资产报告保留 source URL 和许可证提示，发布前仍应核对上游仓库许可证及图片权利。

## Scene-level motion diagnosis

最终 MP4 以 2 fps 计算场景变化分数，再按 narration 对齐后的场景时长切片。报告同时给出每屏有效运动比例和最长低运动区间，使模板动画可以按屏局部修改并复用其他缓存片段。
