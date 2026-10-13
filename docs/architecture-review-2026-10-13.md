# 项目结构与多场景架构审查

审查日期：2026-10-13。范围：当前工作区代码，包含未提交的新模块；不是只审查 HEAD。此次只新增审查文档，不移动或删除业务代码。

## 结论

需要整理，但适合在现有 `web / server / shared` 三个 workspace 上渐进重构。基础设施已有可复用部分，主要问题是住宅业务渗入通用入口、拓扑和模型契约，以及仿真与优化按固定能力组合编写。仅调整目录不能解决这些问题。

推荐目标：**通用工作台与任务流程 + 可组合的场景配置 + 独立几何/拓扑内核 + 计算适配器 + 规则评价层**。保留住宅求解器作为住宅实现，商业和办公可以采用不同的布局策略。

## 1. 当前结构与模块边界

| 模块 | 实际代码位置 | 判断 |
| --- | --- | --- |
| UI / 白板工作台 | `web/src/App.tsx`、`components/DesignWorkbench.tsx`、`DesignCanvas.tsx` | 已有展示组件分层，但 App 804 行，集中管理会话、上传、住宅需求、生成、采光、优化、候选和白板状态 |
| WebGL Viewer | `web/src/viewer/` | 已独立，Scene 管理底层 viewer、模型与结果渲染；渲染器按模型/日照/人流分文件。结果模式与业务字段仍硬编码 |
| 仿真 | `server/src/sunlight/`、`daylight/`、`pedestrian/`，`server/python/` | 已按引擎分离，公共 Python 进程执行器支持超时/取消；任务快照、目录、结果封装仍重复，采光封装与另外两个不同 |
| 节点图 | `web/src/components/SpaceGraphCanvas.tsx`、`SpaceNodeEditor.tsx` | React Flow 渲染与编辑已有分开，但均使用 ResidentialBrief、RoomKind 和住宅接口，尚非通用需求图 |
| 几何 / 拓扑 | `shared/src/polygonGeometry.ts`、`wall*.ts`；`server/src/model/geometry.ts`；`server/src/design/regionGeometry.ts`、`spatialGraph.ts`；Viewer 网格转换；Python 几何转换 | 有拆分基础，但底层、算法和住宅语义混放，依赖方向有问题 |

### 最值得先处理的边界问题

1. **通用拓扑依赖住宅求解器。** `server/src/design/spatialGraph.ts:6` 从 `residentialSolver` 导入 `openingRoomSides`。应将门洞两侧归属、通行边、公共边等提到几何/拓扑层，再由各场景调用。
2. **求解器互相引用。** `residentialSolver.ts` 调用 `residentialGrid`，而 `residentialGrid.ts:5` 从前者导入 `footprint / connectAndCheck / assessResidentialQuality / ResidentialSolveError`。将公共几何检查、质量检查和错误类型拆出，可消除该循环。
3. **节点图编辑状态进入业务契约。** RoomRequirement 中有 `position`，RoomRelation 中有 `diagramHandles`；这些字段用于排版而非物理约束。持久化需求与图的排版分别版本化，避免拖动节点影响语义输入 hash 和可比性判断。
4. **住宅元数据进入通用模型。** `shared/src/model.ts` 的 ModelMeta 包含 `residentialBrief` 与 solver 标记，Python `sdd_run.py` 也根据它选择住宅采样。改为通用 provenance/input snapshot 引用；采样策略由分析输入声明，住宅扩展留在场景资料中。
5. **通用界面仍按住宅恢复。** App 的初始化恢复、briefBaseModel、生成与评价逻辑大量依赖 residentialBrief。拆出工作区状态与任务控制后，场景逻辑通过适配器接入。
6. **采光与日照混用展示模式。** `ModelDisplayMode` 仅有 usage/sunlight/pedestrian；Viewer 的 sunlight 分支同时承载室内照度与直射日照。独立 capability ID、单位、图例和结果类型，避免不同物理量混淆。
7. **生成与采光选择存在强耦合。** runResidentialTurn 在已有几何候选、所有采光模拟失败时抛出 ResidentialSolveError，最终候选被标记失败；这与“保留几何、允许评价重试”的目标有差距。将几何有效、评价完成与目标达标作为独立状态，采光失败仍可保留有效几何候选。

几何方面已有相近实现，例如 shared 的 `pointInOrOnPolygon` 与 server 的 `pointInPolygonOrOnEdge`，但默认容差不同。不能直接以“重复”为由合并；应先确定米制规范、含边界语义、容差和退化几何行为。Viewer 的三角化、挤出和材质转换属于渲染适配，不需要搬入业务求解器。

