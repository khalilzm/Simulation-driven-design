# scripts — 工程检查

职责：存放工程级检查脚本，对应 `npm run check`。

对应文档：[README 本地运行](../README.md)。

## 待实现

- [ ] 语法/类型检查。
- [ ] 契约与 schema 校验入口。
- [ ] 其他一次性工程辅助脚本。

要求 Node.js 22+。

住宅墙体关系重放：`node --import tsx scripts/replay-residential-wall-layout.mjs [输出目录] [对照模型路径]`。从固定截图反例重新求解，验证固定构件、需求及模型，生成前后指标和PNG/SVG对照图；可指定上一轮模型作对齐对照，不调用模型或仿真服务。默认输出到 workspaces/wall-layout-review。
