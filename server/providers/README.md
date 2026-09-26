# server/providers — CLI 适配器

职责：把 Codex 与 Claude 两种本地 CLI 统一为同一套事件，维护各自的原生会话 ID，管理子进程退出。

对应文档：[架构 §4](../docs/architecture.md)、[协议 §提供方适配](../docs/protocol.md)。

## 命令构造（受控配置决定，不拼接用户输入）

| 提供方 | 首轮 | 后续轮次 |
| --- | --- | --- |
| Codex | `codex exec --json --sandbox workspace-write --skip-git-repo-check -` | `... resume --json --skip-git-repo-check <thread_id> -` |
| Claude | `claude -p --output-format stream-json --verbose` | 增加 `--resume <session_id>` |

## 事件归一化

统一事件：`session`、`text`、`progress`、`error`、`done`。

| 统一事件 | Codex | Claude |
| --- | --- | --- |
| native_session | `thread.started` | `system/init` 或带 session_id 的消息 |
| text | `item.completed` / `agent_message` | `assistant.message.content` 的 text |
| progress | `command_execution` / `file_change` / `mcp_tool_call` | `tool_use` |
| completion | `turn.completed` | `result` 且 `is_error=false` |
| error | `error` / `turn.failed` | `result` 且 `is_error=true` |

## 待实现

- [ ] `codex.js`、`claude.js` 适配器与共用 spawn 封装。
- [ ] 事件归一化：忽略 reasoning/thinking，不转发内部推理块。
- [ ] 精确会话恢复（应用 sessionId 与 CLI 原生会话 ID 分开保存）。
- [ ] 不自动加入跳过权限/沙箱参数，沿用 CLI 有效权限。

约束：`spawn` 使用参数数组和 `shell:false`；提示通过标准输入传递。
