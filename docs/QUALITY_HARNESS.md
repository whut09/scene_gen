# 质量 Harness

Harness 的职责不是在流程末尾给出一个布尔值，而是持续记录证据、定位失败阶段，并计算最小修复范围。

## Issue 协议

所有质量问题使用结构化字段：

```ts
interface QualityIssue {
  code: string;
  stage: string;
  severity: "warning" | "error" | "blocked";
  sceneIndex?: number;
  evidence: unknown;
  repairAction: string;
  retryable: boolean;
}
```

Issue code 由注册表维护，同时声明默认分类、修复动作、是否可重试和 evidence schema。不要通过中文错误消息的正则表达式推断场景编号或修复策略。

## Draft Gate

脚本门禁覆盖：

- 标题、首屏和内容类型规则；
- `FactLedger` 引用、数字、单位、时间、主体和限定词；
- 新闻、技术文章和开源项目的差异化要求；
- 开源项目名称、用途、用户问题、社区数据和平台合规文本；
- 场景重复、旁白重复、标题重复播报和无效套话；
- 预计时长、语速、信息密度和视觉可实现性；
- LLM Judge 的 measured、partially-measured、unavailable 状态。

确定性规则可以直接否决候选。Judge 不可用时不会伪造 100 分；strict/production 按配置阻止发布或要求人工确认。

## Audio Gate

音频门禁分为三层，避免把 ASR 转写等同于真实发音。

### Structural

- 文件存在且可读取；
- WAV 采样率、声道和格式正确；
- 时长、静音、削波和响度在范围内；
- 分段与 concat 时间线连续；
- 首尾没有异常残音或被截断的语音。

结构检查失败时不会继续调用 ASR。

### Semantic

- token coverage 和 precision；
- 实体、数字、百分比、版本号；
- 首屏标题完整性；
- 相邻场景串音和重复播报；
- 同一视频的语言与音色一致性证据。

Semantic gate 不产生确定性的声调错误。Whisper 即使输出了正确汉字，也不能证明多音字读音正确。

### Pronunciation

Pronunciation gate 只验证 `PronunciationPlan` 中 medium/high risk 的 span。确定的 `audio_pronunciation_mismatch` 必须携带实际音素或等价声学证据；没有 `actualPinyin`、对齐失败、低置信度或 verifier 不可用时只能产生 `verification_inconclusive`。

高风险缩写必须进入受保护的 Provider 合成计划。例如 IndexTTS2 中的 `AI` 会被拆成独立合成单元，避免中文上下文吞音或连读。ASR 转写正确不能替代该前置保护。

## Video Gate

视频门禁同时检查媒体结构、DOM 和实际帧：

- H.264/AAC 流、尺寸、帧率和总时长；
- 场景开头、中间和结尾抽帧；
- 亮度方差、边缘密度和关键 DOM 状态；
- 安全区、字号、对比度、裁切、遮挡和溢出；
- 标题、关键结论和数字的可见性；
- 动画完成时间和结论停留时间；
- 旁白关键词与视觉元素出现时间；
- 音视频流漂移和项目时长漂移。

空白帧不能只通过 JPEG 文件大小判断。Golden 测试使用 Playwright 固定 fixture 检查模板安全区和关键文本。

## 最小修复

典型 issue 路由如下：

| Issue | 最小动作 |
| --- | --- |
| `audio_pronunciation_mismatch` | 当前音频场景 + concat audio + remux |
| `audio_scene_drift` | 对应音频场景 + concat audio + remux |
| `blank_frame` | 当前视频场景 + concat video + remux |
| `scene_motion_too_static` | 当前模板/场景 + concat video + remux |
| `stream_duration_drift` | 仅 remux |
| `wrong_dimensions` | 全部视频场景 |
| 内容 JSON Patch | 按变更字段计算 audio/video dirty set |

强制重建音频必须产生至少一个真实 cache miss；只修复一段音频时不得删除其他场景缓存，也不得重新录制未变化的视频场景。

## Repair Candidate

修复器不是按固定 attempt 盲目升级，而是比较候选动作：

```text
utility = expectedSuccess
        - costWeight * estimatedCost
        - latencyWeight * estimatedDuration
        - riskWeight * affectedScope
```

候选记录预期成功率、成本、耗时、场景范围、风险和证据置信度。例如时长漂移优先 remux；只有证据指向场景文件错误时才重渲染。

## No-progress 与预算

无进展检测比较项目或音频 hash、issue 集合、结构化 evidence 和评分变化。连续无进展时依次尝试更具体约束、替换 revision prompt、切换模板 variant、切换 Provider、扩大 dirty scope、全局重规划和人工确认。

每个 run 还限制：

- 最大 LLM token；
- 最大 TTS 重建场景数；
- 最大渲染分钟数；
- 最大预计成本；
- 每个 issue code 的最大修复次数。

策略轨迹和预算写入 `dist/runs/<run-id>/loop/`，resume 不会重复已经失败的同一策略。

## 反馈学习

用户反馈记录作用域、指纹、试用次数、成功/失败次数、最后应用时间、效果分、过期时间和冲突关系。选择器使用平滑成功率和时间衰减，避免把全部历史要求无差别注入 prompt。

完整协议见 [FEEDBACK_LEARNING.md](FEEDBACK_LEARNING.md) 和 [LOOP_GOVERNANCE.md](LOOP_GOVERNANCE.md)。
