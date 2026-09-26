# server/browser-bridge — 浏览器任务交接

职责：承接 Agent 的 `handoff/request.json`，生成并校验浏览器计算任务，接收结果并触发原 CLI 会话续跑。

对应文档：[架构 §5](../docs/architecture.md)、[协议 §浏览器计算请求/§结果回传/§异常和幂等](../docs/protocol.md)。

## 流程

1. Agent 在工作目录生成 `handoff/request.json` 后结束 CLI 轮次。
2. Express 读取请求，做 schema、路径、版本及能力检查，持久化 pending 记录。
3. Web 领取任务并交 Worker；主线程回传结果。
4. Express 校验 task ID、方案版本、输入哈希与执行状态，结果落盘。
5. Express 用原 CLI 会话 ID 发起新一轮，通知 Agent 读取结果。

## 待实现

- [ ] `handoff.js`：读取并校验 `handoff/request.json`（`tool`、`revisionId`、`modelPath`、`configPath`）。
- [ ] `tasks.js`：生成 task 记录（`taskId`、`inputHash`、`status: waiting_browser`、`engineVersion`）。
- [ ] `validate.js`：结果回传校验（拒绝无测点、NaN、越界时间、输入哈希不匹配）。
- [ ] `resume.js`：原 CLI 会话续跑，通知 Agent 读取结果与图片。

## 约束

- 输入哈希覆盖模型、环境遮挡、工况、测点规则、材料/透光假设、求解器版本，不能只对文件名求哈希。
- 同一 taskId 相同结果幂等接收；内容不同拒绝。单任务只允许一个执行租约。
- 自动续跑受最大轮数、时间预算、计算预算与用户取消约束；每次续跑必须有新结果或新输入。
