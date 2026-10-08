import {
  CCViewerApp,
  GCanvasTexture,
  GSpriteMaterial,
  GTextSprite,
  ViewType,
} from '@glodon/concetto-viewer';
import type { Handle } from '@glodon/concetto-viewer';
import { DoubleSide, Sphere, Vector3 } from 'three';
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
import { pedestrianDensityToFills } from './pedestrianMeshRender';
import { trajectoriesToLineGroups, trajectoryPositionAt } from './pedestrianTrajectories';
import type { PedestrianResult, PedestrianTrajectory } from '@sdd/shared';
import { addSpaceFillMesh } from './spaceFillMesh';
import { SpaceOverlayRegistry } from './spaceOverlay';

const LABEL_HEIGHT_MIN = 0.28;
const LABEL_HEIGHT_MAX = 0.8;
const LABEL_HEIGHT_RATIO = 0.45;

const VIEWER_SSAO_DEFAULT = { enabled: true, radius: 2.0 };

/** concetto-viewer 为 Z-up；3D 旋转后切回 2D 时 setView 不会恢复 up，需先摆正再 fitBounds。 */
function alignPlan2dCamera(viewer: CCViewerApp): void {
  const bounds = viewer.bounds;
  if (bounds.isEmpty()) return;

  const center = bounds.getCenter(new Vector3());
  const sphere = bounds.getBoundingSphere(new Sphere());
  const dist = Math.max(sphere.radius * 3, 1);

  const { camera, control } = viewer.navigation;
  camera.up.set(0, 0, 1);
  control.target.copy(center);
  camera.position.set(center.x, center.y - 1e-6, center.z + dist);
  camera.lookAt(control.target);
  control.update();
}

/** 将 2D 正交相机对准一组平面点（用于定位到单个空间） */
function focusOnPoints(viewer: CCViewerApp, points: [number, number][]): void {
  if (!points.length) return;
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const extent = Math.max(maxX - minX, maxY - minY, 1);
  const dist = Math.max(extent * 1.6, 1);
  const { camera, control } = viewer.navigation;
  camera.up.set(0, 0, 1);
  control.target.set(cx, cy, 0);
  camera.position.set(cx, cy - 1e-6, dist);
  camera.lookAt(control.target);
  control.update();
}

/** 2D 日照伪彩不应受 CSM/SSAO/地面影影响读数 */
function applySunlight2dPresentation(viewer: CCViewerApp, sunlight2d: boolean): void {
  if (sunlight2d) {
    viewer.setEffect({ enabled: false });
    const keylight = viewer.viewport.keylight;
    keylight.castShadow = false;
    keylight.enableShadow(false);
    keylight.shadowIntensity = 0;
    viewer.viewport.groundPlane.visible = false;
    return;
  }
  viewer.setEffect(VIEWER_SSAO_DEFAULT);
  const keylight = viewer.viewport.keylight;
  keylight.castShadow = true;
  keylight.enableShadow(true);
  keylight.shadowIntensity = 1;
  viewer.viewport.groundPlane.visible = true;
}

function labelTargetHeight(boundary: [number, number][]): number {
  const extent = polygonBBoxMinExtent(boundary);
  if (extent <= 0) return LABEL_HEIGHT_MAX;
  return Math.max(LABEL_HEIGHT_MIN, Math.min(LABEL_HEIGHT_MAX, extent * LABEL_HEIGHT_RATIO));
}

export interface ViewerScene {
  setContent(content: ViewerContent): void;
  setPedestrianTime(t: number): void;
  focusSpace(spaceId: string | null): void;
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

const PED_DOT_Z = 0.12;
const PED_DOT_COLOR = 0xe91e63;

interface PedestrianDot {
  updatePosition(v: Vector3): void;
  setColor(c: number): void;
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

  let currentModel: SpaceModel | null = null;
  let highlightHandle: Handle | null = null;
  let highlightOutline: Handle | null = null;

  const clearHighlight = () => {
    if (highlightHandle) { viewer.remove(highlightHandle); highlightHandle = null; }
    if (highlightOutline) { viewer.remove(highlightOutline); highlightOutline = null; }
  };

