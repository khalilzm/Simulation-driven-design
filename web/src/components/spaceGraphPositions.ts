import type { NodeChange } from '@xyflow/react';
export const GRAPH_WIDTH=1000;
export const GRAPH_HEIGHT=700;
/** Persist release/keyboard positions only; intermediate drag frames belong to React Flow. */
export function committedGraphPositions(changes:NodeChange[],roomIds:ReadonlySet<string>) {
  return changes.flatMap(change=>change.type==='position'&&change.position&&change.dragging!==true&&roomIds.has(change.id)?[{id:change.id,x:change.position.x/GRAPH_WIDTH,y:change.position.y/GRAPH_HEIGHT}]:[]);
}
