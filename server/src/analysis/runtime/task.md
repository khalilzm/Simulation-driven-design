# 公共引擎任务与结果封装

`task.ts` 管理采光 daylight、日照 sunlight 与人流 pedestrian 的任务存储和生命周期；`simulation/process.ts` 管理有界进程输出、进程组取消及超时；`engineResult.ts` 校验各能力的传输结果。三个能力入口保留输入校验、引擎选择及 CLI 选项，不再分别写任务文件。

## 文件与状态

任务仍位于 `workspaces/<sessionId>/simulations/<taskId>/`，使用 UUID 分配目录：

| 文件 | 职责 |
| --- | --- |
| model.frozen.json | 执行时的独立模型快照 |
| daylight / sunlight / pedestrian.frozen.json | 对应能力的独立工况快照 |
| envelope.json | schemaVersion 2 的统一任务记录 |
| result.json | 引擎自己的 schemaVersion 1 物理结果，保持原文件名与内容 |
| runner.log | stdout、stderr 和失败原因；无输出时也保留文件 |

运行前写 `running / preparing`，快照就绪后写 `executing`，进程正常退出后进入 `reading_result`。只有结果通过校验、冻结文件未变化且请求未取消时才记录 completed；完成、失败、取消和超时均写 finishedAt 与产物列表。JSON 文件使用临时文件与 rename 写入。

| 任务状态 | 含义 |
| --- | --- |
| completed | 进程正常退出且传输结果有效；不代表业务目标通过 |
| failed | 进程、输出、版本、快照或 I/O 出错 |
| cancelled | 调用方取消；预取消仍保存快照与任务记录，不启动引擎 |
| timed_out | 公共进程执行器的时间预算耗尽 |
| interrupted | 读取旧 running 任务时发现当前进程没有活动标记，或原所有者 PID 已不存在 |

中断判断仅生成读取视图，不改写历史文件，不从遗留 result.json 推断成功。跨进程存活检查基于 PID，当前框架仍以本地单服务进程运行；没有增加自动续跑或任务队列。磁盘不可写或分配目录失败时无法保证记录落盘，错误仍向调用方抛出。

## 身份与诊断

统一记录会话、请求版本、实际模型版本、能力、moduleId/moduleVersion、声明/报告引擎版本、模型与工况摘要、执行选项、超时预算、阶段、时间、所有者、进程退出码/终止信号、日志截断标记及结果摘要。分析计划将模块实例 ID 和版本传给能力入口，多个同能力任务通过模块和 UUID 归属。

原始任务 inputHash 使用公共版本 3 摘要，绑定能力、模型语义、解析后的工况、声明引擎版本和算法执行选项。人流 strictGeometry 也参与摘要；超时、进程路径和 moduleId 不改变物理输入摘要。工作区的场景/规则/模块版本可比性继续由 ResultIdentity 管理。模型/工况文件另有完整内容摘要，包含实际模型版本，用于文件完整性核对。

stdout 与 stderr 各保留最后 200000 个字符，并记录是否截断；非零退出、取消、超时及启动错误均保留已捕获输出。Unix 终止进程组，Windows 使用原有子进程终止方式。记录不保存环境变量。产物列表枚举任务目录的顶层文件和目录，未递归生成每个引擎内部文件的摘要。

## 结果校验与错误引用

三个入口返回统一 EngineTaskOutput：taskId、inputHash、result、simulationDir。result 保留各能力的独立字段与单位，不将照度、小时和疏散秒数合并成一个指标。

新任务必须报告已知 schemaVersion、正确 engineVersion 和明确状态；校验必需指标、单位、有限数值、空间记录、网格索引/值数量、轨迹及已提供的目标/采样/分配字段。缺失数据不补为零，缺失版本不填当前版本。计算 completed 与 verification/采样/目标是否达标分开处理，业务评价仍由场景和比较策略负责。

engineVersion 表示适配器的结果协议/算法版本，与求解器依赖包版本分开。人流 Python 原来返回依赖标识 jupedsim-1.4，与 Node 声明不一致；现在统一返回 jupedsim-egress@1，并回归检查 Python 生产者与 Node 声明一致。旧任务按历史记录读取。

EngineTaskExecutionError 携带 taskId、目录、inputHash、状态及机器错误码：cancelled、timeout、spawn_failed、process_exit、missing_result、invalid_json、invalid_result、engine_failed、io_error。住宅评价失败和生成候选试算失败保存关联 taskId，便于定位原始诊断。调用方取消优先于引擎失败信息，非零进程退出即使留下 completed 文件也不能成为成功任务。

## 历史读取与完整性

`loadEngineTaskEnvelope` 支持新格式及旧 schemaVersion 1/历史未声明版本的 envelope，不进行自动迁移。旧任务继续使用原 inputHash，读取不会重新计算或改写旧摘要。

`loadCompletedEngineResult` 对新任务核对状态、能力、结果摘要、模型/工况文件摘要和公共输入摘要，再按能力解析。优化比较已接入该读取路径，可发现只改网格、保持汇总指标不变的结果修改。旧记录继续使用既有比较校验；不补造历史缺失字段、结果或验证结论。

新任务的健康检查不纳入模型分析记录；各引擎内部 recipe 文件格式未修改。没有新增任务浏览 UI、计划级任务队列或跨进程锁，真实 Radiance recipe 仍需单独验收。

## 回归范围

包含三适配器冻结输入/统一封装，生命周期阶段，模块身份传递，输入与结果修改检测，错误 taskId 传播，失败结果与缺失数据拒绝，预取消、进程取消、超时、启动失败、有界输出、中断视图及历史 envelope 兼容。模拟引擎验证 Node 编排与落盘行为，不作为物理性能验证。

真实 JuPedSim 单代理、10 秒预算冒烟验证通过：运行、结果校验、统一任务落盘及完整性回读。该检查验证协议联通，不证明场景疏散达标；当前配置的 Radiance 日照与室内采光 recipe 未运行。
