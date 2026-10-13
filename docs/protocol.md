# CLI 与浏览器工具协议

版本 0.1，2026-09-25。`当前` 为骨架已实现，`规划` 为后续接口，不应当作现有能力调用。

## HTTP

| 接口 | 状态 | 内容 |
| --- | --- | --- |
| GET /api/status | 当前 | 提供方列表、能力状态 |
| POST /api/chat | 当前 | provider、message、可选 sessionId；返回 NDJSON |
| GET /api/sessions/:id | 当前 | 已保存消息与原生会话标识 |
| POST /api/uploads | 规划 | 上传 DXF，返回会话内文件引用 |
| GET /api/artifacts/:id | 规划 | 已登记模型、图像、结果文件 |
| POST /api/tool-results | 规划 | 浏览器任务结果回传与自动续跑 |

首期使用 HTTP fetch 读取 POST 响应流；不是对 POST 使用浏览器 EventSource。图纸解析没有单独后端接口。

## 对话请求

```json
{"provider":"codex","sessionId":"可省略的UUID","message":"生成三个平面方案"}
```

provider 仅允许 codex 或 claude。sessionId 不传则创建新会话；既有会话不接受变更 provider。

```jsonl
{"type":"session","sessionId":"UUID","provider":"codex"}
{"type":"progress","message":"正在启动本地 CLI"}
{"type":"text","text":"我需要先了解功能需求。"}
{"type":"done","status":"completed"}
```

错误使用 `error` 事件，最后 `done.status=failed`。非零进程退出、终态错误和没有正常完成事件均视为失败。当前适配器输出消息级文本，不承诺逐 token。

## 提供方适配

应用 sessionId 与原生会话 ID 分开保存。Codex app-server 的 `thread/start` / `thread/resume` 返回 `thread.id`，Claude 返回 `session_id`，Cursor SDK 返回 `agentId`；这些 ID 只用于本提供方。

| 统一事件 | Codex | Claude |
| --- | --- | --- |
| native_session | thread/start 或 thread/resume 的响应 | system/init 或带 session_id 的消息 |
| text | item/agentMessage/delta、item/completed（最终答复去重） | assistant.message.content 的 text |
| progress | commentary、item/tool/call（受控 JSON 文件工具） | tool_use |
| completion | turn/completed 且 status=completed | result 且 is_error=false |
| error | error、RPC 错误、失败的 turn、异常退出 | result 且 is_error=true |

忽略 reasoning / thinking 等内部块。未知事件保留兼容空间，不直接把 stdout 当普通回复。

## 浏览器计算请求（规划）

Agent 将以下描述写入 `handoff/request.json` 后结束 CLI 轮次。服务端重新生成/校验 ID、解析会话内文件、冻结输入后派发；Agent 文件不是可信的执行授权。

```json
{
  "schemaVersion": "1",
  "tool": "sunlight.run",
  "revisionId": "rev-0003",
  "modelPath": "designs/rev-0003/model.json",
  "configPath": "designs/rev-0003/sunlight.json"
}
```

Express 建立的任务记录：

```json
{
  "schemaVersion": "1",
  "taskId": "由服务端生成",
  "sessionId": "所属会话",
  "revisionId": "rev-0003",
  "tool": "sunlight.run",
  "executor": "browser",
  "inputHash": "sha256:由服务端按冻结输入计算",
  "engineVersion": "待固定的浏览器引擎版本",
  "status": "waiting_browser"
}
```

哈希覆盖模型、环境遮挡、工况、测点规则、材料/透光假设、求解器版本。不能只对文件名求哈希。

## 结果回传（规划）

```json
{
  "schemaVersion": "1",
  "taskId": "匹配请求",
  "sessionId": "匹配会话",
  "revisionId": "rev-0003",
  "inputHash": "匹配冻结输入",
  "status": "completed",
  "metrics": {
    "unit": "hour",
    "sensorCount": 0,
    "targetAreaRatio": null
  },
  "artifacts": [],
  "verification": {"status":"needs_review","checks":[]}
}
```

这是字段示例，不是实际计算结果。真实 completed 结果必须包含有效测点与数值，schema 校验应拒绝无测点、NaN、越界时间及不匹配的输入。

执行状态与校验状态分离：completed 不代表可信；`verification.status` 为 passed、failed 或 needs_review。

结果与对应输入保存到 `simulations/<taskId>/`。图片附带单位、图例、工况与版本；原始数值必须同时存在。

回传后用 CLI 原生会话 ID 继续一轮，提示中给出可读取结果和图像的路径。先实现文件阅读；为多模态图片增加提供方原生图片附件适配，且逐提供方验证，不能假定仅给路径就等同于模型已看到图片。

## 异常和幂等

- 服务端拒绝未知 tool、未启用能力、越界路径与未经登记的版本。
- 单任务只允许一个有效执行租约；多标签页不能同时消费同一任务。
- 同一 taskId 和相同结果重复提交返回已接收；内容不同则返回冲突。
- 浏览器被关闭/失联时保留 waiting_browser 或 interrupted 状态，不自动用空结果续跑。
- 方案改变后，旧任务结果只归档到旧版本。
- 自动优化设置最大轮数、CLI 时间预算和计算预算；达到限制后返回用户。

## 工作目录

```text
workspaces/<sessionId>/
  session.json                   提供方、原生会话ID、对话（当前）
  inputs/                        原始 DXF（规划）
  designs/<revisionId>/           模型、预览、日照配置（规划）
  handoff/request.json           Agent 发起的浏览器任务（规划）
  simulations/<taskId>/           冻结输入、数值、图片和日志（规划）
```

下一阶段可将对话从 session.json 拆到追加写入的 JSONL；当前单会话串行和原子文件替换足以支撑骨架。

## 公共引擎任务记录

采光、日照、人流任务统一写 envelope.json schemaVersion 2，结果继续写各能力的 result.json schemaVersion 1。状态、错误码、摘要、日志与历史兼容约定见 [公共引擎任务封装](../server/src/analysis/runtime/task.md)。HTTP 成功结果保留原字段，采光运行器补充 inputHash；失败任务通过异常与评价记录中的 taskId 定位，不补造缺失结果。
