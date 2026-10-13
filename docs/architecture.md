# 工程架构设计

版本：0.1 · 日期：2026-09-25 · 状态：架构基线，按阶段实现。

## 1. 产品范围与已确定决策

项目名：**仿真反馈驱动的空间自主设计**。

用户在网页中上传平面轮廓 DXF，通过自然语言与 Agent 持续对话。Agent 解析图纸、形成可计算方案、发起分析、解释结果，并在约束范围内修改空间。

- 使用一个 Node.js Express 服务承载 HTTP 与本地 Agent CLI。
- 支持 Cursor SDK、Codex app-server、Claude CLI 和离线 Echo，通过适配器统一事件；一个会话固定一个提供方。
- DXF 解析交给有文件和代码执行能力的 Agent，可调用解析库或编写脚本，不单独建设 DXF 后端服务。
- 首期日照分析在 **本机 Python（Ladybug 太阳位置 + 射线遮挡）** 内执行，由 Express 子进程调用；页面主线程负责对话与结果展示。
- 热环境、声环境只预留数据和工具契约；接入引擎后再决定执行位置。
- 首期使用本地文件持久化，暂不引入数据库、Redis、任务队列或微服务。
- UI 首先提供对话与结果查看；交互式 CAD 编辑器属于后续能力。

## 2. 架构图

![目标架构](diagrams/architecture.svg)

[可编辑 Mermaid 源文件](diagrams/architecture.mmd)。此图描述完整目标；当前代码完成度见 [README](../README.md)。

## 3. 模块职责

| 模块 | 执行位置 | 职责 |
| --- | --- | --- |
| 对话与文件界面 | Web 主线程 | 需求、附件、消息流、方案选择、结果展示 |
| 浏览器工具分发器 | Web 主线程 | 接收分析任务、加载指定版本、启动 Worker、回传结果 |
| 日照引擎（Python） | 本机子进程 | Ladybug 太阳位置、射线遮挡、逐点时长及质量检查 |
| 几何与结果查看器 | Web | 平面预览、三维分析模型、日照图、时间轴 |
| Express | 本机 Node.js | 会话、HTTP、CLI 调用、文件访问与浏览器任务交接 |
| Agent 适配器 | Node.js SDK / 子进程 | Cursor / Codex / Claude 原生会话 ID、事件转换、取消与退出管理 |
| Agent | 所选 CLI | 理解需求、解析图纸、布局生成、证据分析、结构化修改 |
| 会话工作目录 | 本地磁盘 | 原图、模型、方案版本、分析设置、结果、对话记录 |

## 4. 本机 Agent 的统一方式

每轮创建 SDK Agent 或本地进程，结束后释放。对话连续性由精确的原生会话 ID 保持，不使用全局“最近会话”。

| 提供方 | 首轮 | 后续轮次 |
| --- | --- | --- |
| Cursor | SDK `Agent.create` | SDK `Agent.resume` |
| Codex | `codex app-server --listen stdio://`；RPC `thread/start`、`turn/start` | RPC `thread/resume`、`turn/start` |
| Claude | `claude -p --output-format stream-json --verbose` | 增加 `--resume <session_id>` |

提示通过标准输入传递。`spawn` 使用参数数组和 `shell: false`，不拼接用户输入为 shell 命令。提供方、可执行文件及模型由受控配置决定。

不同 CLI 输出不同事件，适配为 `session`、`text`、`progress`、`error`、`done`。不向页面转发内部推理块。工具审批沿用 CLI 的有效权限；不自动加入跳过权限或沙箱的参数。

Codex 复用本机登录和模型配置，原生环境只读，JSON 产物由受控动态文件工具原子保存；禁用原生命令和外部连接，拒绝额外审批请求。住宅策略仅返回 JSON 文本，不开放文件工具。Claude 使用 dontAsk 和限定的 Read/Write 工具。详见 [提供方接入说明](../server/providers/README.md)。

跨提供方切换创建新会话。后续可以导入相同方案和摘要，但不能把 Codex thread ID 当成 Claude session ID。

## 5. Agent 怎样调用浏览器

两种 CLI 的命令模式都不能被假定为接受本项目自定义的 `tool_result` 标准输入。首期目标采用**轮次间文件交接**，不要求改造 CLI：

