# 几何与结果查看器

实际实现位于 [web/src/viewer](../src/viewer/)，包含 Three.js 场景、模型渲染、室内采光/日照图层和人流播放；工作台负责选择模型与结果。数值计算由服务端分析适配器调用 Python 引擎，浏览器负责展示。

模块拆分与结果身份见 [架构说明](../../docs/architecture.md) 和 [分析运行时](../../server/src/analysis/runtime/README.md)。交互式 CAD 编辑与新的仿真能力需要分别实现。

图层按计算能力注册，室内采光 daylight 与直射日照 sunlight 使用独立模式，不根据住宅元数据选择。模块边界与扩展约定见 [Viewer 实现说明](../src/viewer/README.md)。
