# examples/scenarios — 示例工况

职责：存放示例仿真工况配置（如 `sunlight.json`），供 Worker 与基准复用。

对应文档：[架构 §7 日照计算输入](../docs/architecture.md)。

## 文件

| 文件 | 说明 |
|------|------|
| `sunlight-rev-0001.json` | 冬至卧室目标（演示未达标，对比用） |
| `sunlight-demo-pass.json` | 夏至客厅 `space-living` ≥1h，配合 `examples/models/sunlight-demo-pass.json`，引擎校验 **passed** |

Web 侧点击 **「日照达标示例」** 会加载上述模型并写入 `sunlight.json`。

## 工况内容

- 经纬度、IANA 时区、日期、当地分析时段、建筑朝向。
- 测点规则：参考面高度、测点间距、时间步长。
- 目标时长/区间与目标空间。

约束：候选方案使用相同工况、采样规则和目标版本；记录转换后的 UTC 时间。
