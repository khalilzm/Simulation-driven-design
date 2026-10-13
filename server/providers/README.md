# server/providers — 本机 Agent 适配器

职责：把 Cursor SDK、Codex app-server、Claude CLI 和离线 Echo 统一为同一套事件，维护原生会话 ID，管理取消与退出。实现位于 `server/src/providers/`。

对应文档：[架构 §4](../../docs/architecture.md)、[协议 §提供方适配](../../docs/protocol.md)。

## 命令构造（受控配置决定，不拼接用户输入）

| 提供方 | 首轮 | 后续轮次 |
| --- | --- | --- |
| Cursor | SDK `Agent.create` | SDK `Agent.resume` |
| Codex | `codex app-server --listen stdio://`，RPC `thread/start`、`turn/start` | 新连接 RPC `thread/resume`、`turn/start` |
| Claude | `claude -p --output-format stream-json --verbose` | 增加 `--resume <session_id>` |

## 事件归一化

统一事件：`session`、`text`、`progress`、`error`、`done`。

| 统一事件 | Codex | Claude |
| --- | --- | --- |
| native_session | `thread/start` 或 `thread/resume` 返回的 `thread.id` | `system/init` 或带 session_id 的消息 |
| text | `item/agentMessage/delta` + `item/completed`，去重最终消息 | `assistant.message.content` 的 text |
| progress | commentary、动态文件工具调用、连接重试 | `tool_use` |
| completion | `turn/completed` 且 `status=completed` | `result` 且 `is_error=false` |
| error | RPC 错误、异常退出、失败或中断的 turn | `result` 且 `is_error=true` |

## Codex 本机登录与工具

选择 **Codex（本机）** 后，服务端自动优先寻找 macOS 桌面应用附带的 Codex 可执行文件，找不到则使用 PATH 中的 `codex`。可在 `server/.env` 设置 `CODEX_PATH`。需要支持 app-server 实验性动态工具接口的较新版本；已验证桌面运行时 `0.162.0-alpha.2`。

通过官方 [app-server 协议](https://learn.chatgpt.com/docs/app-server)复用本机登录与配置，`account/read` 确认登录状态。没有登录时先在 Codex 中登录或运行 `codex login`。不读取、复制或通过网页传递凭证。`CODEX_MODEL` 留空时继承本机模型配置；显式任务模型优先，其次为 `CODEX_MODEL`。`MODEL` 是现有的所有提供方通用任务覆盖配置。

每次生成运行独立原生任务，后续轮次用保存的原生 ID 恢复；不会把请求发到当前 Codex app 对话。原生进程使用只读环境并关闭 shell、网络搜索及外部连接，模型只通过动态 `sdd_read_file` / `sdd_write_file` 访问任务目录内的 JSON。客户端校验路径、符号链接、内容和大小，原子保存；住宅策略任务不开放任何文件工具，草图首次识别只允许写入。图片通过原生 image 输入传递。

输出只转发最终答复；commentary 作为进度，内部推理不转发。取消调用 `turn/interrupt` 并关闭进程；未开放的权限请求直接拒绝并停止任务。

约束：`spawn` 使用参数数组和 `shell:false`；提示通过标准输入传递。
