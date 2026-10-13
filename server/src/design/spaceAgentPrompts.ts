import type { OutlineContext } from '../spacePrompt';
import { closePolygon, outlineBBox } from '../geometry/polygon';

/** intent.json 的 JSON 示例（有/无固定轮廓两种首轮共用）。 */
const INTENT_EXAMPLE = `{
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
}`;

/** intent 字段的严格校验清单（有/无固定轮廓两种首轮共用）。 */
const INTENT_STRICT_RULES = `严格校验要求（写之前逐条核对，避免重试）：
- rooms 非空，每个 id 是字母开头的英文标识、全局唯一，不能是 outside；usage 必填
- area.min / area.target 是非负数字，且 min ≤ target
- orientation 只能取 south/north/east/west 等枚举；privacy 只能取 public/semi-private/private
- adjacencies 的 a、b 都必须是已声明的房间 id，且 a ≠ b；relation 取 adjacent/near/separated
- doors 的 connects 必须是两个已声明的空间 id（房间或走廊）且不同；width/height 必填正数
- windows 的 spaceId 必须是已声明的空间 id；width/height 必填正数
- 至少 1 个 privacy:"public" 的房间作为开放交通区（如客厅/门厅）；封闭房间必须通过门连接到开放区，否则不可达
- 禁止写 boundary/顶点/环/墙/门窗坐标——几何由服务端程序自动生成`;

/** 有固定轮廓（program outline / 修正轮）时：写 intent.json，房间面积须贴合固定轮廓。 */
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

${INTENT_EXAMPLE}

${INTENT_STRICT_RULES}
- 面积守恒（重要，写之前先估算）：所有房间 area.target 之和 + 走廊面积应 ≈ 外轮廓面积${area ? ` ${area}㎡` : ''}（横向走廊 = 走廊宽 × 外轮廓宽，纵向 = 走廊宽 × 外轮廓高；建议再留约 5% 给墙体）。若超预算，先缩小 target（不是 min），仍放不下则写入 unmetRequirements

路径：designs/${revisionId}/intent.json（相对 cwd）。校验失败会再给一次修正机会。`;
}

/** 无固定轮廓（纯自然语言首轮）时：写 intent.json，外轮廓由程序根据房间面积反推。 */
export function buildIntentOnlyPrompt(revisionId: string, ctx: OutlineContext): string {
  const sketchNote = ctx.inputHints
    ? `用户已上传草图（${ctx.inputHints}）。请用 Read 工具查看草图，结合自然语言判断房间划分与邻接；草图只作参考，不是精确 CAD。`
    : '无草图；按自然语言推断房间。';
  return `你是户型设计助手。本回合只写**设计意图文件**（外轮廓由程序自动确定，你不需要写轮廓）。

${sketchNote}

在本会话 cwd 写入 **designs/${revisionId}/intent.json**（schemaVersion 1，不含任何坐标/几何）：
${INTENT_EXAMPLE}

${INTENT_STRICT_RULES}
- 房间面积按功能写合理值即可（程序会按比例放大填满外轮廓，不需要你精确铺满，但不要写明显离谱的超大面积）

路径：designs/${revisionId}/intent.json（相对 cwd）。写完用一句话说明房间与面积假设。校验失败会再给一次修正机会。`;
}
