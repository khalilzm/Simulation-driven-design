import type { CCViewerApp, Handle } from '@glodon/concetto-viewer';

/** viewport.space 上通过 addComponent 挂载、不受 viewer.clear() 管理的对象 */
export interface SpaceOverlayComponent {
  dispose?: () => void;
  userData?: { componentId?: string };
}

/** 追踪并清理 fill / 标签等 overlay，避免换方案后叠层 */
export class SpaceOverlayRegistry {
  private readonly items: SpaceOverlayComponent[] = [];
  private readonly meshHandles: Handle[] = [];

  add(viewer: CCViewerApp, component: SpaceOverlayComponent, componentId?: string): void {
    viewer.viewport.space.addComponent(component as never, componentId);
    this.items.push(component);
  }

  addMeshHandle(viewer: CCViewerApp, handle: Handle): void {
    this.meshHandles.push(handle);
  }

  clear(viewer: CCViewerApp): void {
    for (const handle of this.meshHandles) {
      viewer.remove(handle);
    }
    this.meshHandles.length = 0;
    const space = viewer.viewport.space;
    for (const component of this.items) {
      const id = component.userData?.componentId;
      if (id && space.componentMap.has(id)) {
        const registered = space.componentMap.get(id);
        if (registered) space.removeComponent(registered as never);
      }
      component.dispose?.();
    }
    this.items.length = 0;
  }
}
