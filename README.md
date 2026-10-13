# 仿真反馈驱动的空间自主设计

通过网页对话调用本地 Cursor SDK、Codex app-server 或 Claude CLI，读取 DXF、生成候选平面，并利用日照分析反馈改进方案。

## 当前交付

本次是 **架构基线与可运行对话骨架**，不是完整的空间生成或仿真产品。

| 能力 | 当前状态 |
| --- | --- |
| 架构图、执行时序图、工程设计文档 | 已落盘 |
| Express、网页对话、会话文件保存 | 已实现骨架 |
| Cursor / Codex / Claude 本机 Agent 与事件适配 | 已实现，需对应本机运行时与登录；Echo 可离线使用 |
| DXF 解析、平面生成 | 交给 Agent；产品化输入、模型验证与结果展示待实现 |
| 浏览器工具调用桥与日照 Worker | 协议已定义，执行能力待实现 |
| 热环境、声环境 | 接口预留，未启用 |

架构图中的计算闭环是目标架构，以上状态表描述当前代码。

![目标架构](docs/diagrams/architecture.svg)

## 文档

- [工程架构设计](docs/architecture.md)
- [CLI 与浏览器工具协议](docs/protocol.md)
- [分阶段实施与验收](docs/roadmap.md)
- [架构图 SVG](docs/diagrams/architecture.svg) / [Mermaid 源文件](docs/diagrams/architecture.mmd)
- [日照反馈时序图源文件](docs/diagrams/sequence.mmd)

## 本地运行

要求 Node.js 22+。选择的 Agent CLI 必须在终端可用并已登录；应用复用 CLI 现有登录，不在网页存储模型密钥。

```sh
npm install
npm run check
npm test
npm start
```

打开 http://127.0.0.1:4317 。网页默认使用 Codex（本机），也可选择 Cursor、Claude 或 Echo。切换提供方时创建新会话；恢复已有会话时沿用该会话的提供方。

可将 `server/.env.example` 复制为 `server/.env` 修改端口、CLI 路径与模型。应用默认绑定本机回环地址，当前定位为单用户本地工具。

Codex 复用本机登录并自动运行独立任务。默认优先使用桌面应用自带的运行时，回退到 PATH 中的 `codex`；可设置 `CODEX_PATH`。`CODEX_MODEL` 留空时沿用本机模型配置，`MODEL` 非空则覆盖任务模型。详见 [提供方接入说明](server/providers/README.md)。

```sh
curl -N http://127.0.0.1:4317/api/chat \
  -H 'Content-Type: application/json' \
  -d '{"provider":"codex","message":"请说明你可以如何辅助平面空间设计"}'
```

响应为 NDJSON。后续请求带上响应中的 `sessionId` 即可恢复对应 CLI 会话。CLI 调用会使用该 CLI 的模型服务并产生正常用量。

## 工程结构

```text
web/                   对话页面与浏览器执行能力入口
server/                Express、CLI 进程、事件归一化、会话保存
agent/instructions.md  空间设计任务约定
shared/                仿真能力注册表与契约
docs/                  架构、协议、里程碑和图件
scripts/               工程检查
tests/                 提供方事件与命令边界验证
workspaces/<id>/       会话记录、输入、方案、仿真结果
```

`workspaces` 和 `.env` 不进入版本管理。每个会话使用独立目录；目录分隔不是操作系统沙箱，文件访问仍由 CLI 自身权限管理。
