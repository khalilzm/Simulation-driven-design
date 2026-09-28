import type { OutlineContext } from '../spacePrompt';
import { closePolygon, outlineBBox } from '../model/geometry';
import { PROGRAM_OUTLINE_REL } from './programOutline';

/** 第一轮：仅根据自然语言（±草图）写入外轮廓，不写 layout。 */
export function buildOutlineOnlyPrompt(ctx: OutlineContext): string {
  const sketch = ctx.inputHints
    ? `可选草图路径：${ctx.inputHints}（用 Read 查看后再推断尺度）。`
    : '无草图；从用户描述推断合理户型尺度和外轮廓（常见矩形，约 60–120㎡）。';
  return `你是户型设计助手。本回合**只写外轮廓文件**，不要写 layout.json 或 model.json。

${sketch}

在本会话 cwd 写入 **${PROGRAM_OUTLINE_REL}**（JSON）：
{
  "boundary": [[0,0],[W,0],[W,H],[0,H]],
  "origin": [0,0],
  "units": "m",
  "assumptions": ["简述面积与形状假设"]
}
boundary 至少 3 点、闭合、不自交；W/H 为米。assumptions 必填。
外轮廓面积应能容纳：所有功能房间面积之和 + 约 10–15% 的走廊与墙体占位；请在 assumptions 里写明你的面积估算（各功能区约多少㎡，合计多少㎡）。
路径必须是相对 cwd 的 ${PROGRAM_OUTLINE_REL}，勿写仓库根或其它 session 目录。
写完后用一句话说明假设。`;
}

/** 已有固定轮廓时：用 schemaVersion 2 写功能分区（MVP，坐标须在 boundary 内）。 */
export function buildLayoutV2Prompt(revisionId: string, ctx: OutlineContext): string {
  const outline = JSON.parse(ctx.outline!) as { boundary: number[][]; bbox?: { width: number; height: number; area: number } };
  if (!outline.bbox) outline.bbox = outlineBBox(closePolygon(outline.boundary as [number, number][], 0)) ?? undefined;
  const sketch = ctx.inputHints ? `\n参考草图：${ctx.inputHints}\n` : '';
  return `固定外轮廓（米，origin [0,0]）：
${JSON.stringify({ boundary: outline.boundary, bbox: outline.bbox }) }
${sketch}
在本会话 cwd 写入 **designs/${revisionId}/layout.json**（仅 schemaVersion 2，不要 v3，不要 walls/model.json）：

要求：
- spaces：每个 id、usage（具体功能名）、enclosed、boundary 多边形顶点（须完全落在上述 boundary 内）
- 至少 1 个 enclosed:false 的门厅/起居；封闭卧室/卫生间等须通过 doors 或 open 边界可达
- 外入口：boundaries 中 id 如 entry_edge，segment 为外轮廓一边，kind:wall，一侧 outside；openings + doors 挂在该 boundary
- boundaries：内隔墙 segment + kind wall/open + leftSpaceId/rightSpaceId
- openings 可用 typeId（如 door-single-900）；doors 写 openingId、connects、swing:left|right|none
- assumptions、unmetRequirements 数组可为空

矩形 10×8、竖墙 x=5 分两室示例（可改用途与尺寸，但须贴合真实 boundary）：
{"schemaVersion":2,"spaces":[{"id":"living","usage":"客厅","enclosed":false,"boundary":[[0,0],[5,0],[5,8],[0,8]]},{"id":"bed","usage":"主卧","enclosed":true,"boundary":[[5,0],[10,0],[10,8],[5,8]]}],"boundaries":[{"id":"split","segment":[[5,0],[5,8]],"kind":"wall","leftSpaceId":"living","rightSpaceId":"bed"},{"id":"entry","segment":[[0,0],[2,0]],"kind":"wall","leftSpaceId":"outside","rightSpaceId":"living"}],"openings":[{"id":"op_entry","hostBoundaryId":"entry","typeId":"door-single-900","position":1,"width":0.9,"height":2.1}],"doors":[{"id":"d_entry","openingId":"op_entry","swing":"left","connects":["outside","living"]}],"windows":[],"assumptions":[],"unmetRequirements":[]}

路径：designs/${revisionId}/layout.json（相对 cwd）。校验失败会再给一次修正机会。`;
}