  const focusSpace = (spaceId: string | null) => {
    clearHighlight();
    if (!spaceId || !currentModel) return;
    const space = currentModel.spaces.find((s) => s.id === spaceId);
    if (!space) return;
    const fill = modelToSpaceFills(currentModel).find((f) => f.spaceId === spaceId);
    if (fill) {
      highlightHandle = viewer.addMesh({
        positions: fill.mesh.positions,
        indices: fill.mesh.indices,
        materialType: 'GMeshBasicMaterial',
        material: { color: 0xff8a3d, opacity: 0.42, transparent: true, depthWrite: false, depthTest: false, side: DoubleSide },
      });
    }
    const positions: number[] = [];
    const ring = space.boundary;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length];
      positions.push(a[0], a[1], 0.15, b[0], b[1], 0.15);
    }
    highlightOutline = viewer.addLines({ positions, material: { color: 0xff6a00 } });
    focusOnPoints(viewer, space.boundary);
  };

  let pedAnim: { trajs: PedestrianTrajectory[]; dots: PedestrianDot[]; handle: Handle } | null = null;

  const disposePedestrian = () => {
    if (pedAnim) {
      viewer.remove(pedAnim.handle);
      pedAnim = null;
    }
  };

  const setupPedestrianDots = (ped: PedestrianResult) => {
    const trajs = ped.trajectories ?? [];
    if (!trajs.length) {
      pedAnim = null;
      return;
    }
    const positions: number[] = [];
    for (const traj of trajs) {
      const p = traj.points[0] ?? [0, 0];
      positions.push(p[0], p[1], PED_DOT_Z);
    }
    const handle = viewer.addPoint({ positions, size: 10 });
    const comp = handle.component;
    const dots = (Array.isArray(comp) ? comp : [comp]) as unknown as PedestrianDot[];
    dots[0]?.setColor(PED_DOT_COLOR);
    pedAnim = { trajs, dots, handle };
  };

  const applyPedestrianTime = (t: number) => {
    if (!pedAnim) return;
    const { dots, trajs } = pedAnim;
    for (let i = 0; i < dots.length && i < trajs.length; i++) {
      const [x, y] = trajectoryPositionAt(trajs[i], t);
      dots[i].updatePosition(new Vector3(x, y, PED_DOT_Z));
    }
    viewer.update();
  };

  let ro: ResizeObserver | null = null;
  if (typeof ResizeObserver !== 'undefined') {
    ro = new ResizeObserver(() => viewer.resize());
    ro.observe(container);
  }

  const setContent = (content: ViewerContent) => {
    disposePedestrian();
    clearHighlight();
    viewer.clear();
    overlays.clear(viewer);
    currentModel = content.kind === 'model' ? content.model : null;
    const is3d = content.kind === 'model' && content.view === '3d';
    const navigationMode =
      content.kind === 'model'
        ? is3d
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
      const usePedestrian = content.view === 'pedestrian' && content.pedestrian?.status === 'completed';
      const sun = content.sunlight;
      const ped = content.pedestrian;
      const gridFills = useSunlight && sun?.grids?.length ? sunlightGridsToFills(sun, content.comparison?.sunlightScale) : [];
      const pedFills = usePedestrian && ped?.densityGrid ? pedestrianDensityToFills(ped, content.comparison?.densityScale) : [];
      if (is3d) {
        for (const fill of modelToSpaceFills(content.model)) {
          addSpaceFillMesh(viewer, fill, overlays);
          added = true;
        }
        for (const fill of modelToWallBoxes3D(content.model)) {
          addSpaceFillMesh(viewer, fill, overlays, { depthWrite: true, physical: true });
          added = true;
        }
        for (const fill of modelToDoorMeshes3D(content.model)) {
          addSpaceFillMesh(viewer, fill, overlays, { depthWrite: true, physical: true });
          added = true;
        }
        for (const fill of modelToWindowMeshes3D(content.model)) {
          addSpaceFillMesh(viewer, fill, overlays, { depthWrite: true });
          added = true;
        }
      } else if (useSunlight && gridFills.length) {
        for (const fill of gridFills) {
          addSpaceFillMesh(viewer, fill, overlays);
          added = true;
        }
      } else if (usePedestrian) {
        for (const fill of pedFills) {
          addSpaceFillMesh(viewer, fill, overlays);
          added = true;
        }
        for (const group of trajectoriesToLineGroups(ped!, content.comparison?.pedestrianTimeMax)) {
          viewer.addLines({ positions: group.positions, material: { color: group.color } });
          added = true;
        }
        setupPedestrianDots(ped!);
      } else if (!useSunlight) {
        for (const fill of modelToSpaceFills(content.model)) {
          addSpaceFillMesh(viewer, fill, overlays);
          added = true;
        }
      }
      // A common floor/wall context gives both comparison panes the same initial framing.
      if (content.comparison && (useSunlight || usePedestrian)) {
        for (const group of modelToLineGroups(content.model)) {
          viewer.addLines({ positions: group.positions, material: { color: group.color } });
          added = true;
        }
      }
      if (!useSunlight && !usePedestrian && !is3d) {
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
    if (navigationMode !== null) {
      viewer.navigation.setView(navigationMode);
      viewer.navigation.setControlMode(navigationMode);
      viewer.navigation.setControlRotate(navigationMode === ViewType.ThreeD);
      if (navigationMode === ViewType.TwoD) alignPlan2dCamera(viewer);
    }
    if (added) viewer.fitBounds();
    viewer.setEdgeDetection({ enabled: is3d });
    const pseudocolor2d = content.kind === 'model' && (content.view === 'sunlight' || content.view === 'pedestrian');
    applySunlight2dPresentation(viewer, pseudocolor2d);
  };

  const setPedestrianTime = (t: number) => {
    applyPedestrianTime(t);
  };

  return {
    setContent,
    setPedestrianTime,
    focusSpace,
    dispose() {
      overlays.clear(viewer);
      ro?.disconnect();
      viewer.dispose();
    },
  };
}
