// 能力注册表与提供方契约（对齐 docs/architecture.md §9）

export type ProviderId = 'cursor' | 'codex' | 'claude' | 'echo';

export interface ProviderInfo {
  id: ProviderId;
  label: string;
  description: string;
  requiresLogin: boolean;
}

export const PROVIDERS: ProviderInfo[] = [
  {
    id: 'cursor',
    label: 'Cursor',
    description: 'Cursor SDK 本地 Agent，默认 Composer 2.5，使用本机 Cursor 账号登录',
    requiresLogin: true,
  },
  {
    id: 'codex',
    label: 'Codex（本机）',
    description: '复用本机 Codex 的 ChatGPT 登录和模型配置，自动运行独立任务',
    requiresLogin: true,
  },
  {
    id: 'claude',
    label: 'Claude',
    description: 'Anthropic Claude Code CLI，需本机已登录',
    requiresLogin: true,
  },
  {
    id: 'echo',
    label: 'Echo（本地测试）',
    description: '不调用模型，直接回显输入，用于冒烟测试',
    requiresLogin: false,
  },
];

export type CapabilityId = 'daylight' | 'sunlight' | 'thermal' | 'acoustics' | 'pedestrian';

export interface Capability {
  id: CapabilityId;
  enabled: boolean;
  executor: 'browser' | 'engine' | null;
  input: string;
  output: string;
}

export const CAPABILITIES: Capability[] = [
  {
    id: 'daylight',
    enabled: true,
    executor: 'engine',
    input: '门窗、材料、标准阴天天空、评价面与房间目标',
    output: '室内照度、采光系数与房间达标面积比例',
  },
  {
    id: 'sunlight',
    enabled: true,
    executor: 'engine',
    input: '地点、时序、开口、测点',
    output: '日照时长与可见性',
  },
  {
    id: 'thermal',
    enabled: false,
    executor: null,
    input: '构造层、热区、气象、负荷、系统与运行条件',
    output: '温度、负荷、舒适性',
  },
  {
    id: 'acoustics',
    enabled: false,
    executor: null,
    input: '声源、接收点、频带、吸声散射属性',
    output: '脉冲响应、混响等',
  },
  {
    id: 'pedestrian',
    enabled: true,
    executor: 'engine',
    input: '几何、出口、人数、工况',
    output: '轨迹、密度、疏散时间',
  },
];
