import { CCViewerApp, GCanvasTexture, GSpriteMaterial, GTextSprite } from '@glodon/concetto-viewer';
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
  modelToLineGroups,
  modelToSpaceFills,
  modelToWallFills,
} from './modelRender';
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
    controls: { rotate: false, pan: true, zoom: true },
    helpers: { axes: false, grid: false, ground: false, sky: false },
    picking: false,
    effects: { edgeDetection: { enabled: false } },
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
    let added = false;
    if (content.kind === 'dxf') {
      const positions = entitiesToLinePositions(content.entities);
      if (positions.length) {
        viewer.addLines({ positions, material: { color: 0x4a4a4a } });
        added = true;
      }
    } else if (content.kind === 'model') {
      for (const fill of modelToSpaceFills(content.model)) {
        addSpaceFillMesh(viewer, fill, overlays);
        added = true;
      }
      for (const fill of modelToWallFills(content.model)) {
        addSpaceFillMesh(viewer, fill, overlays, { depthWrite: true });
        added = true;
      }
      for (const g of modelToLineGroups(content.model)) {
        viewer.addLines({ positions: g.positions, material: { color: g.color } });
        added = true;
      }
      addSpaceLabels(viewer, content.model, overlays);
    }
    if (added) viewer.fitBounds();
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
