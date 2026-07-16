# 持久化格式迁移

Scene Gen 的 run journal、媒体缓存 metadata、production report 和 HTML Video ContentGraph 都通过版本化 reader 读取。业务代码不应直接对这些文件执行类型断言或只调用当前 Zod Schema。

## 读取流程

统一读取顺序为：

1. 检查 JSON 是对象并读取版本字段；
2. 拒绝缺失、非整数或比当前程序更新的版本；
3. 按 `vN -> vN+1` 顺序执行纯迁移函数；
4. 使用当前版本 Zod Schema 校验迁移结果；
5. 需要落盘时先保存 `.vN.bak`，再原子写入当前格式。

当前格式如下：

| 格式 | 当前版本字段 | 当前版本 | Reader |
| --- | --- | --- | --- |
| run journal | `specVersion` | 2 | `readRunJournal()` |
| media cache metadata | `metadataVersion` | 2 | `readMediaCacheMetadata()` |
| production report | `specVersion` | 2 | `readProductionReport()` |
| ContentGraph | `specVersion` | 2 | `readHtmlVideoContentGraph()` |

媒体缓存的 `identityVersion` 与 `metadataVersion` 分离。metadata 字段布局升级不改变缓存内容身份或 cache key；只有真正影响音频或视频输出的 identity 规则变化时才升级 `identityVersion`。

## Run 升级

普通 resume 打开旧 `run.json` 时会自动备份并升级 journal。若要在恢复前显式迁移 journal、manifest 引用的 ContentGraph 和 production report，运行：

```powershell
npm.cmd run scene-gen -- migrate "<run-id>"
```

使用 `--json` 可查看每个文件的原版本、目标版本和备份路径。重复执行是幂等的，当前版本文件不会再次生成备份。

## 新增版本

升级持久化格式时：

- 保留当前版本 Schema，并新增下一版本 Schema；
- 只增加一个 `vN -> vN+1` 迁移函数，不编写跨版本跳跃；
- 将迁移函数登记到对应 reader；
- 添加真实 N-1 fixture 和迁移后 Schema 测试；
- 添加不可迁移未来版本的友好错误测试；
- 确认写回前生成备份，并验证第二次迁移不产生变化；
- 缓存 metadata 变化与 identity/cache key 变化必须分别评估。

旧 fixture 位于 `tests/fixtures/persistence/`，不得随着当前 Schema 更新而覆盖，它们用于保证历史文件长期可读。
