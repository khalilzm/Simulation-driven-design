# shared/schemas — 数据契约

职责：定义 `model.json`、日照配置、任务与结果等 JSON schema，供校验与多端共享。

对应文档：[架构 §6/§7](../docs/architecture.md)、[协议](../docs/protocol.md)。

## 待实现

- [ ] `model.json` schema：`model`（schemaVersion/revisionId/units/坐标约定）、`floor`、`space`、`wall`、`opening`、`door`/`window`、`fixedContext`、`externalContext`。
- [ ] 日照配置 schema：经纬度、IANA 时区、日期、时段、朝向、测点规则、时间步长、目标时长。
- [ ] 任务 schema：`taskId`、`sessionId`、`revisionId`、`tool`、`executor`、`inputHash`、`engineVersion`、`status`。
- [ ] 结果 schema：`metrics`（unit/sensorCount/targetAreaRatio）、`artifacts`、`verification`（passed/failed/needs_review）。

约束：真实 `completed` 结果必须含有效测点与数值；schema 校验拒绝无测点、NaN、越界时间及输入哈希不匹配。
