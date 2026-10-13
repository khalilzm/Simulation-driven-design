# 仿真模块说明

当前分析在服务端执行：[计划执行器](../../server/src/analysis/runtime/plan.md) 按模块实例选择 daylight、sunlight、pedestrian，再由对应适配器调用 Python。浏览器的 [Viewer](../src/viewer/) 展示结果，工作台组织模型、配置及比较。

住宅当前默认验证室内采光；框架允许其他已实现能力及多个模块实例。能力是否可运行以服务端 status 和输入校验为准。

本目录只有文档，没有浏览器 Worker 实现。浏览器任务分发、热环境和声学属于规划能力；不能视为已接入的仿真模块。结果身份、缓存和可比性见 [结果身份说明](../../server/src/analysis/runtime/identity.md)。
