# server — 本机 Node.js 服务

职责：Express 承载 HTTP 与本地 Agent CLI 调用；管理会话、文件访问、浏览器任务交接。默认仅监听 `127.0.0.1`，定位单用户本地工具。

对应文档：[架构 §3/§4/§5](../docs/architecture.md)、[协议 §HTTP](../docs/protocol.md)。

## 子模块

| 目录 | 职责 | 状态 |
| --- | --- | --- |
| `providers/` | Codex / Claude CLI 适配器与事件归一化 | M0 骨架 |
| `sessions/` | 会话文件持久化与恢复 | M0 骨架 |
| `files/` | DXF 上传登记、artifact 受控访问 | 规划（M1） |
| `browser-bridge/` | handoff 读取、任务记录、结果回传校验与自动续跑 | 规划（M3） |

## HTTP 接口

| 接口 | 状态 |
| --- | --- |
| `GET /api/status` | 当前 |
| `POST /api/chat` | 当前 |
| `GET /api/sessions/:id` | 当前 |
| `POST /api/uploads` | 规划 |
| `GET /api/artifacts/:id` | 规划 |
| `POST /api/tool-results` | 规划 |

## 待实现

- [ ] 入口：Express app、静态资源、路由挂载。
- [ ] 会话内消息串行执行 / busy 保护。
- [ ] 上传与 artifact 的路径越界校验。
- [ ] 浏览器任务交接与自动续跑（见 `browser-bridge/`）。

注意：提供方、可执行文件与模型由受控配置决定；不拼接用户输入为 shell 命令（`spawn` 用参数数组、`shell:false`）。
