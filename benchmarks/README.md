# benchmarks — 仿真基准

职责：存放可复现的基准方案，用于验证求解器正确性与回归。

对应文档：[架构 §7 输出与质量](../docs/architecture.md)、[roadmap M2](../docs/roadmap.md)。

## 子模块

| 目录 | 内容 |
| --- | --- |
| `sunlight/` | 日照基准方案与参考结果 |

## 原则

- 固定测点、太阳和透光规则下，新增不透明遮挡不应增加日照。
- 大模型判断不能替代数值与基准验证。
- 可与外部参考结果（如 Ladybug Direct Sun Hours）交叉验证。
