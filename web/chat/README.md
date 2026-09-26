# web/chat — 对话界面

职责：需求输入、附件、消息流展示、方案选择与结果查看；提供 Codex / Claude 提供方选择。

对应文档：[架构 §3](../docs/architecture.md)、[协议 §对话请求](../docs/protocol.md)。

## 待实现

- [ ] 提供方选择（切换提供方创建新会话）。
- [ ] 消息发送与 NDJSON 流式读取（`session`/`progress`/`text`/`error`/`done`）。
- [ ] 会话恢复（带上响应中的 `sessionId`）。
- [ ] busy 保护：同一会话两条消息串行执行或返回 busy。

说明：当前适配器输出消息级文本，不承诺逐 token；错误以 `error` 事件 + `done.status=failed` 呈现。
