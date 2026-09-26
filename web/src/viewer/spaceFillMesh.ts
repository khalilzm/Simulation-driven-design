import type { CCViewerApp } from '@glodon/concetto-viewer';
import { GMesh, GMeshBasicMaterial } from '@glodon/concetto-viewer';
import { BufferGeometry, DoubleSide, Float32BufferAttribute, Uint32BufferAttribute } from 'three';
import type { PolygonFill } from './modelRender';
import type { SpaceOverlayRegistry } from './spaceOverlay';

export interface FillMeshOptions {
  depthWrite?: boolean;
}

/** 将 earcut 剖分结果构造成 GMesh 并加入场景 */
export function addSpaceFillMesh(
  viewer: CCViewerApp,
  fill: PolygonFill,
  overlays: SpaceOverlayRegistry,
  options: FillMeshOptions = {},
): GMesh {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(fill.mesh.positions, 3));
  geometry.setIndex(new Uint32BufferAttribute(fill.mesh.indices, 1));
  geometry.computeVertexNormals();

  const depthWrite = options.depthWrite ?? false;
  const material = new GMeshBasicMaterial({
    color: fill.color,
    opacity: fill.opacity,
    transparent: fill.opacity < 1,
    depthWrite,
    depthTest: true,
    side: DoubleSide,
    // 与图例 CSS 色一致，避免 tone mapping 把 #002cf3 等拉偏
    toneMapped: false,
  });

  const mesh = new GMesh(geometry, material);
  const componentId =
    fill.meshId ?? (fill.spaceId ? `space-fill-${fill.spaceId}` : undefined);
  overlays.add(viewer, mesh, componentId);
  return mesh;
}
