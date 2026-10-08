import { layoutSettings, type ResidentialBrief, type SpaceModel } from '@sdd/shared';

export type PartitionStrategy = { roomId: string } | { axis: 'x' | 'y'; first: PartitionStrategy; second: PartitionStrategy; alignWallId?: string };
export interface LegacyResidentialStrategy {
  schemaVersion: 1;
  rationale: string;
  partition: PartitionStrategy;
  preferences: { roomId: string; side?: 'north' | 'south' | 'east' | 'west'; windowId?: string }[];
}
export interface IntentResidentialStrategy {
  schemaVersion: 2;
  rationale: string;
  preferences: LegacyResidentialStrategy['preferences'];
  roomOrder: string[];
  circulation: 'auto' | 'prefer';
}
export type ResidentialStrategy = LegacyResidentialStrategy | IntentResidentialStrategy;
export const CIRCULATION = 'solver-circulation';
export function parseResidentialStrategy(raw: unknown, brief: ResidentialBrief, base: SpaceModel): ResidentialStrategy {
  const value = raw as IntentResidentialStrategy;
  if(value?.schemaVersion===2) {
    if(typeof value.rationale!=='string'||value.rationale.length>8000||!Array.isArray(value.preferences)||!Array.isArray(value.roomOrder)||!['auto','prefer'].includes(value.circulation))throw new Error('策略v2须包含rationale、preferences、roomOrder、circulation');
    if(Object.keys(value).some(k=>!['schemaVersion','rationale','preferences','roomOrder','circulation'].includes(k)))throw new Error('策略v2只表达布局意图，不接收切分树或几何');
    const ids=new Set(brief.rooms.map(r=>r.id));
    if(value.roomOrder.length!==ids.size||new Set(value.roomOrder).size!==ids.size||value.roomOrder.some(id=>!ids.has(id)))throw new Error('roomOrder须恰好包含全部需求房间');
    const seen=new Set<string>();
    const preferences=value.preferences.map(p=>{
      if(!p||!ids.has(p.roomId)||seen.has(p.roomId))throw new Error('偏好房间ID无效或重复');seen.add(p.roomId);
      if(p.side!==undefined&&!['north','south','east','west'].includes(p.side))throw new Error('side无效');
      if(p.windowId!==undefined&&!base.windows.some(w=>w.id===p.windowId))throw new Error('未知固定窗');
      return {roomId:p.roomId,...(p.side?{side:p.side}:{}),...(p.windowId?{windowId:p.windowId}:{})};
    });
    return {schemaVersion:2,rationale:value.rationale,preferences,roomOrder:[...value.roomOrder],circulation:value.circulation};
  }
  const root = raw as LegacyResidentialStrategy;
  if (!root || root.schemaVersion !== 1 || typeof root.rationale !== 'string' || root.rationale.length > 8000 || !Array.isArray(root.preferences)) throw new Error('strategy.json 须使用 schemaVersion 1、rationale、partition、preferences');
  const allowed = new Set([...brief.rooms.map(r => r.id), CIRCULATION]);
  const seen = new Set<string>();
  let count = 0;
  function tree(value: unknown): PartitionStrategy {
    if (++count > 65 || !value || typeof value !== 'object' || Array.isArray(value)) throw new Error('partition 树无效或过大');
    const v = value as Record<string, unknown>;
    if (Object.keys(v).some(k => !['roomId','axis','first','second','alignWallId'].includes(k))) throw new Error('策略不得包含坐标、切分比例或几何边界');
    if (typeof v.roomId === 'string') {
      if (Object.keys(v).length !== 1 || !allowed.has(v.roomId) || seen.has(v.roomId)) throw new Error(`房间 ID 未知、重复或叶节点无效：${v.roomId}`);
      seen.add(v.roomId); return {roomId:v.roomId};
    }
    if ((v.axis !== 'x' && v.axis !== 'y') || Object.keys(v).length < 3 || Object.keys(v).length > 4) throw new Error('分组须包含 axis、first、second');
    if (v.alignWallId !== undefined) {
      const wall=base.walls.find(w=>w.id===v.alignWallId&&w.fixed&&w.role==='structural');
      const axis=v.axis==='x'?0:1;
      if(!wall||!wall.geometry.points.every(p=>Math.abs(p[axis]-wall.geometry.points[0][axis])<1e-6))throw new Error('alignWallId 必须引用与当前切分方向一致的固定承重墙');
    }
    return {axis:v.axis,first:tree(v.first),second:tree(v.second),...(typeof v.alignWallId==='string'?{alignWallId:v.alignWallId}:{})};
  }
  const partition = tree(root.partition);
  if (!brief.rooms.every(r=>seen.has(r.id))) throw new Error('partition 必须恰好包含所有需求房间；solver-circulation 公共交通区可选');
  if (root.preferences.length > seen.size) throw new Error('每个房间及公共交通区最多设置一条位置偏好');
  const preferred = new Set<string>();
  const preferences = root.preferences.map(p => {
    if (!p || !seen.has(p.roomId) || preferred.has(p.roomId)) throw new Error('偏好房间 ID 无效或重复；同一节点的 side/windowId 请合并到一条偏好');
    preferred.add(p.roomId);
    if (p.side !== undefined && !['north','south','east','west'].includes(p.side)) throw new Error('side 无效');
    if (p.windowId !== undefined && !base.windows.some(w => w.id === p.windowId)) throw new Error(`未知固定窗 ${p.windowId}`);
    return {roomId:p.roomId,...(p.side ? {side:p.side} : {}),...(p.windowId ? {windowId:p.windowId} : {})};
  });
  return {schemaVersion:1,rationale:root.rationale,partition,preferences};
}

