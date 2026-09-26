# server/files — 文件访问

职责：登记上传的 DXF 与会话内文件，提供受控的 artifact（模型、图像、结果）读取入口。

对应文档：[协议 §HTTP](../docs/protocol.md)、[架构 §10](../docs/architecture.md)。

## 接口（规划）

| 接口 | 内容 |
| --- | --- |
| `POST /api/uploads` | 上传 DXF，返回会话内文件引用 |
| `GET /api/artifacts/:id` | 已登记模型、图像、结果文件 |

## 待实现

- [ ] 上传写入 `workspaces/<sessionId>/inputs/`。
- [ ] artifact 登记与受控读取；路径越界与未登记版本拒绝。
- [ ] 文本用 textContent 展示，图片/下载走受控文件入口；浏览器不得提交任意可执行命令或 CLI 参数。

注意：文件夹隔离不是沙箱；文件访问仍由 CLI 自身权限管理。
