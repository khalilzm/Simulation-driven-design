import type { CCViewerApp } from '@glodon/concetto-viewer';
import { DoubleSide } from 'three';
import type { PolygonFill } from './modelRender';
import type { SpaceOverlayRegistry } from './spaceOverlay';

export interface FillMeshOptions {
  depthWrite?: boolean;
  /** 用光照物理材质 GMeshMaterial（立体感），否则用无光照的 GMeshBasicMaterial */
  physical?: boolean;
}

/** 通过 CCViewerApp.addMesh 挂载，以便注册 GPU snap / 旋转枢轴捕捉 */
export function addSpaceFillMesh(
  viewer: CCViewerApp,
  fill: PolygonFill,
  overlays: SpaceOverlayRegistry,
  options: FillMeshOptions = {},
): void {
  const depthWrite = options.depthWrite ?? false;
  const physical = options.physical ?? false;
  const handle = viewer.addMesh({
    positions: fill.mesh.positions,
    indices: fill.mesh.indices,
    materialType: physical ? 'GMeshMaterial' : 'GMeshBasicMaterial',
    material: {
      color: fill.color,
      opacity: fill.opacity,
      transparent: fill.opacity < 1,
      depthWrite,
      depthTest: true,
      side: DoubleSide,
      ...(physical
        ? { roughness: 1.0, metalness: 0, flatShading: true }
        : {
            // 与图例 CSS 色一致，避免 tone mapping 把 #002cf3 等拉偏
            // toneMapped: false,
          }),
    },
  });
  overlays.addMeshHandle(viewer, handle);
}