/** 新方案：让 Agent 写 intent.json（设计意图，不含几何），几何由服务端布局器生成。 */
export function buildIntentPrompt(revisionId: string, ctx: OutlineContext): string {
  const outline = JSON.parse(ctx.outline!) as { boundary: number[][]; bbox?: { width: number; height: number; area: number } };
  if (!outline.bbox) outline.bbox = outlineBBox(closePolygon(outline.boundary as [number, number][], 0)) ?? undefined;
  const area = outline.bbox?.area;
  const bbox = outline.bbox;
  const sketch = ctx.inputHints ? `\n参考草图：${ctx.inputHints}\n` : '';
  return `固定外轮廓（米${area ? `，约 ${area}㎡` : ''}${bbox ? `，${bbox.width}m × ${bbox.height}m` : ''}）：
${JSON.stringify(outline.boundary)}
${sketch}
在本会话 cwd 写入 **designs/${revisionId}/intent.json**（设计意图，不含任何坐标/几何）：

{
  "schemaVersion": 1,
  "building": { "wallThickness": 0.2, "wallHeight": 4 },
  "circulation": [ { "id": "corridor", "usage": "走廊", "orientation": "horizontal", "width": 2 } ],
  "rooms": [
    { "id": "living", "usage": "客厅", "area": { "min": 20, "target": 25 }, "orientation": ["south"], "privacy": "public" }
  ],
  "adjacencies": [ { "a": "kitchen", "b": "dining", "relation": "adjacent" } ],
  "daylight": [ { "roomIds": ["living"], "minHours": 3 } ],
  "doors": [ { "connects": ["living", "corridor"], "swing": "right", "leafCount": 2, "width": 1.5 } ],
  "windows": [ { "spaceId": "living", "orientation": "south", "width": 1.8, "height": 2.2, "sillHeight": 0, "position": "center" } ],
  "assumptions": [],
  "unmetRequirements": []
}

要求：
- building（可选）：建筑级参数，wallThickness（墙厚米，默认 0.12）、wallHeight（墙高米，默认 3）
- rooms：每个房间 id（字母开头英文标识）、usage（功能名）、area.min（硬下限 m²）/area.target（参考 m²）、orientation（可选 south/north/east/west 等）、privacy（可选 public/semi-private/private）
- circulation（可选）：交通骨架走廊，orientation 为 horizontal（横向贯穿）/vertical（纵向贯穿），width 为宽度（米，默认 1.5）；有走廊时其余房间会按朝向分到走廊两侧，走廊本身作为开放交通区
- 至少 1 个 privacy:"public" 的房间作为开放交通区（如客厅/门厅）
- adjacencies：房间关系 adjacent（相邻）/near（靠近）/separated（隔开）
- daylight：需要日照的房间 + 最少日照小时数 minHours
- windows（可选）：窗户清单，每扇窗一个条目，spaceId（窗户属于哪个空间）、orientation（开在空间的哪条朝向外墙 south/north/east/west）、position（在墙上的位置 start/center/end，默认 center）、width/height（窗宽/高，米，必填）、sillHeight（窗台离地米，0=落地窗，默认 0.9）；没有写进清单的空间不开窗
- doors：门清单，connects（连接的两个空间 id，须相邻）、swing（left/right/none，默认 left）、leafCount（1/2，默认 1）、width（门宽米，必填）、height（门高米，必填）、position（在共享墙上的位置 start/center/end，默认 center）；封闭房间必须通过门连接到开放区，漏了门会不可达（程序不自动补门）
- 面积守恒（重要，写之前必须估算一遍）：所有房间 area.target 之和 + 走廊面积 ≤ 外轮廓面积${area ? ` ${area}㎡` : ''}（横向走廊面积 = 走廊宽 × 外轮廓宽，纵向 = 走廊宽 × 外轮廓高；建议再预留约 5% 给墙体）。若超预算，先缩小 target（不是 min），仍放不下则写入 unmetRequirements，不要硬塞出面积不足的布局
- 禁止写 boundary/顶点/环/墙/门窗/坐标——几何由服务端程序自动生成

路径：designs/${revisionId}/intent.json（相对 cwd）。校验失败会再给一次修正机会。`;
}
