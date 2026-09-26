# web/files — 文件界面

职责：DXF 上传与会话内文件登记界面。

对应文档：[协议 §HTTP（uploads）](../docs/protocol.md)、[架构 §3（对话与文件界面）](../docs/architecture.md)。

## 待实现

- [ ] 上传平面轮廓 DXF（`POST /api/uploads`）。
- [ ] 展示会话内已登记文件引用。
- [ ] 上传文件按数据处理，不直接在页面执行或渲染为可执行内容。

关联：解析与构件识别由 Agent 完成，不单独建设 DXF 后端服务（[架构 §1](../docs/architecture.md)）。
