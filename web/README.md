# web — 对话驱动的四模块白板工作台

职责：承载对话与文件界面、几何/结果查看，以及服务端仿真的配置、执行请求与结果展示。

## 当前界面

纯白淡色科技风工作台：左侧 Agent 对话，右侧 tldraw 无限画布。每个会话始终有 DXF 底图、空间节点图、仿真指标、生成方案四个独立白板，生成候选只增加方案内部版本。

- 顶部模块按钮定位白板；标题区域拖动、边缘调整尺寸，底部工具支持平移、缩放、画笔及文字标注。
- “引用到对话”将模块、所选方案和空间标识作为上下文发送给现有 Agent 接口。
- 模块详情复用节点编辑、DXF/三维查看器、仿真优化和候选比较；关闭节点详情会保留未保存修改。
- 会话与消息在本机恢复，tldraw 文档在 IndexedDB 自动保存；会话画布另通过 GET/PUT `/api/canvas/:sessionId` 保存到 `workspaces/<id>/canvas.json`。同步失败时保留本机文档并提供重试。
- 320 px 起支持对话/画布切换；对话栏可拖动调整宽度，分隔条也支持左右方向键。

本地运行：`npm run dev -w web`；如 5173 已占用，可追加 `-- --port 5187 --strictPort`。前端 API 默认代理到 127.0.0.1:4317。

生产使用 tldraw 需要有效许可。可将本目录 `.env.example` 复制为 `.env.local`，填写 `VITE_TLDRAW_LICENSE_KEY` 后重新构建；未配置时保留 SDK 原生许可提示。字体、图标和翻译随本地构建提供。

相关设计：[四模块白板重构方案](../docs/interface-refactor-design.md)。

对应文档：[架构 §3/§8](../docs/architecture.md)、[协议](../docs/protocol.md)。

## 子模块

| 目录 | 职责 | 状态 |
| --- | --- | --- |
| `src/components/` | 通用对话、上传、白板与优化比较界面 | 已接入 |
| `src/scenarios/residential/` | 住宅需求、生成准备、节点图与评价控制器 | 已接入 |
| `src/workbench/` | 请求作用域与场景生成请求契约 | 已接入 |
| `src/viewer/` | 几何、采光/日照图层与人流结果播放 | 已接入 |
| `simulation/` | 浏览器 Worker、热环境和声学规划文档 | 无浏览器求解实现 |

住宅生成编排边界与测试见 [住宅前端模块说明](src/scenarios/residential/README.md)。

## 约束

- 对话响应为 NDJSON，用 HTTP fetch 读取 POST 响应流，不是对 POST 使用 EventSource。
- 上传文件与 Agent 输出按数据处理，文本用 textContent 展示。
