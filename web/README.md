# web — 对话页面与浏览器执行能力入口

职责：承载对话与文件界面、几何/结果查看，以及在浏览器内执行的仿真 Worker 入口。

对应文档：[架构 §3/§8](../docs/architecture.md)、[协议](../docs/protocol.md)。

## 子模块

| 目录 | 职责 | 状态 |
| --- | --- | --- |
| `chat/` | 对话界面与 Codex/Claude 提供方选择 | M0 骨架 |
| `files/` | DXF 上传与文件登记界面 | 规划（M1） |
| `viewer/` | 平面预览、分析模型、日照图、时间轴 | 规划（M1/M2） |
| `simulation/` | 工具分发器与日照/热/声 Worker | 规划（M2–M4） |

## 约束

- 对话响应为 NDJSON，用 HTTP fetch 读取 POST 响应流，不是对 POST 使用 EventSource。
- 上传文件与 Agent 输出按数据处理，文本用 textContent 展示。
