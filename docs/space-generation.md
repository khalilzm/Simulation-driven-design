# 受约束的平面布局生成

`/api/chat` 与 `/api/generate` 共用 `routes/spaceTurn.ts` 和 `design/runSpaceTurn.ts`。Agent 写功能分配 `layout.json`，服务端把分配编译为 `model.json`。Agent 不再手算空间或墙体的边界坐标。

## 可用区域

`design/regionGeometry.ts` 按真实轮廓的顶点横坐标做竖向条带分解，再合并共享边的凸区域。保留凹口与斜边，不用包围盒替代轮廓。布尔运算结果消除 1e-9 坐标单位以下的浮点噪声，并验证有效性、面积和越界情况。区域之间只在共享正长度边时标记为相邻。

`design/layoutRegions.ts` 给区域编稳定的本轮 ID，并提供实际面积（平方米）、矩形范围或真实顶点、邻接区域。已有方案先按当前空间划分，再处理剩余区域，以便修改保留未涉及的功能。ID 只在本轮有效，不引用历史轮次的区域 ID。

## Agent 输出

目标文件为 `designs/<revisionId>/layout.json`：

```json
{
  "splits": [{ "regionId": "r1", "axis": "x", "ratio": 0.4 }],
  "allocations": [
    { "id": "cardio", "usage": "有氧区", "regionIds": ["r1.a"], "enclosed": false },
    { "id": "studio", "usage": "团操室", "regionIds": ["r1.b"], "enclosed": true, "targetArea": 40, "minArea": 30 }
  ],
  "assumptions": ["朝向待确认"],
  "unmetRequirements": []
}
```

split 沿当前区域包围盒的 x 或 y 方向按比例切分，`.a` 为低坐标侧、`.b` 为高坐标侧；父区域被消耗，后续可继续切子区域。程序用精确交集执行切分，拒绝空区域、不合法切分和小于 0.05 m² 的切分碎片。首版最多 64 次切分、64 个功能分配。

allocation 的 ID 唯一，每个最终区域最多分配一次。封闭房间必须连通，并检查跨保留墙的情况。`minArea` 是硬下限；`targetArea` 是软目标，显著不足时返回提示。用户要求的下限由 Agent 从自然语言映射到 minArea，程序不解析任意自然语言面积约束。可选 `floorHeight` 为米制层高。

## 几何编译

`design/compileAllocation.ts` 合并同一功能的区域。多连通或带孔的结果保存为多个简单环，通过 `Space.allocationId` 关联；不会通过连接外部顶点填平凹口或孔洞。

服务端填写固定轮廓、原点、版本、配色、默认值及墙体。仅外轮廓和 `enclosed:true` 功能的边界生成墙；开放功能共边与同一逻辑功能拆分的内部边不生成墙。共墙去重，已有固定墙及门窗宿主墙原样保留，门窗引用保持有效。

布局编译只继承已有门窗，不生成入口或房门。层高、墙厚、已有洞口的弧长位置及尺寸按 `model.units` 存储，面积始终使用平方米。

前端功能区保留色块，实际围合由墙体填充表达，不再给新方案的每个色块画闭合边框；墙体填充按已有洞口宽度截断，并保留门窗符号。

狭长空间、开放功能的分散分片、面积偏差、未满足需求及未分配面积随 design.warnings 显示。

## 校验与版本

模型经过空间/墙体几何、固定条件、构件引用、完整外墙和可选全覆盖检查。外墙覆盖检查针对宿主墙中线。几何编译和接受检查的越界面积阈值为 1e-6 m²。

失败最多续跑一次，反馈实际 layout.json 与错误。只有通过校验才写入正式 model.json。Agent 直接写入的旧格式模型会隔离为 `agent-model.rejected.json`，不能绕过编译。每个版本的 `validation.json` 记录状态、错误、假设、警告及准备/编译/总耗时。

失败的分配稿保留在目录供诊断，不替换前端当前方案。普通方案读取拒绝无效版本；默认父版本为最新有效版本，旧版本也重新检查几何，避免继承历史越界几何。

## 请求兼容

- `parentRevisionId` 指定当前方案；省略时使用最新有效版本，显式 null 使用 DXF。上传新 DXF 后网页清除当前版本选择。
- `requireFullCoverage` 可显式传布尔值；未传时识别“铺满”“无 void”等常用表达并跨轮次继承。要求铺满时，全部最终区域必须分配，交通或预留区域也需明确命名。
- 两个入口都保存原生 Agent 会话，概念讨论不强制生成文件。

## 验证

`npm run check`、`npm test`、`npm run build`。回归覆盖矩形、L 形、窄凹口、斜边、旋转轮廓与实际健身房轮廓，以及切分、孔洞、封闭房间区域连通性、面积下限、固定门窗、错误修正和无效版本隔离；还覆盖毫米单位、既有门窗渲染和不自动开门的布局编译。

运行 `node --import tsx scripts/benchmark-region-layout.mjs` 输出本地几何基准。基准使用程序构造的分配，不调用在线 Agent；不能把这些耗时当作模型首图时延或把几何合法性当作功能设计质量。
