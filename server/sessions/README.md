# server/sessions — 会话持久化

职责：将每个会话的提供方、原生会话 ID 与对话记录保存到磁盘，支持页面重新打开后恢复。

对应文档：[协议 §工作目录](../docs/protocol.md)、[架构 §8](../docs/architecture.md)。

## 约定

- 每个会话一个独立目录：`workspaces/<sessionId>/session.json`。
- `session.json`：提供方、原生会话 ID、对话记录（当前为整体文件）。
- 会话内消息串行执行，避免两个 CLI 同时修改同一目录。
- Express 重启后从磁盘恢复；运行中任务标记 `interrupted`，不宣称内存任务自动恢复。

## 待实现

- [ ] 会话创建 / 恢复 / provider 绑定（既有会话不接受变更 provider）。
- [ ] 原子文件写入（先写临时文件再替换）。
- [ ] 后续可将对话从 `session.json` 拆为追加写入的 JSONL。