## 2. 多业务场景的通用框架

### 当前阻碍

- `runSpaceTurn.ts` 通过可选 residentialBrief 分流；没有明确 scenario 注册与调度。
- `shared/src/residentialBrief.ts` 同时定义房型、面积、关系、采光/日照、布局设置、解析校验和交互辅助；房型、32 房间上限和参数范围均写死在住宅需求中。
- `server/src/optimization/simulate.ts` 无条件串行执行日照和疏散；`OptimizationEvaluation` 必须包含这两个结果，无法直接表达“只做采光”或“消防规则 + 可达性”。
- `SimulationConfigPanel.tsx` 同样固定呈现日照和疏散配置。
- `shared/src/contracts.ts` 的能力注册表只有 sunlight / pedestrian / thermal / acoustics，实际已经存在的 daylight 尚未登记；且注册表只有说明与 enabled，不能驱动执行和 UI。
- DXF 导入器要求固定承重墙和入户口，并使用固定住宅图层集。商业示例 README 明确说明还需扩展图层映射，不能把有商业 DXF 示例视为商业流程已打通。
- SpaceModel 当前为单层、单边界环；商场中庭、洞口、多层楼梯网络若进入需求，应补充模型表达与适用性检查。单层商业试点不必先实现整个多层模型。

### 推荐的四个独立概念

| 概念 | 职责 | 示例 |
| --- | --- | --- |
| ScenarioDefinition | 定义空间类型、输入约束、布局策略、能力组合、规则集、指标优先级和 UI 编辑器 | residential / commercial / office |
| AnalysisAdapter | 转换冻结模型与工况、执行计算、校验结果、生成可视化资料 | daylight / directSun / egress / reachability |
| RuleSet / Evaluator | 将几何和计算结果与明确的规则、目标比较，输出证据与结论 | 消防几何规则、采光达标、路线可达、目标不退化 |
| WorkflowRunner | 统一输入冻结、任务状态、候选、取消/重试、评价、比较、采用 | 对各场景采用同一套任务生命周期 |

消防规则校验与人流疏散模拟应作为不同能力；若后续“消防”包括烟气、火灾发展等物理过程，再增加对应引擎适配器。当前 pedestrian 引擎给出轨迹、密度和疏散时间，成功结果中的 verification 仍为 needs_review，不能代表完整消防评价。

“可达性”也应定义检查模式：普通连通、最短路线、净宽约束或无障碍路径。共用物理拓扑，按模式应用边的方向、净宽、门槛、楼层连接等属性，而不是仅以无向 BFS 作为所有可达性结论。

### 通用数据骨架

```ts
interface ScenarioDefinition {
  id: string;
  version: string;
  spaceCatalogId: string;
  inputProfileId: string;
  layoutStrategyId: string;
  defaultAnalysisIds: string[]; // 默认工作流选择，不是能力白名单
  ruleSetIds: string[];
}

interface EvaluationContext {
  scenarioId: string;
  scenarioVersion: string;
  modelRevisionId: string;
  inputSnapshotId: string;
  requirementVersion: string;
  analysisConfigVersions: Record<string, string>;
  ruleSetVersions: Record<string, string>;
}
```

以上是提议接口，不是现有实现。需求图的核心可包含空间、锚点、面积/用途、关系与硬软约束；场景附加字段使用有类型且有运行时校验的扩展。室内采光、直射日照、消防与可达性保留各自配置与结果 schema，不合并为一个无类型的大 JSON。

评价统一记录执行、适用性、数据完整性、约束满足和目标满足。项目已有 `EvaluationCategory` 与 `OptimizationAssessment`，可以从这里提取公共概念。缺资料或不支持的能力返回 unknown/needs_review/unsupported，不能误当通过。

每个结果应关联模型、冻结需求、工况、场景/规则版本、引擎版本及输入 hash。可比性由这些语义输入决定；结果迟到或输入变化只更新对应历史记录，不替换当前查看的候选。

### 三个场景的组合

