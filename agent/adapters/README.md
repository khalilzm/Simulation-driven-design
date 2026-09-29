# agent/adapters — Agent 侧适配

职责：为 Agent 提供各提供方原生能力适配，重点是多模态图片附件。

对应文档：[协议 §结果回传](../docs/protocol.md)、[架构 §5](../docs/architecture.md)。

## 草图图片输入

Cursor 使用 SDK 原生 `images`，Claude 使用 stream-json 的 base64 image 内容块；均发送会话内已转正的 PNG。识别发送原图，仅开放写入；修正开放读取已知产物。几何通过后直接返回，不再调用模型做图像对照。Cursor 返回启动、发送、推理和清理阶段耗时。适配与消息契约测试见 `server/test/sketchTurn.test.ts`。

模型的视觉识别效果需另用真实草图验证，消息协议测试不代表识别准确率。日照结果/分析图回传的多模态适配仍需独立接入。

说明：Agent 的运行主体是所选本地 CLI；这里只放辅助适配，不含 DXF 解析或布局生成逻辑（那些由 Agent 在会话目录内完成）。
