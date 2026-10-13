import { roomDaylight } from './daylight';
import type { ResidentialBrief } from './residentialBrief';

export type BriefBoard = 'graph' | 'metrics';

const GRAPH = /空间|节点图|房间|住宅|两居|三居|卧室|客厅|厨房|卫生间|书房|阳台|连接|相邻|连通|面积/;
const METRICS = /采光|日照|能耗|仿真|指标|照度|光照|太阳/;

/** Decide which brief boards a dialogue turn may create. Boards stay absent until the interpreted brief contains the artifact. */
export function briefTurnPlan(message: string, roomCount: number): { modules: BriefBoard[]; reply?: string } {
  const graph = GRAPH.test(message);
  const metrics = METRICS.test(message);
  if (!graph && !metrics) return { modules: [] };
  if (metrics && !graph && roomCount <= 0) {
    return {
      modules: [],
      reply: '仿真指标需要挂到已有房间上。请先描述房间、面积和连接关系，生成空间节点图后再说明评价目标。',
    };
  }
  const modules: BriefBoard[] = [];
  if (graph) modules.push('graph');
  if (metrics) modules.push('metrics');
  return { modules };
}

export function revealedBriefBoards(requested: readonly BriefBoard[], brief: ResidentialBrief): BriefBoard[] {
  const boards: BriefBoard[] = [];
  if (requested.includes('graph') && brief.rooms.length > 0) boards.push('graph');
  if (requested.includes('metrics') && brief.rooms.some(room => roomDaylight(room).enabled)) boards.push('metrics');
  return boards;
}

export function briefTurnReply(requested: readonly BriefBoard[], revealed: readonly BriefBoard[]): string {
  const lines: string[] = [];
  if (revealed.includes('graph')) lines.push('空间节点图已生成。');
  else if (requested.includes('graph')) lines.push('还没有整理出房间或连接，空间节点图白板暂不生成。请说明房间用途、面积和连接关系。');
  if (revealed.includes('metrics')) lines.push('仿真指标已挂到房间上，指标白板已生成。实测值会在方案评价后写回这块白板。');
  else if (requested.includes('metrics')) lines.push('还没有可评价的房间目标，仿真指标白板暂不生成。请说明要评价的房间以及照度或日照阈值。');
  return lines.join('\n');
}