| 场景 | 场景自己的内容 | 共用能力 |
| --- | --- | --- |
| 住宅 + 采光 | 住宅房型、外窗偏好、私密/穿行关系、住宅布局策略、房间采光目标 | 几何内核、物理拓扑、室内采光适配器、工作台与任务生命周期 |
| 商业 + 消防 + 疏散 | 商铺/公共走道/出口等类型、商业 DXF 输入映射、商业布局策略、消防规则与人数配置 | 几何内核、物理拓扑、规则评价、疏散适配器、结果图层 |
| 办公 + 消防 + 可达性 | 工位/会议室等类型、办公布局策略、消防规则、路线及可达性目标 | 同一拓扑、规则评价、可达性检查、工作台与任务生命周期 |

三个场景共用流程，但不要求共用同一个房间布局求解器。消防规则也应允许场景参数与版本不同，不能只复制住宅规则再更名。

### 推荐目录（职责示意）

```text
shared/src/
  domain/              模型、需求、候选、任务、输入快照
  geometry/            无 UI/IO 的几何原语与约定
  analysis/            按能力定义工况、结果、评价契约
  scenarios/           场景资料类型与可序列化定义

server/src/
  application/         generate/evaluate/optimize/adopt 用例与生命周期
  geometry/            布尔运算、几何校验、物理拓扑
  scenarios/
    residential/       当前住宅策略、求解、规则
    commercial/        商业输入与布局策略
    office/            办公输入与布局策略
  analysis/
    runtime/           快照、任务存储、hash、取消、进程执行
    daylight/          室内采光适配器
    directSun/         直射日照适配器
    egress/            疏散适配器
    reachability/      可达性检查
  rules/               规则集与证据评价
  infrastructure/      文件存储、DXF 输入适配、Agent providers
  routes/              薄 HTTP 层

web/src/
  app/                 入口与工作台装配
  workbench/           白板、版本、模块引用、状态控制
  features/            需求图、分析配置/报告、候选比较
  viewer/              Viewer 核心、模型渲染、独立结果图层
  scenarios/           场景编辑器、预设和报告注册
  api/                 请求、事件契约适配
```

继续采用模块化单体即可；目前没有证据支持增加微服务或动态插件加载平台。先用静态注册的接口验证第二个场景。

## 3. 废弃代码与清理证据

检查使用 TypeScript AST 提取静态 import/export 与字面量 dynamic import，从 `web/src/main.tsx`、`server/src/index.ts` 追踪生产依赖，再补入 `server/test`、`server/scripts`、根 scripts 入口。该检查不覆盖外部调用、任意字符串动态加载或 Python 导入；shared 的 barrel re-export 可达也不等于每个导出都被使用。

### A. 高把握清理候选：生产、测试和脚本均无导入路径

```text
web/src/components/EvidencePanel.tsx
web/src/components/FlowStepper.tsx
web/src/components/OptimizationTaskPanel.tsx
web/src/components/PedestrianPanel.tsx
web/src/components/SketchReviewPanel.tsx
web/src/components/SpaceScopeView.tsx
web/src/components/SunlightPanel.tsx
web/src/sunlight/configForm.ts
web/src/workbench.ts
server/src/model/voidRegions.ts
server/src/sketch/runSketchParse.ts
```

其中旧仿真面板/步骤组件已经不在现有工作台路径中。删除时连同仅被这些文件引用的样式、API helper 和类型逐项核对，避免误删仍被现有 Viewer/优化面板使用的能力。SketchReviewPanel 目前没有入口，人工确认开关也关闭；如决定保留人工核对功能，可迁移为明确可启用的功能模块，而非保留无入口组件。

### B. 生产无路径，但测试或脚本仍引用：先确认功能定位

```text
web/src/examples/sampleModel.ts
server/src/design/residentialDirectSunEvaluation.ts
server/src/dxf/outline.ts
server/src/model/geometryValidation.ts
server/src/model/resolveCatalog.ts
server/src/optimization/diagnose.ts
server/src/optimization/relayout.ts
```

- sampleModel 是测试 fixture，适合移到测试目录，解除 server 测试对 web 示例的依赖。
- residentialDirectSunEvaluation 是旧住宅直射日照评价实现，当前住宅 UI 使用室内采光评价，但旧评价仍有测试。决定保留独立 directSun 能力还是淘汰旧住宅入口后再迁移/删除。
- diagnose / relayout 等属于未接入生产的实现；“有测试”不能证明线上使用，但也不能仅凭无生产引用就直接删除。

### C. 历史兼容与可配置路径：不能当作死代码

