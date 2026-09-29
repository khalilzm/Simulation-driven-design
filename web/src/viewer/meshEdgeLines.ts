import { BufferAttribute, BufferGeometry, EdgesGeometry } from 'three';
import type { IndexedPolygonMesh } from './polygonMesh';

/** 3D 网格轮廓线（略淡，避免压过填充色） */
export const MESH_EDGE_LINE_COLOR = 0xc4c4c4;

/**
 * 由三角网格生成 EdgesGeometry 线段顶点（每段边两个点，xyz 交错）。
 * thresholdAngle：共面三角共享边若夹角小于该值（度）则不画线。
 */
export function indexedMeshToEdgeLinePositions(
  mesh: IndexedPolygonMesh,
  thresholdAngle = 1,
): number[] {
  const { positions, indices } = mesh;
  if (positions.length < 9 || indices.length < 3) return [];

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setIndex(Array.from(indices));

  const edges = new EdgesGeometry(geometry, thresholdAngle);
  const attr = edges.getAttribute('position');
  const out: number[] = [];
  for (let i = 0; i < attr.count; i++) {
    out.push(attr.getX(i), attr.getY(i), attr.getZ(i));
  }

  edges.dispose();
  geometry.dispose();
  return out;
}
