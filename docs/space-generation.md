# 户型生成（自然语言 MVP）

用户用 **对话** 或 **生成方案** 描述需求；服务端编排 Agent，编译后右侧显示平面。

## 流程

### 草图快速路径（秒级，无 Agent）

当 `inputs/` 有 PNG/JPEG/WebP 且尚无 `outline.json` 时：

1. **Python**（`server/python/sketch/sdd_sketch.py`）提取最大外轮廓 → `inputs/outline.json` + `inputs/sketch-preview.png` + 单区 `layout.json` 草案。
2. **`compileLayoutPlan`**（含外窗 segment **snap**）→ `model.json`。
3. 成功则流式 `design.valid: true`；若需多房间/复杂分区，自动 **fallback** 到 Cursor Agent 修订 layout。

依赖安装：

```bash
pip install -r server/python/sketch/requirements.txt
# 可选：python3 -m venv server/python/sketch/.venv && pip install -r server/python/sketch/requirements.txt
```

环境变量 `SDD_SKETCH_PYTHON` 可指定解释器。

### 两阶段 Agent（无草图或快速路径未满足需求）

1. **外轮廓**：Agent 写 `inputs/outline.json`（矩形/L 形/多边形，单位米）。
2. **分区**：Agent 写 `designs/<rev>/layout.json`（**schemaVersion 2**，坐标须在轮廓内）。
3. **编译**：`compileLayoutPlan` → `model.json`；流式事件 `design.valid: true` → 前端加载 Viewer。

可选：PNG/JPEG/WebP 草图上传到 `inputs/`，与文字一并提交；有轮廓时 Agent 仍可用 **read + edit** 读图。

## API

- `POST /api/chat` — 带 `message`，**必须**产出可编译户型（失败时 `design.valid: false`）。
- `POST /api/generate` — 同流程，默认提示语为「根据描述生成户型」。

流式事件 `sketchPreview`：`path` 为 `inputs/sketch-preview.png`，前端在右侧预览矢量化结果。

父方案迭代仍用完整 `buildSpacePrompt`（含 v3）；纯自然语言新方案用 v2 MVP 提示词（`spaceAgentPrompts.ts`）。

## 调试

查看 `workspaces/<sessionId>/inputs/outline.json`、`inputs/sketch-preview.png`、`designs/rev-xxxx/layout.json`、`validation.json`。