- `residentialSolver.ts` 的旧二叉切分解法与策略 schemaVersion 1：新住宅生成明确只收 v2，但历史策略仍可回放；应独立放入 legacy/replay，确认不再需要历史回放后再删除。
- layout v2/v3 都由现有 compile 路径支持，不能看到版本旧就删除。
- Python `radiance_engine.py` 可由环境变量启用，并非废弃。Python 必须另做导入及配置入口审计。
- `SunlightRunInput / PedestrianRunInput` 的 modelPath/configPath 已不参与执行，但路由和快照测试仍传入；可先迁移调用方，再删除这两个兼容字段。
- `ensureAgentOutlineFile` 仅检索到定义，可作为未使用导出进一步清理；与整个 resolveAgentLayout 文件的可达性分开判断。

### D. 可直接整理的工程残留

- Git 仍跟踪 12 个 `__pycache__/*.pyc`，虽然 `.gitignore` 已有 `__pycache__/`。应从版本库索引移除；这些文件是派生产物。
- README 仍称项目只是对话骨架，web/viewer 与 web/simulation 的占位文档仍描述未实现 Viewer / 浏览器 Worker / sunlight.enabled=false，与当前代码不一致。
- `web/chat`、`web/files`、`web/simulation`、`web/viewer`、`server/browser-bridge` 等说明目录需按实际结构核对。保留未来规划时集中到 docs/roadmap，避免被误认为真实模块。
- 额外启用 noUnusedLocals/noUnusedParameters 已发现未使用导入、局部变量与参数，例如 compileLayoutPlan 的 polygonGeometryError/parseLayoutPlanV2/outsideArea，residentialGrid 的 assessRoomQuality，Viewer modelRender 的 Opening，App 的 sketchReport 读取值。清理前注意保留产生必要副作用的调用。

## 4. 整理顺序与验收

1. **建立可靠基线并清理残留。** 修正类型检查的跨层测试引用；整理 fixture、pyc、陈旧文档与无引用组件。保证当前住宅行为可回归验证。
2. **修正核心依赖方向。** 提取门洞归属、拓扑、公共质量检查和错误类型，消除住宅求解器循环；统一几何单位和容差契约。新增边界约束，防止通用层再依赖住宅层。
3. **住宅作为第一个场景实现。** 从 App 拆工作区状态、输入编辑、任务控制、候选与评价；需求图的语义与排版分离，Viewer 图层与 analysis capability 注册解耦。
4. **抽公共分析与评价流程。** 统一冻结输入、task/result envelope、取消/超时、版本与 hash；用分析计划取代固定日照+疏散组合，保留能力自己的结果和 UI。
5. **用单层商业试点检验抽象。** 接商业图层映射、空间类型、消防规则评价和疏散；流程不新增 App 中的场景 if/else。规则集范围与依据另行定义，本审查不制定法规阈值。
6. **再接办公。** 复用相同任务和拓扑，增加办公布局与可达性规则；根据实际需求扩展洞口、多层和路径属性。

核心验收：住宅现有输入与输出可回放；商业/办公禁用采光时不会调用采光引擎；图拖动不改语义 hash；新增场景通过注册接入；不同物理量图层与单位明确；输入/规则/引擎变化使结果过期；不可比候选不能被作为性能改善；失败、取消及迟到结果保留各自历史归属。

## 5. 审查时检查记录（修复前）

- `npm run check -w web`：通过。
- `npm run check`：shared 通过，server 失败，未执行后续 web 步骤；前端已另行检查。
- 已有失败：`server/test/droppedUpload.test.ts:3` 使用 `.ts` 扩展导入而未启用 allowImportingTsExtensions，并把 `web/src/uploadFile.ts` 引入 server 的非 DOM 编译环境，导致 FileReader 找不到。宜拆纯分类函数与浏览器读取函数，或独立前端测试配置；不建议给整个 server 增加 DOM 类型来遮盖边界问题。
- noUnusedLocals/noUnusedParameters 为本轮附加审计参数，发现的错误不等于项目原有配置已启用该检查。
- `npm test`：363 个测试，360 通过、3 失败，约 196 秒。失败位置为 residentialBrief.test.ts:150、residentialGrid.test.ts:85、residentialWallRelationships.test.ts:90。
- residentialBrief 的集成测试实际进入了 Radiance 候选评价分支，三个候选的采光模拟均未完成，导致整个生成失败；底层引擎失败原因本轮未进一步诊断。另外两项失败为求解器断言，需要在重构前明确修复或接受新的预期，不能将现状视为全绿基线。
- 本轮未启动真实外部 Agent；已有测试使用 Echo/测试适配器。npm test 包含上述采光调用尝试，不代表真实仿真链路验证通过，也不代表商业、消防、疏散或办公流程已验证。

