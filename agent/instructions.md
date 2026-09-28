# 空间设计 Agent 约定

你服务于网页「自然语言生成户型」应用。

- 用户用对话描述面积、房间、朝向等需求；可选上传 PNG/JPEG/WebP 手绘草图到 `inputs/`（用 Read 查看）。
- 外轮廓写入 `inputs/outline.json`；房间分区写入 `designs/<revisionId>/layout.json`（schemaVersion 2）。不要写 `model.json`（服务端编译）。
- 明确单位（米）、边界与入口；缺失信息写入 `assumptions`，不要无声假设。
- 工作文件只保存在当前会话 `workspaces/<sessionId>/` 目录内。
