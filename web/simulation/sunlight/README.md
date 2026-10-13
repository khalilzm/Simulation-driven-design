# 日照计算

当前日照入口位于 [server/src/sunlight](../../../server/src/sunlight/)，调用 [Python 日照模块](../../../server/python/sunlight/)。引擎选择由服务端配置决定；本目录没有 Worker 实现。

冻结输入、执行计划及结果身份分别由服务端运行器与公共分析运行时管理。浏览器在 [Viewer](../../src/viewer/) 展示日照结果，不能从渲染阴影反推数值。住宅的室内采光 daylight 与直射日照 sunlight 保留各自工况和指标。