## 6. 检查基线修复记录

2026-10-13，按后续“修复检查基线”请求完成：

- 上传类型分类与大小常量移到 `shared/src/upload.ts`；web 保留浏览器文件读取及兼容导出。测试直接引用 shared，消除 server 编译环境对 FileReader 和 `.ts` 扩展导入的依赖。
- 通行测试通过 `layoutSettings` 获取有效默认净宽，并使用与求解器相同的浮点容差，不再将未设置的参数作为比较值。
- 墙体回归不强制同一求解结果一定在 S12 采用直线续接：验证实际连接对齐、S12 分隔长度与无未解释墙段，并继续验证所有实际续接的中心线和厚度一致。原有硬关系、主体质量、墙面连续、固定输入不变等断言继续保留。专门的续接几何单元测试也保留。
- 固定底图/入户通行集成测试明确关闭室内采光目标，仍验证冻结需求、日照配置及候选有效性。它不再意外依赖真实 Radiance 安装；本轮没有修改“全部采光失败则生成失败”的业务行为，也未修复实际 Radiance 引擎问题。

验证结果：`npm run check` 全部通过；30 个定向测试全部通过；`npm test` 363/363 通过（含日照与人流 Python 回归），约 43 秒；`npm run build` 通过。构建仍有大 chunk 提示，真实 Radiance recipe 仍由原有 `SDD_TEST_RADIANCE=1` 开关独立验收；此次未运行该 recipe。

## 7. 几何与拓扑依赖整理记录

后续已完成公共几何模块提取：`server/src/geometry/` 承载多边形/区域运算、线段覆盖、墙占地、门洞归属、门扇与净空几何、开放连接和物理空间图。生产调用逐步改为直接引用所属模块；旧路径保留为兼容导出。

住宅门位组合、候选质量汇总和错误类型分别提取到 residentialConnections、residentialCandidateQuality 和 residentialErrors。residentialGrid 不再导入 residentialSolver，空间图也不再依赖住宅求解器，消除了此前指出的两处依赖问题。

单位、闭合边界和原有容差差异已记录在 [几何模块说明](../server/src/geometry/README.md)。本次未修改容差、求解策略和质量判定算法；住宅专有规则仍留在住宅模块。新增自动化测试约束几何依赖边界并检测住宅求解器依赖图循环。

验证：类型检查通过；42 个定向回归通过；完整测试 365/365 通过（含两个新增架构检查），约 49 秒；diff 空白检查通过。此处的回归结果不包含真实 Radiance recipe。

## 8. 住宅场景封装记录

住宅服务端的需求、策略、生成、求解与评价实现，以及前端节点图、指标编辑和报告已分别移入 scenarios/residential。新增共享住宅场景定义、通用准备任务接口、静态注册表和独立兼容层；前端发送 scenario.id/version/input，通用生成入口按场景分派，旧请求继续兼容。新候选保存 scenario.json，status 暴露场景定义，能力注册表补充实际存在的 daylight。

未知场景、错误版本及新旧参数冲突在 Agent 调用前拒绝，保存输入的版本/hash 和底图关系仍由住宅模块校验。新增/扩展测试覆盖注册信息、准备输入快照、新旧入口、无副作用拒绝和通用编排不直接依赖具体场景。

验证：类型检查、生产构建及 diff 空白检查通过；完整测试 370/370 通过，约 48 秒。真实 Radiance recipe 未运行。App 中住宅状态控制、共享住宅契约分层、通用分析计划和场景/规则版本缓存失效仍待后续提取；商业与办公没有注册为空实现。模块接口见 [场景模块说明](../server/src/scenarios/README.md)。

## 9. 场景控制器与公共评价生命周期

住宅草稿恢复/保存、底图状态和求解报告选择提取到 useResidentialBrief；异步评价加载、运行、超时、取消和结果展示衔接提取到 useResidentialEvaluation。评价运行状态与对话 busy 分离；请求作用域同时区分会话、方案和请求轮次，模型更换时使旧请求失效。保存响应不覆盖期间新增的草稿编辑。

新增 analysis/runtime/evaluation，住宅室内采光与旧直射日照评价共用缓存、失效、中断、并发保护、取消/失败、原子写入与锁释放；场景自身继续管理 hash、引擎和判定规则。原记录类型、文件名、hash 与接口保持兼容。预取消任务不启动计算。

