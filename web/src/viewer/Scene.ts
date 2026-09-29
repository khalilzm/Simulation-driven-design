import {
  CCViewerApp,
  GCanvasTexture,
  GSpriteMaterial,
  GTextSprite,
  ViewType,
} from '@glodon/concetto-viewer';
import {
  polygonBBoxMinExtent,
  polygonInteriorLabelPoint,
  resolveSpaceLabel,
  resolveSpaceStyle,
  type SpaceModel,
} from '@sdd/shared';
import type { ViewerContent } from '../types';
import { entitiesToLinePositions } from './dxf';
import {
  modelToDoorMeshes3D,
  modelToLineGroups,
  modelToSpaceFills,
  modelToWallBoxes3D,
  modelToWallFills,
  modelToWindowFills,
  modelToWindowMeshes3D,
} from './modelRender';
import { sunlightGridsToFills } from './sunlightMeshRender';
import { addSpaceFillMesh } from './spaceFillMesh';
import { SpaceOverlayRegistry } from './spaceOverlay';

const LABEL_HEIGHT_MIN = 0.28;
const LABEL_HEIGHT_MAX = 0.8;
const LABEL_HEIGHT_RATIO = 0.45;

function labelTargetHeight(boundary: [number, number][]): number {
  const extent = polygonBBoxMinExtent(boundary);
  if (extent <= 0) return LABEL_HEIGHT_MAX;
  return Math.max(LABEL_HEIGHT_MIN, Math.min(LABEL_HEIGHT_MAX, extent * LABEL_HEIGHT_RATIO));
}

export interface ViewerScene {
  setContent(content: ViewerContent): void;
  dispose(): void;
}

function applyLabelScale(sprite: GTextSprite, label: string, boundary: [number, number][]): void {
  const targetHeight = labelTargetHeight(boundary);
  const { width: texW, height: texH } = GCanvasTexture.measureCanvasDimensions([label], {
    fontSize: 24,
    tightCanvasBounds: true,
  });
  if (texW > 0 && texH > 0) {
    const aspect = texW / texH;
    sprite.scale.set(targetHeight * aspect, targetHeight, 1);
    return;
  }
  if (sprite.scale.y > 0) {
    sprite.scale.multiplyScalar(targetHeight / sprite.scale.y);
  } else {
    sprite.scale.set(targetHeight * 4, targetHeight, 1);
  }
}

function addSpaceLabels(
  viewer: CCViewerApp,
  model: SpaceModel,
  overlays: SpaceOverlayRegistry,
): void {
  model.spaces.forEach((s, i) => {
    const style = resolveSpaceStyle(s, model.spaceTypes, i);
    const label = resolveSpaceLabel(s, model.spaceTypes);
    if (!label) return;
    const [cx, cy] = polygonInteriorLabelPoint(s.boundary);
    const map = new GCanvasTexture(label, {
      fontSize: 24,
      fontColor: style.labelColor,
      tightCanvasBounds: true,
    });
    const sprite = new GTextSprite(
      new GSpriteMaterial({ map, depthTest: false, depthWrite: false }),
    );
    sprite.position.set(cx, cy, 0.25);
    sprite.center.set(0.5, 0.5);
    sprite.renderOrder = 100_000;
    applyLabelScale(sprite, label, s.boundary);
    overlays.add(viewer, sprite, `space-label-${s.id}`);
  });
}

export function createScene(container: HTMLDivElement): ViewerScene {
  const viewer = new CCViewerApp(container, {
    preset: 'cad',
    environment: { backgroundColor: '#F5F0E6' },
    camera: { fov: 60, near: 0.1 },
    lighting: { ambientIntensity: 0, sunIntensity: 1.2 * Math.PI, fillLightIntensity: 0, shadows: true },
    controls: { rotate: true, pan: true, zoom: true },
    helpers: { axes: false, grid: false, ground: true, sky: false },
    picking: true,
    effects: { edgeDetection: { enabled: false }, ssao: { enabled: true, radius: 2.0 } },
  });

  const overlays = new SpaceOverlayRegistry();

  let ro: ResizeObserver | null = null;
  if (typeof ResizeObserver !== 'undefined') {
    ro = new ResizeObserver(() => viewer.resize());
    ro.observe(container);
  }

  const setContent = (content: ViewerContent) => {
    viewer.clear();
    overlays.clear(viewer);
    const navigationMode =
      content.kind === 'model'
        ? content.view === '3d'
          ? ViewType.ThreeD
          : ViewType.TwoD
        : content.kind === 'dxf'
          ? ViewType.TwoD
          : null;
    let added = false;
    if (content.kind === 'dxf') {
      const positions = entitiesToLinePositions(content.entities);
      if (positions.length) {
        viewer.addLines({ positions, material: { color: 0x4a4a4a } });
        added = true;
      }
    } else if (content.kind === 'model') {
      const useSunlight = content.view === 'sunlight' && content.sunlight?.status === 'completed';
      const is3d = content.view === '3d';
      const sun = content.sunlight;
      const gridFills = useSunlight && sun?.grids?.length ? sunlightGridsToFills(sun) : [];
      const meshEdges3d = { meshEdges: true as const };
      if (is3d) {
        for (const fill of modelToSpaceFills(content.model)) {
          addSpaceFillMesh(viewer, fill, overlays, meshEdges3d);
          added = true;
        }
        for (const fill of modelToWallBoxes3D(content.model)) {
          addSpaceFillMesh(viewer, fill, overlays, { depthWrite: true, physical: true, ...meshEdges3d });
          added = true;
        }
        for (const fill of modelToDoorMeshes3D(content.model)) {
          addSpaceFillMesh(viewer, fill, overlays, { depthWrite: true, physical: true, ...meshEdges3d });
          added = true;
        }
        for (const fill of modelToWindowMeshes3D(content.model)) {
          addSpaceFillMesh(viewer, fill, overlays, { depthWrite: true, ...meshEdges3d });
          added = true;
        }
      } else if (useSunlight && gridFills.length) {
        for (const fill of gridFills) {
          addSpaceFillMesh(viewer, fill, overlays);
          added = true;
        }
      } else if (!useSunlight) {
        for (const fill of modelToSpaceFills(content.model)) {
          addSpaceFillMesh(viewer, fill, overlays);
          added = true;
        }
      }
      if (!useSunlight && !is3d) {
        for (const fill of modelToWallFills(content.model)) {
          addSpaceFillMesh(viewer, fill, overlays, { depthWrite: true });
          added = true;
        }
        for (const fill of modelToWindowFills(content.model)) {
          addSpaceFillMesh(viewer, fill, overlays, { depthWrite: true });
          added = true;
        }
        for (const g of modelToLineGroups(content.model)) {
          viewer.addLines({ positions: g.positions, material: { color: g.color } });
          added = true;
        }
        addSpaceLabels(viewer, content.model, overlays);
      }
    }
    if (added) viewer.fitBounds();
    if (navigationMode !== null) {
      viewer.navigation.setView(navigationMode);
      viewer.navigation.setControlMode(navigationMode);
      viewer.navigation.setControlRotate(navigationMode === ViewType.ThreeD);
    }
    viewer.setEdgeDetection({ enabled: false });
  };

  return {
    setContent,
    dispose() {
      overlays.clear(viewer);
      ro?.disconnect();
      viewer.dispose();
    },
  };
}
