# examples/models — 示例模型

职责：存放示例 `model.json`，覆盖最小对象集。

- `sunlight-demo-pass.json`：与 Web「加载示例方案」同户型（约 100㎡ 两室两厅 + 阳台），供日照达标演示。

对应文档：[架构 §6 轻量空间模型](../docs/architecture.md)。

## 对象最小内容

| 对象 | 内容 |
| --- | --- |
| model | schemaVersion、revisionId、parentRevisionId、units、坐标约定 |
| floor | 边界、楼层标高、层高、顶部和底部遮挡 |
| space | ID、边界、用途、目标面积与性能偏好 |
| wall | ID、几何、厚度、高度、固定/可修改属性 |
| opening | ID、宿主墙 ID、位置、尺寸、填充构件引用 |
| door / window | ID、洞口 ID、几何、启闭及分析属性 |
| fixedContext | 柱、结构墙、楼梯、电梯井、管井等固定条件 |
| externalContext | 周边建筑、挑檐、阳台等遮挡及数据来源 |

约束：房间/构件 ID 稳定；每次修改保存新目录，原方案不覆盖。