验证：类型检查、生产构建与 diff 空白检查通过；完整测试 376/376 通过，约 44 秒。新增测试覆盖通用评价生命周期及请求作用域，前端 React hooks 未做浏览器挂载测试；真实 Radiance recipe 未运行。下一阶段为可配置分析计划，替换优化流程固定日照+疏散组合，随后完善场景/规则版本的结果失效逻辑。

## 10. 可配置分析计划

新增共享 AnalysisPlan 契约与完整计划校验，以及公共计划执行器。按计划选择 daylight/sunlight/pedestrian，无隐式附带调用，空计划不计算；启动前验证所有工况及模型目标引用。模型与配置为独立副本，失败/取消停止后续步骤。

住宅评价与生成中的室内采光试算接入单项 daylight 计划。优化 simulate 改为消费比较策略选择的计划，保留日照完整性检查、人数/数值检查及原摘要格式；当前“改善疏散、保护日照”比较策略依然需要两个结果，策略不匹配的计划提前拒绝。新优化/工作台记录与住宅候选保存计划，历史记录按原策略构造默认计划。

验证：类型检查、生产构建、diff 空白检查通过；28 个定向测试通过；完整测试 381/381 通过，约 45 秒。真实 Radiance recipe 未运行。下一阶段为场景/规则/计划/引擎版本参与结果失效与可比性判断，商业和办公仍未注册。

## 11. 默认验证与能力范围分离、多仿真实例

按用户澄清，住宅的室内采光是当前默认验证项，不是用途的能力边界。场景标签改为“住宅”，analysisIds 改为语义明确的 defaultAnalysisIds；显式工作区模块不自动加入默认项。

新增 ScenarioWorkspaceInputs：底图/地图引用、空间节点引用及可包含多个实例的 simulationModules，每个实例有 ID、版本、能力和工况。场景注册入口通过 createAnalysisPlan 构造显式计划；住宅可组合已实现的采光、日照、人流能力。AnalysisPlan 允许同能力的多个不同 moduleId，moduleResults 分别保存结果，兼容 results 只为单实例能力提供摘要。

测试验证住宅选择日照+两个疏散工况且不自动加入采光，各结果独立；验证资源/场景版本和重复模块拒绝。类型检查、生产构建及 diff 空白检查通过；完整测试 383/383 通过，约 48 秒。底图类型契约预留 map，但当前实际导入为 DXF；前端多模块编辑和结果切换尚未接线。四块白板为展示容器，不构成业务仿真模块数量限制。参见 [工作区结构](scenario-workspace.md)。

## 12. 结果身份、缓存与可比性实施记录

新增共享 ResultIdentity 与公共稳定摘要：绑定会话、模型、底图、冻结需求、场景、规则、计划、模块版本/工况及引擎版本。缓存身份包含候选几何与版本，比较身份允许几何不同；图排版字段不参与需求语义摘要，但保存推进资源版本仍会保守失效。住宅采光、历史日照、生成试算和优化工作台均接入。

缺少身份或引擎证据不匹配的旧结果不自动复用，也不能作为性能改善依据；历史文件仍可读取。住宅过期评价在重算前保存原记录快照，优化采纳前校验基线与候选是否仍对应冻结输入。原文件完整性摘要保留兼容；版本声明需随算法/依赖变化手动维护，各引擎原始任务 envelope 尚未全部统一。

验证：类型检查、生产构建及 diff 空白检查通过；完整测试 392/392 通过，约 50 秒。新增覆盖版本/工况/几何失效、候选可比性、多个模块版本、身份损坏、旧缓存历史保留和引擎证据拒绝。真实 Radiance recipe 未运行。下一阶段回到代码清理：确认废弃代码和兼容导出的实际引用，分批移除派生产物及无引用实现，保留仍在使用的历史协议。详见 [结果身份说明](../server/src/analysis/runtime/identity.md)。

## 13. 废弃代码与工程残留清理记录

重新使用 TypeScript AST 核对静态 import/export、字面量 dynamic import 与 CSS import，范围包括前后端源码、服务端测试和根/服务端脚本，再用全文检索核对导出名称及文件引用。删除不依赖单次生产入口可达性判断；配置启用的引擎和历史回放实现继续保留。

本轮完成：