1. Agent 在工作目录中生成模型、配置和 `handoff/request.json`，随后结束当前 CLI 轮次。
2. Express 在 CLI 退出后读取请求，做 schema、路径、版本及能力检查，持久化 pending 记录。
3. Web 获取任务，将指定模型和配置交给 Worker。
4. Worker 返回结构化数值；主线程生成分析图并回传。
5. Express 校验 task ID、方案版本、输入哈希和执行状态，将结果落盘。
6. Express 使用原 CLI 会话 ID 发起新一轮，通知 Agent 读取结果和图片，继续诊断或优化。

因此，一次用户发言可以包含多个 Agent 轮次，不需要永久挂起进程等待浏览器。Codex 已通过 app-server 动态工具在轮次内读写 JSON；浏览器计算交接仍采用独立的版本与结果契约。

自动续跑受最大轮数、运行时间和用户取消约束。每次继续都必须有新的结果或新输入；不会对同一文件无限重试。

详细字段见 [协议文档](protocol.md)，完整交互见 [时序图](diagrams/sequence.mmd)。当前骨架尚未执行上述浏览器交接与自动续跑。

## 6. 轻量空间模型

`model.json` 是可编辑几何的事实来源，预览图片只是展示。初版使用本地米制坐标，显式记录与朝向、标高的关系。

| 对象 | 最小内容 |
| --- | --- |
| model | schemaVersion、revisionId、parentRevisionId、units、坐标约定 |
| floor | 边界、楼层标高、层高、顶部和底部遮挡 |
| space | ID、边界、用途、目标面积与性能偏好 |
| wall | ID、几何、厚度、高度、固定/可修改属性 |
| opening | ID、宿主墙 ID、位置、尺寸、填充构件引用 |
| door / window | ID、洞口 ID、几何、启闭及分析属性 |
| fixedContext | 柱、结构墙、楼梯、电梯井、管井等已知固定条件 |
| externalContext | 周边建筑、挑檐、阳台等遮挡及其数据来源 |

房间 ID 与构件 ID 保持稳定；拆分、合并记录来源映射。每次修改保存新目录，原方案不覆盖。面积、边界和覆盖等基础检查作为模型合法性检查，不另做仿真模块。

DXF 导入由 Agent 处理图层、块变换、单位、闭合轮廓与构件识别。未能识别的信息标记缺失或采用显式假设。轮廓图不包含的窗高、层高、地理信息必须补齐后才能开始对应日照分析。

## 7. 日照计算

首期计算的是给定时段内的**潜在直射日照时长**，不是照度、太阳辐射能量、全年采光或实际天气下的观测日照。不计云量和漫射反射；门窗透光与框体遮挡采用记录在配置中的几何假设。

### 输入

- 方案版本、三维遮挡几何、透光开口；顶部/楼板不能遗漏。
- 经纬度、IANA 时区、日期、当地分析时段、建筑朝向；记录转换后的 UTC 时间。
- 室内参考面和窗前控制点、测点间距、参考面高度、时间步长。
- 项目定义的目标时长/区间与目标空间；不默认所有空间日照越多越好。

### 算法

1. 统一坐标、检查模型与测点。
2. 按时间段采样，计算太阳方向；太阳低于地平线的时段计为无直射。
3. 用固定的分析网格建立空间加速结构，对测点作射线遮挡查询。
4. 按每个采样区间的实际时长积分，得到每个点的累计时长和时间段。
5. 按测点代表面积统计空间指标，生成时长图及选定时刻的阴影图。

可采用 Three.js 几何与 BVH 射线查询。Worker 执行数值计算，主线程负责渲染；从渲染阴影图片反推数值不是首期算法。

### 输出与质量

保存原始逐时可见性、测点坐标、累计时长、房间指标、配置、引擎版本及图片。候选方案使用相同工况、采样规则和目标版本。窗外条件固定时，仅优化窗前日照不足以驱动室内布局，必须包含室内指标。

基准包括：无遮挡点、无窗封闭空间、已知遮挡、窗框与顶板、自遮挡；检查时区/朝向及步长细化后的误差。固定测点、太阳和透光规则下，新增不透明遮挡不应增加日照。

Agent 读取数值与图像进行一致性分析、提出原因假设，再用修改后的重新计算验证。大模型判断不能替代数值与基准验证。

## 8. 页面与进程生命周期

