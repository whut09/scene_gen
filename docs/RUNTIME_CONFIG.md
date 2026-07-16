# RuntimeConfig

Scene Gen 在 CLI 启动时只构造一次 `RuntimeConfig`。profile 默认值与当前进程环境变量在这一边界合并，随后通过 Zod 完成类型、范围和枚举校验，并递归冻结。业务阶段不再通过修改全局 `process.env` 传递配置。

## 配置结构

`RuntimeConfig` 按职责划分为：

- `llm`：新闻生成、质量 judge 与修订模型；
- `tts`：provider、OpenAI TTS、F5 worker、并发、超时和拟合策略；
- `asr`：Python、模型、语言与验证阈值；
- `rendering`：引擎、输出目录、HTML 并发、FFmpeg preset、OCR 和视觉阈值；
- `quality`：质量 profile、时长和语速门槛；
- `cache`：内容寻址缓存、Hugging Face 缓存和锁策略；
- `retry`：loop 次数与阶段超时。

阶段函数通过参数或运行上下文读取同一个不可变对象。Node 子进程通过 `SCENE_GEN_RUNTIME_CONFIG` 接收序列化后的完整配置，并在启动时再次执行 Schema 校验；这只是进程边界协议，不作为业务模块的逐项环境变量配置接口。

## Journal 与恢复

新 run 会在 `dist/runs/<run-id>/run.json` 写入：

- 脱敏后的 `runtimeConfig` snapshot；
- 稳定排序后计算的 SHA-256 `runtimeConfigHash`；
- 显式覆盖产生的 `configOverrides` 哈希历史。

API key 不写入 journal。resume 会从 snapshot 恢复所有非密钥行为配置，并从当前安全环境重新注入密钥。即使 `.env` 或 profile 后来发生变化，普通 resume 仍使用原 run 的配置。

以下命令会被拒绝，因为它会隐式改变原 run：

```powershell
npm.cmd run scene-gen -- resume "<run-id>" --screenshots 3
```

如确实需要改变配置，必须显式确认：

```powershell
npm.cmd run scene-gen -- resume "<run-id>" --override-config --profile production --screenshots 3
```

覆盖后的 snapshot、hash 和前后哈希会原子写回 journal，便于审计。

## 缓存身份

音频和视频缓存 key 的 provider、model、speed、NFE、渲染 preset、尺寸和并发无关的渲染身份等字段应从 `RuntimeConfig` 或其明确的身份子集构造，不能再次读取环境变量。这样新增配置字段时，Schema、journal 和缓存身份可以在同一类型边界审查，减少漏掉失效条件的风险。

## 开发约束

- 只有 CLI、配置加载器和外部进程适配器可以接触原始环境变量；
- 新阶段应显式接收 `RuntimeConfig`，或使用已经建立的运行上下文；
- 不得修改已构造的配置对象；需要 run 级覆盖时创建新的验证后副本；
- 新增影响输出的配置时，同时更新 Zod Schema、snapshot 恢复测试和对应缓存 key 测试；
- 新增密钥字段时，必须在 `runtimeConfigSnapshot()` 中脱敏。