- 删除 7 个无入口组件：EvidencePanel、FlowStepper、OptimizationTaskPanel、PedestrianPanel、SketchReviewPanel、SpaceScopeView、SunlightPanel。连同独占 SketchReviewPanel.css、sunlight/configForm.ts、旧 workbench.ts 一并清理。
- 删除无引用的 model/voidRegions.ts、sketch/runSketchParse.ts，以及 resolveAgentLayout 中未使用的 outline 文件恢复函数。layout/intent 文件恢复路径继续使用。
- 将测试和回放脚本迁移至 geometry / scenarios/residential 的实现入口，删除 25 个 TypeScript/TSX/CSS 转发文件。历史 residentialBrief HTTP 参数、布局 v2/v3 和住宅策略 v1 回放不受影响。
- 将 sampleModel 从 web 示例目录移至 server/test/fixtures，住宅评价测试直接使用本地 fixture。
- 删除旧面板留下的 15 个无引用 API 声明，以及 flow-stepper / evidence-panel 独占样式；AnalysisEvidence 仍使用的 evidence-empty 样式保留。服务端 HTTP 路由继续保留。
- 移除 sunlight/pedestrian 运行器闲置的 modelPath/configPath 字段及调用方参数，冻结输入回归测试继续核对每个任务的 model.frozen.json、工况文件和 envelope。
- 删除 12 个受 Git 跟踪的 Python 字节码文件，原 .gitignore 规则继续生效。为保留工作区原内容，删除前副本存于本机临时目录 /private/tmp/sdd-cleanup-python-cache；验证使用 PYTHONDONTWRITEBYTECODE=1。
- 更新 Viewer、仿真目录与模块说明，明确当前实际代码位置、服务端执行链路，以及尚未实现的浏览器 Worker、热环境和声学能力。

这是确定性清理批次，不能据此认定仓库已不存在其他冗余。生产暂未接入但仍有测试的 diagnose、relayout、几何校验与直射日照评价继续保留；规则版本维护、共享住宅契约分层、App 住宅生成编排及第二个真实场景验证仍是后续优化项。

验证：类型检查、生产构建及 diff 空白检查通过；完整测试 392/392 通过，约 46 秒。源码、测试及脚本的相对模块引用核对无缺失。构建仍有原有大包提示；真实 Radiance recipe 未运行。

## 14. 前端住宅生成编排拆分记录

App 的需求意图规划、节点图→指标解释顺序、部分成功保存、生成前置条件及冻结输入引用移至住宅 generation/useResidentialGeneration。通用工作台新增 PreparedScenarioGeneration（模式、父版本、场景输入引用），对话流不再读取住宅需求全文来组装请求；App 仍负责 UI 装配。

DXF 草稿关联归入 draftStorage，由 useResidentialBrief 暴露上传生命周期方法；候选底图归入 baseModel，切换到不同底图候选时重新解析其引用，加载完成再次校验选择作用域。关联成功只删除实际读取的本地草稿快照，期间新增草稿保留。住宅 API 支持 AbortSignal，异步准备每次 await 后检查作用域，过时任务不继续执行后续步骤。

回归覆盖冻结场景引用、未保存/版本变化拒绝、解释顺序、指标失败保留节点图、空结果不发布、取消/切换阻断保存、草稿失败保留及新编辑保护、不同候选底图解析。新增架构边界禁止 App 直接导入住宅输入持久化和需求解释操作。当前住宅默认采光前置条件保留，未增加业务能力限制或空场景实现；React hooks 未做浏览器挂载测试。

验证：类型检查、生产构建及 diff 空白检查通过；完整测试 402/402 通过，约 47 秒。构建仍有原有大包提示，真实 Radiance recipe 未运行。实现边界见 [住宅前端模块说明](../web/src/scenarios/residential/README.md)。下一项优化为节点图排版状态与需求语义版本分离，避免仅拖动节点导致保存版本推进并使仿真缓存过期。

## 15. 节点图排版与需求语义版本拆分记录

共享 ResidentialBriefSemantics 与 ResidentialGraphLayout 分别表达需求和排版。底图目录保存 schemaVersion 2，将语义内容与节点坐标/连线显示端点分别存储在同一原子写入文件中。需求与排版分别计版本，首次保存明确发布需求；无变化保存不推进版本。旧内联文档只读兼容，下一次保存迁移，历史候选冻结文件不修改。

前端按语义与布局差异分别标记 dirty；只拖动节点不阻止已保存需求生成，也不显示评价目标已修改。已有关系的编辑保持数组顺序。API 增加布局版本的乐观并发校验；旧客户端不能覆盖已更新的布局。Agent 解释后若需求版本变化则拒绝覆盖，只有布局变化时保留最新布局。生成提示剔除图形字段，缓存摘要与保存版本判断共用住宅语义投影。