| 情况 | 目标行为 |
| --- | --- |
| 同一会话同时收到两条消息 | 串行执行或返回 busy；不让两个 CLI 同时修改目录 |
| 浏览器关闭/Worker 被终止 | 日照任务进入 waiting_browser 或 interrupted，不承诺继续计算 |
| 页面重新打开 | 加载会话及 pending 任务；用户恢复后重新领取，不重复接收旧结果 |
| 旧方案结果晚到 | 保留在对应历史版本，不能替换当前方案结果 |
| 网络重试提交相同结果 | 以 task ID 幂等接收；内容不同的重复提交拒绝 |
| CLI 失败/权限拒绝/超时 | 显示明确错误，保留输入；不把失败标为仿真成功 |
| Express 重启 | 从磁盘恢复会话，运行中任务标记 interrupted；不宣称内存任务自动恢复 |

当前对话骨架：客户端断开会终止本轮 CLI，已写入会话的消息可重新加载；浏览器任务生命周期待下一阶段实现。

## 9. 热环境与声环境 ready

这里的 ready 指**能力命名、输入输出边界、数据扩展位置和执行器接口已预留**，不表示求解器可运行。

| 能力 | 输入扩展 | 输出扩展 | 执行位置 |
| --- | --- | --- | --- |
| sunlight | 地点、时序、开口、测点 | 日照时长与可见性 | engine（Node 调 Python） |
| thermal | 构造层、热区、气象、负荷、系统与运行条件 | 温度、负荷、舒适性 | 后续按引擎确定 |
| acoustics | 声源、接收点、频带、吸声散射属性 | 脉冲响应、混响等 | 后续按引擎确定 |

室内混响与房间间隔声分别定义能力。日照的二值可见性不能直接当作热环境的太阳得热。

共用结果信封，专业数据使用各自 schema。未实现能力返回 `CAPABILITY_NOT_IMPLEMENTED`，不生成假指标。

## 10. 本地运行边界

一个 Node 进程同时提供网页和 API，默认仅监听 127.0.0.1。CLI 在独立会话目录启动，继承本地有效登录与权限；文件夹隔离不是沙箱。外部部署和多用户权限不属于当前版本。

对话、工具进度和结果使用明确事件传递。上传文件和 Agent 输出均按数据处理，前端用 textContent 展示文本；图片与下载通过受控文件入口提供。浏览器不得提交任意可执行命令或 CLI 参数。

## 11. 技术依据

