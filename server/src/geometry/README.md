# 几何与物理拓扑

本层只依赖自身模块、shared 契约/纯函数与 polygon clipping，不依赖住宅策略、Agent、路由、文件存储或 UI。`architectureBoundaries.test.ts` 检查此边界及住宅求解器依赖图的循环。

| 文件 | 职责 |
| --- | --- |
| polygon.ts | 面积、边界闭合、包围盒、包含判定、墙折线位置 |
| regions.ts | 带孔/多区域的布尔运算、面积、分解、共享线段 |
| segments.ts | 线段分割与完整覆盖判定 |
| wallFootprint.ts | 墙段的矩形占地 |
| openingSides.ts | 洞口两侧空间与室外归属，兼容中心线和净墙面边界 |
| doorGeometry.ts | 门前净空、门扇扫掠、碰撞与容纳检查 |
| openSpaceConnections.ts | 扣除实际墙体后的开放连接及净宽 |
| spatialGraph.ts | 由几何派生的空间、门、窗、开放通道索引与可达性 |

## 单位与边界约定

- 点、墙厚、洞口 position/width、足迹和输出边界均使用 `model.units` 的原生单位。门洞 position 是沿宿主折线的弧长，不是归一化比例。
- 显式标为 Metres/M 的参数或指标使用米，例如 `doorApron` 的 depthMetres，以及开放通道和空间图的 netWidthM。面积检查除以 scale²，scale 为每米对应的模型单位数（m=1、mm=1000）。
- polygonArea 为一个环的绝对面积；geometryArea 对外环减去孔洞面积，再对多个多边形求和。不要用一个环的面积代替带孔区域面积。
- 模型边界采用首尾重复的闭合环；pointInPolygon 为原有射线判定，严格排除边界时需额外检查点到边距离。pointInPolygonOrOnEdge / shared 的 pointInOrOnPolygon 明确接受边界。后者不能未经回归验证就替代前者。
- 空间图表达物理连接，节点图排版、住宅穿行许可、硬软关系与门位搜索仍由上层业务处理。窗不形成通路，触碰角点不形成开放通道。

## 容差基线

此次仅拆职责，保留原算法的数值行为，没有统一不同用途的容差：

| 使用位置 | 原有容差/处理 |
| --- | --- |
| polygon 的包含检查默认值 | 0.02 个原生模型单位；允许调用方覆盖 |
| polygon 的 closePolygon 默认值 | 0.001 个原生模型单位 |
| regions.GEOMETRY_EPS | 1e-7 个原生模型单位；cleanRing 保留 9 位小数 |
| segments 覆盖长度比较 | 1e-6 个原生模型单位 |
| openingRoomSides | 墙面外偏移 1e-5 米；归属判定容差 1e-8 个原生模型单位 |
| doorApron | 墙面外偏移 1e-4 米；越界面积阈值 1e-7 平方米 |
| doorSwingFits / swingCollision | 越界面积 1e-6 平方米 / 重叠面积 1e-4 平方米 |
| openSpaceConnections | 1e-7 米长度容差；输出净宽为米 |

原生单位容差与按米缩放的容差是历史差异，不代表全部算法在单位缩放后精度完全相同。后续统一容差应单独修改，并补充临界边界、窄缝和米/毫米等价性验证。

## 住宅层与模块入口

住宅的门位搜索位于 `scenarios/residential/residentialConnections.ts`，候选质量汇总位于 `scenarios/residential/residentialCandidateQuality.ts`，错误类型位于 `scenarios/residential/residentialErrors.ts`。房型、家具主体尺寸、穿行许可及硬软约束仍是住宅规则，未移入几何内核；调用方直接引用实现所属目录。

原 `model/geometry.ts`、`design/regionGeometry.ts`、`design/spatialGraph.ts` 和 `design/openSpaceConnections.ts` 转发文件已删除，仓库内的测试和回放脚本已迁移。residentialSolver 的公共辅助函数仍保留导出，历史住宅布局算法和 HTTP 输入兼容仍可使用。