定向回归覆盖布局保存的版本、缓存与准入稳定性，语义变化失效，冻结历史保持，旧格式迁移，并发拒绝，本地草稿和重复保存，以及 Agent 输入一致与解释期间的布局合并。物理算法与当前住宅默认采光工作流保持不变；兼容编辑视图仍保留 position/diagramHandles，React hooks 与编辑器没有浏览器挂载验证。详见 [节点图排版版本](residential-graph-layout.md)。

验证：类型检查、生产构建及 diff 空白检查通过；完整测试 409/409 通过，约 51 秒。构建保留原有大包提示，真实 Radiance recipe 未运行。

## 16. Viewer 图层与业务场景解耦记录

新增纯数据能力图层注册表与独立图例装配。daylight 和 sunlight 使用独立显示模式，标签、单位、空状态和几何适配均归所属能力；通用 Scene 消费 fills/lines/playback，不再依据 residentialBrief 屏蔽日照。住宅采光控制器显式选择 daylight，现有日照/疏散比较保留原模式和统一色标。清理无引用的 modelToSunlightSpaceFills，几何模型渲染不再保留旧日照均值着色路径。

已完成/缺失状态按实际结果判断，失败结果不创建分析图层，也不会借用另一类光环境数据。比较色标同时用于几何与图例；人流回放数据仅由人流适配器提供。图层按钮从注册表生成，窄区域允许换行，3D 按钮移至右侧避免遮挡。

回归验证住宅元数据不能限制日照、普通模型可显示采光、同时存在两类光环境时独立取值和单位、缺失/失败隐藏、比较色标及轨迹时长传递、原始数据不改写、能力边界。图例静态 HTML 核对通过；未做浏览器 WebGL 截图或挂载交互验证。工作区多实例结果继续按 moduleId 保存，Viewer 接收所选结果，多实例选择 UI 未在本阶段接入。见 [Viewer 模块说明](../web/src/viewer/README.md)。

验证：类型检查、生产构建及 diff 空白检查通过；完整测试 416/416 通过，约 48 秒，图层/边界定向测试 13/13 通过，图例静态 HTML 核对通过。构建保留原有大包提示，真实 Radiance recipe 未运行。下一项为各物理引擎任务/结果封装的一致性，当前公共执行计划与结果身份已统一，但各能力原始任务产物仍有差异。

## 17. 公共引擎任务与结果封装实施记录

公共 task 运行时统一三个能力的任务目录、独立快照、运行阶段、终态、原子 envelope、日志、错误引用和产物索引。采光也写统一任务记录并返回 inputHash；日照、人流不再自行生成任务 envelope。进程执行器保留非零退出/取消/超时诊断与截断标记，同步/异步启动失败都使用结构化错误。

公共任务 inputHash 升为版本 3，绑定能力、工况、引擎及算法选项；人流 strictGeometry 纳入摘要。分析计划传递 moduleId/moduleVersion。结果按能力校验版本、单位、指标、网格、轨迹和可选目标/采样数据，不再对缺失指标补零或对缺失版本填默认值。计算完成与目标/verification 通过保持分离。

任务错误携带 taskId，住宅评价和失败候选试算保留该引用。新 envelope 的读取校验冻结输入、结果摘要与输入摘要，优化比较接入；旧 schemaVersion 1/未声明版本的成功记录只读兼容，不迁移历史文件。孤立 running 记录读取为中断，不提升遗留结果为成功。

回归包括三运行器模拟进程、全部终态与诊断、快照及结果修改拒绝、模块归属、旧记录兼容、能力传输校验及架构依赖。没有新增任务队列、会话互斥或浏览任务 UI，真实 Radiance recipe 未运行。说明见 [公共引擎任务封装](../server/src/analysis/runtime/task.md)。

实际人流冒烟发现 Python 报告依赖标识 jupedsim-1.4，Node 声明适配器版本 jupedsim-egress@1；统一为后者，并新增跨语言版本声明回归。真实 JuPedSim 单代理、10 秒预算运行、传输校验、任务落盘与完整性回读通过，旧记录仍按历史版本读取。这验证编排协议，不作为疏散达标证据。

验证：类型检查、生产构建及 diff 空白检查通过；完整测试 435/435 通过，约 43 秒。构建保留原有大包提示；当前配置的 Radiance 日照与室内采光 recipe 未运行。下一项建议处理会话写入并发，避免多个生成/仿真请求覆盖当前设计与评价状态。
