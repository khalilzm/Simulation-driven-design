# web/simulation — 浏览器仿真入口

职责：在浏览器内执行仿真数值计算。当前不创建返回虚假指标的 Worker；能力注册表中 `sunlight.enabled=false`。

依据：[架构 §7/§9](../../docs/architecture.md) 与 [协议](../../docs/protocol.md) 实现。

## 子模块

| 目录 | 职责 | 状态 |
| --- | --- | --- |
| `dispatcher/` | 接收分析任务、加载指定版本、启动 Worker、回传结果 | 规划（M3） |
| `sunlight/` | 日照 Worker：太阳位置、射线遮挡、逐点时长、质量检查 | 规划（M2） |
| `thermal/` | 热环境能力预留 | 规划（M4） |
| `acoustics/` | 声环境能力预留 | 规划（M4） |

## 约定

- Worker 执行数值计算，主线程负责渲染；不从渲染阴影图片反推数值。
- 可复用 Three.js 几何与 BVH 射线查询。
- 热/声环境当前仅预留契约，未启用求解器。