- [Codex 非交互模式](https://developers.openai.com/codex/noninteractive/)：JSONL 事件及精确会话恢复。
- [Claude Code 程序化调用](https://code.claude.com/docs/en/headless)：print、stream-json 和会话继续。
- [Claude CLI 参数](https://code.claude.com/docs/en/cli-reference)：CLI 参数与权限模式。
- [Node.js 子进程](https://nodejs.org/api/child_process.html)：异步进程与输入输出。
- [Web Workers](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API)：浏览器后台线程。
- [three-mesh-bvh](https://github.com/gkjohnson/three-mesh-bvh)：射线与空间查询加速。
- [Direct Sun Hours](https://docs.ladybug.tools/hb-radiance-primer/components/3_recipes/direct_sun_hours)：日照时长及逐时可见性，可用于后续交叉验证。

具体 CLI 参数同时以开发机 `--help` 核对；不同安装版本可能需要适配。

## 几何与住宅求解边界（2026-10-13 实现更新）

服务端公共几何与物理拓扑实现集中在 `server/src/geometry/`：多边形与区域运算、线段覆盖、墙占地、洞口两侧归属、门前净空与门扇几何、开放连接及空间图。该层不依赖住宅策略或求解器。

住宅流程分为 `residentialSolver`（策略调度与历史二叉求解）、`residentialGrid`（网格求解）、`residentialConnections`（根据需求选择门位）、`residentialCandidateQuality`（汇总住宅质量与约束检查）及 `residentialErrors`。两种求解器直接依赖公共辅助模块，不再互相导入。

几何 API 的单位、边界语义、容差差异和兼容路径见 [几何模块说明](../server/src/geometry/README.md)。本次保持原有数值算法；容差统一与多场景契约提取仍属后续工作。自动化检查见 `server/test/architectureBoundaries.test.ts`。

## 住宅场景封装（2026-10-13 实现更新）

住宅实现已归入 `server/src/scenarios/residential/`，场景入口封装输入准备、生成和室内采光评价，通用生成路由通过场景注册表调用。共享定义为 residential@1；新请求使用 scenario.id/version/input，旧 residentialBrief 参数由独立兼容层转换。未知场景/版本及混用新旧参数提前拒绝。

前端住宅节点图、指标编辑、求解与评价报告归入 `web/src/scenarios/residential/`；节点图保持懒加载，白板与 Viewer 保持通用模块。生成候选新增 scenario.json 定义快照；共享能力注册表补充已实现的 daylight。App 控制器、通用分析计划和版本失效机制的后续提取见下文；商业和办公尚未注册。接口及模块约定见 [场景模块说明](../server/src/scenarios/README.md)。

后续已将草稿恢复/保存、求解报告选择与异步采光状态提取到住宅 hooks，App 保留工作台装配和生成/对话衔接。前端请求作用域结合会话、方案、模型引用与请求轮次隔离结果，防止重复版本号或切回旧对象时接收迟到响应。

住宅室内采光与历史直射日照评价的共同生命周期位于 `server/src/analysis/runtime/evaluation.ts`，处理缓存、失效、中断、并发、取消和原子落盘；场景继续负责输入 hash、引擎调用与目标判定。优化组合已通过下述配置驱动的分析计划执行，详见 [公共评价生命周期](../server/src/analysis/runtime/README.md)。

后续已新增版本化 AnalysisPlan 与公共执行器：完整计划预检后只执行所选能力，按步骤顺序运行并在失败/取消时停止。现阶段住宅默认验证 daylight，优化策略选择 sunlight+pedestrian；这是工作流预设，住宅用途不限制分析能力。原比较策略仍要求两项同工况结果，其他计划不套用该策略。新任务保存计划快照，旧优化记录沿用默认组合，详见 [分析计划说明](../server/src/analysis/runtime/plan.md)。

框架采用“底图/地图 + 空间节点 + 多个仿真模块”，默认分析项与能力支持范围分离。ScenarioWorkspaceInputs 定义独立资源版本与仿真实例；多个同能力工况通过 moduleId 区分，结果保存在 moduleResults，不相互覆盖。仿真白板是多实例的展示容器，四块白板不限制仿真模块数。地图输入适配与前端多模块配置仍待接入，详见 [工作区结构](scenario-workspace.md)。

结果身份已统一模型、底图、冻结需求、场景、规则、计划、模块工况与引擎版本。缓存要求完整输入一致；候选比较允许几何不同，但要求冻结条件一致并通过原比较策略。缺少身份的旧结果不自动复用，重算前保存原记录历史快照，采纳候选前重新校验身份与引擎证据。版本声明仍需随算法变化维护，采光、日照与人流引擎任务 envelope 已通过后述公共运行时统一，详见 [结果身份说明](../server/src/analysis/runtime/identity.md)。

废弃代码清理已移除无入口的旧仿真/步骤/审核面板及其独占辅助代码，住宅与几何旧路径转发文件也已删除。示例模型归入服务端测试 fixture，仿真运行器只接收内存输入并自行冻结，不再接受闲置 modelPath/configPath 字段；历史 HTTP 参数和布局协议继续保留。清理范围与依据见 [架构审查实施记录](architecture-review-2026-10-13.md#13-废弃代码与工程残留清理记录)。

住宅需求解释、分步保存与生成准备已从 App 移到前端住宅控制器，通用对话层只消费 PreparedScenarioGeneration。DXF 本地草稿关联与候选底图解析也归入住宅模块，取消和输入变化会停止后续准备步骤。App 仍负责场景展示组件装配，详见 [住宅前端模块](../web/src/scenarios/residential/README.md)。

住宅空间节点的需求语义与图形排版现已独立存储并分别计版本。节点拖动与显示端点调整不会推进需求版本或使仿真缓存过期；服务端保留兼容编辑视图，旧文档在下一次保存时迁移，历史候选冻结文件保持不变。见 [节点图排版版本](residential-graph-layout.md)。

Viewer 图层已按能力注册：daylight（lx）、sunlight（h）、pedestrian（人/㎡及秒回放）分别选择，Scene 接收统一渲染数据而不读取住宅元数据来决定分析类型。住宅采光入口显式选择 daylight，住宅日照结果不再被屏蔽；能力的图例与比较色标保持一致。见 [Viewer 模块说明](../web/src/viewer/README.md)。

采光、日照和人流已共用引擎任务运行时：统一冻结输入、版本 2 envelope、状态阶段、错误码、日志和产物索引。原始结果保持各能力格式，新任务摘要绑定算法执行选项，比较读取核对文件与结果摘要；旧 envelope 保留只读兼容。见 [公共引擎任务封装](../server/src/analysis/runtime/task.md)。