export function residentialStrategyPrompt(revisionId: string, brief: ResidentialBrief, base: SpaceModel): string {
  return [
    '你是住宅布局策略设计者。直接回复一个 JSON 对象，服务器保存为 strategy.json。无文件工具，不要读取文件、源码、测试或调用 skills，不要输出 Markdown 或额外说明。',
    `任务版本：${revisionId}。只根据下面的完整输入制定策略，无需查看工程实现。`,
    'schema: {schemaVersion:2,rationale:string,roomOrder:[全部房间ID],circulation:"auto"|"prefer",preferences:[{roomId,side?,windowId?}]}。',
    '只表达功能分区、窗资源和朝向偏好。roomOrder是优先安排的次序，求解器可调整。不要提供切分树、坐标或固定房间尺寸。',
    'circulation auto表示按需补充交通，prefer表示倾向独立交通。客餐厅可以承担通行，住宅不必须有走廊。',
    '每个房间最多一条偏好。side是真实方位north/south/east/west；windowId引用固定窗。偏好可以被算法调整，硬需求不能修改。',
    '固定轮廓、承重墙、门窗不能修改；承重墙是不可穿越障碍，只有实际门洞或墙体间隙可通行。',
    '节点位置position仅是图编辑坐标。使用面积范围、连接关系、可穿行许可和用户明确的主体尺寸。未指定主体尺寸时不要自行添加硬限制。',
    'direct需要真实门连接；adjacent需要共享边界；public_access需要经过允许穿行的空间到达；no_direct禁止门连接。allowThrough默认只允许客餐厅/交通空间穿行；可表达套房。',
    '求解器联合搜索网格区域与门连接，并落成精确墙线；它可调整局部分组和补充交通。布局参数layout是可编辑的使用要求，并非建筑规范认证。',
    '入户须完整归属hard direct指定房间，必窗房间须独占完整固定窗。理解日照目标并优先分配窗和朝向；没有仿真结果时不能宣称日照达标。',
    '需求数据：',JSON.stringify({...brief,layout:layoutSettings(brief),rooms:brief.rooms.map(({position,...r})=>r)}),
    '固定底图：',JSON.stringify({units:base.model.units,floor:base.floor,walls:base.walls,openings:base.openings,doors:base.doors,windows:base.windows}),
  ].join('\n');
}
