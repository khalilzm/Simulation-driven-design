import {
  CCViewerApp,
  GCanvasTexture,
  GSpriteMaterial,
  GTextSprite,
  ViewType,
} from '@glodon/concetto-viewer';
import type { Handle } from '@glodon/concetto-viewer';
import { DoubleSide, Sphere, Vector3, Vector2, Plane, Raycaster } from 'three';
import {
  polygonBBoxMinExtent,
  pointInOrOnPolygon,
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
import { analysisLayerForView } from './analysisLayers';
import { trajectoryPositionAt } from './pedestrianTrajectories';
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

/** 2D 日照伪彩不应受 CSM/SSAO/地面影影响读数 */
function applyAnalysis2dPresentation(viewer: CCViewerApp, analysis2d: boolean): void {
  if (analysis2d) {
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
  pickSpace(clientX:number,clientY:number):string|null;
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
    environment: { backgroundColor: '#FFFFFF' },
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
  let framed = false;
  let disposed = false;
  let frameTimer = 0;
  let frameCamera = () => {};
  const revealFrame = () => {
    if (disposed) return;
    const rect = container.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) {
      scheduleFrame();
      return;
    }
    viewer.resize();
    frameCamera();
    framed = true;
    container.dataset.ready = 'true';
  };
  const scheduleFrame = () => {
    if (framed) {
      viewer.resize();
      return;
    }
    window.clearTimeout(frameTimer);
    frameTimer = window.setTimeout(revealFrame, 80);
  };
  if (typeof ResizeObserver !== 'undefined') {
    ro = new ResizeObserver(() => scheduleFrame());
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
      const layer = analysisLayerForView(content.view);
      const analysis = layer?.isCompleted(content) ? layer.geometry(content) : undefined;
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
      } else if (analysis) {
        for (const fill of analysis.fills) {
          addSpaceFillMesh(viewer, fill, overlays);
          added = true;
        }
        for (const group of analysis.lines) {
          viewer.addLines({ positions: group.positions, material: { color: group.color } });
          added = true;
        }
        if (analysis.playback) setupPedestrianDots(analysis.playback);
      } else {
        for (const fill of modelToSpaceFills(content.model)) {
          addSpaceFillMesh(viewer, fill, overlays);
          added = true;
        }
      }
      // A common floor/wall context gives both comparison panes the same initial framing.
      if (content.comparison && analysis) {
        for (const group of modelToLineGroups(content.model)) {
          viewer.addLines({ positions: group.positions, material: { color: group.color } });
          added = true;
        }
      }
      if (!analysis && !is3d) {
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
    }
    frameCamera = () => {
      if (navigationMode === ViewType.TwoD) alignPlan2dCamera(viewer);
      if (added) viewer.fitBounds();
    };
    if (framed) frameCamera();
    else scheduleFrame();
    // Keep the 3D view clean; model edges are already represented by the
    // generated wall geometry and the post-process outline is visually noisy.
    viewer.setEdgeDetection({ enabled: false });
    const pseudocolor2d = content.kind === 'model' && !!analysisLayerForView(content.view);
    applyAnalysis2dPresentation(viewer, pseudocolor2d);
  };

  const setPedestrianTime = (t: number) => {
    applyPedestrianTime(t);
  };

  return {
    setContent,
    setPedestrianTime,
    focusSpace,
    pickSpace(clientX,clientY) {
      if(!currentModel)return null;
      const rect=container.getBoundingClientRect(),ray=new Raycaster();
      if(!rect.width||!rect.height)return null;
      ray.setFromCamera(new Vector2((clientX-rect.left)/rect.width*2-1,1-(clientY-rect.top)/rect.height*2),viewer.navigation.camera);
      const point=ray.ray.intersectPlane(new Plane(new Vector3(0,0,1),0),new Vector3());
      if(!point)return null;
      return currentModel.spaces.find(s=>pointInOrOnPolygon([point.x,point.y],s.boundary))?.id??null;
    },
    dispose() {
      disposed = true;
      overlays.clear(viewer);
      window.clearTimeout(frameTimer);
      ro?.disconnect();
      viewer.dispose();
    },
  };
}
