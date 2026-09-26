# shared/contracts — 能力注册表与工具契约

职责：登记能力状态、工具调用契约与统一事件信封。

对应文档：[架构 §9](../docs/architecture.md)、[协议](../docs/protocol.md)。

## 待实现

- [ ] 能力注册表：`sunlight.enabled=false`（未实现不返回假指标）、`thermal`/`acoustics` 预留。
- [ ] 工具契约：`sunlight.run` 等（`tool`、`revisionId`、`modelPath`、`configPath`）。
- [ ] 统一事件契约：`session` / `text` / `progress` / `error` / `done`。
- [ ] 结果信封与各专业 schema 分列；未实现能力返回 `CAPABILITY_NOT_IMPLEMENTED`。

说明：室内混响与房间间隔声分别定义能力；热环境复用会话、版本、任务与证据契约但保留独立 schema。
