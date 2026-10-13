# 场景模块

当前注册场景为 `residential@1`（住宅），共享定义在 `shared/src/scenarios.ts`。室内采光是当前流程的默认验证项，defaultAnalysisIds 不构成住宅能力白名单；显式工作区模块可以组合其他已实现仿真能力和多个工况。只有已实现的场景进入注册表；商业与办公尚未注册。

## 接入方式

`registry.ts` 用静态注册表解析场景 ID 和版本，将输入引用交给对应 runtime。`types.ts` 定义通用生成上下文和准备完成的任务：底图、生成提示、缺失输入、执行函数。通用路由与 runSpaceTurn 调用这些接口，不直接调用住宅求解器。

框架输入采用“底图/地图 + 空间节点图 + 仿真模块列表”，场景 runtime 的 createAnalysisPlan 接受这些显式模块；模块 ID 与能力 ID 分离，允许同一能力的多个工况。共享输入契约与页面接入范围见 [工作区架构](../../../docs/scenario-workspace.md)。

`residential/index.ts` 是住宅生成与室内采光评价入口。它检查保存输入的版本和 hash，准备底图及需求快照，调用住宅生成实现，并将本轮定义写入候选目录的 `scenario.json`。住宅需求、布局策略、网格与历史求解、门位和质量规则以及采光评价均位于本目录。

`legacy.ts` 专门适配旧 residentialBrief HTTP 参数和旧 runSpaceTurn 文档参数。未知场景和版本不会回退到住宅；新旧参数同时出现时拒绝。旧 `design/residential*.ts` 等转发路径已删除，测试和回放脚本直接引用住宅实现；HTTP 历史参数兼容继续保留。

## HTTP 请求

`POST /api/generate`（带 message 时也可走现有对话入口）：

```json
{
  "provider": "codex",
  "sessionId": "session-id",
  "mode": "edit",
  "parentRevisionId": "rev-0001",
  "requirePreparedInputs": true,
  "scenario": {
    "id": "residential",
    "version": "1",
    "input": {
      "baseRevisionId": "rev-0001",
      "version": 1,
      "baseModelHash": "保存需求接口返回的 hash"
    }
  }
}
```

新请求通过引用读取服务端保存的需求，不接受客户端替代冻结需求全文。错误 ID、错误场景版本、未保存需求、过时输入引用和底图不一致均在调用 Agent 前拒绝。现有 NDJSON 事件、候选文件名与住宅评价 URL 保持兼容；status 返回已注册场景与计算能力，包含独立的 daylight 能力。

## 前端对应模块

`web/src/scenarios/residential/` 管理住宅需求编辑、React Flow 图、采光指标编辑、求解报告、评价报告和生成请求构造。节点编辑器与图继续懒加载；通用白板与 WebGL Viewer 不进入住宅目录。旧 components 转发路径已删除。

## 当前边界与下一阶段

这是第一个可执行场景模块；通用编排只通过接口调度。共享住宅需求契约仍从 @sdd/shared 导出。草稿恢复/保存与异步评价状态已提取到前端住宅控制器，住宅采光和历史直射日照评价共用 [公共评价生命周期](../analysis/runtime/README.md)。住宅室内采光已通过 [分析计划](../analysis/runtime/plan.md) 接入公共执行器。App 的对话需求解析、上传草稿关联与生成准备已提取到 [住宅前端控制器](../../../web/src/scenarios/residential/README.md)，App 保留场景组件装配和通用流处理；版本失效已接入公共结果身份；真实的第二个场景仍需验证接口。

scenario.json 记录生成时的场景定义；它保留模型中的 residentialBrief 历史元数据作为冻结输入兼容。住宅评价和优化缓存已经校验场景、规则、计划、模块和引擎版本，详见 [结果身份](../analysis/runtime/identity.md)；这不代表商业、办公或地图适配已经实现。

测试覆盖新旧生成入口、未知 ID/版本、歧义参数拒绝、冻结输入、场景定义保存、几何层边界及求解器无循环；实际 Radiance recipe 继续独立验收。
