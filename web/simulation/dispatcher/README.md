# web/simulation/dispatcher — 浏览器工具分发器

职责：从服务端领取待处理任务，加载指定版本与引擎，启动对应 Worker，并把结构化结果回传给服务端。

对应文档：[架构 §3（浏览器工具分发器）/§5](../docs/architecture.md)、[协议 §结果回传](../docs/protocol.md)。

## 待实现

- [ ] 领取 pending 任务（单任务只允许一个执行租约，多标签页不能同时消费）。
- [ ] 按 `tool` 选择 Worker 与指定 `engineVersion`，加载冻结输入。
- [ ] 转发进度事件到主线程。
- [ ] 结果回传（含 task ID、revisionId、inputHash、metrics、artifacts、verification）。
- [ ] 失联/取消处理：浏览器关闭时任务进入 `waiting_browser` 或 `interrupted`，不承诺继续计算。

约束：浏览器只负责领取与计算，不自行决定工具授权；任务合法性由服务端校验。
